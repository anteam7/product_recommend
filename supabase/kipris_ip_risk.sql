-- ────────────────────────────────────────────────────────────
-- KIPRIS IP 리스크 게이트 — Pre-Listing IP Block Watch
-- ────────────────────────────────────────────────────────────
-- 사용처:
--   1) scripts/kipris-ip-risk-scan.mjs (야간 배치) — 핀/추천 후보의
--      canonical_name·brand·핵심 modifier 토큰을 KIPRIS Open API 로 조회,
--      활성 상표(거절·소멸 제외) 적중·출원인·만료일·심판이력을 점수화.
--   2) /admin/trend-radar/ip-risk (보드) — 키워드별 IP 위험도 가시화.
--   3) /admin/trend-radar/recommend, /pins — 카드에 safe/caution/block 배지.
-- ────────────────────────────────────────────────────────────

-- 1) IP 리스크 점수 테이블 (keyword × ip_class 단위)
CREATE TABLE IF NOT EXISTS jimscanner_ip_risk (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 조회 단위
  keyword text NOT NULL,                -- canonical_name 또는 brand+modifier 결합 토큰
  keyword_kind text NOT NULL,           -- 'canonical' | 'brand' | 'modifier' | 'brand_modifier'
  ip_class text NOT NULL DEFAULT 'all', -- 지정상품류 (예: '03','05','29','30') · 'all' 통합

  -- 점수 (0.0 ~ 1.0)
  risk_score real NOT NULL DEFAULT 0,
  risk_grade text NOT NULL DEFAULT 'safe', -- 'safe' | 'caution' | 'block'

  -- 매칭 통계
  active_marks int NOT NULL DEFAULT 0,    -- 활성 상표 수 (등록·출원중)
  dead_marks int NOT NULL DEFAULT 0,      -- 거절·소멸 (점수 제외)
  exact_hit boolean NOT NULL DEFAULT false, -- 정확일치(공백·대소문자 제외)
  class_47_hit boolean NOT NULL DEFAULT false, -- 47류 지정상품 적중 (현 기준)

  -- 출원인 위험
  pb_coupang_hit boolean NOT NULL DEFAULT false, -- 쿠팡 PB(스타트앤로지 등) 보유
  celeb_hit boolean NOT NULL DEFAULT false,      -- 셀럽·연예인 보유 (메가브랜드)
  bigcorp_hit boolean NOT NULL DEFAULT false,    -- 대기업 보유 (LG·삼성·CJ·아모레…)

  -- 분쟁이력
  opposition_count int NOT NULL DEFAULT 0,  -- 이의신청
  trial_count int NOT NULL DEFAULT 0,       -- 심판 (무효·취소·권리범위확인)

  -- 적중 상표/출원인 (UI 노출용)
  top_mark_name text,
  top_mark_applicant text,
  top_mark_app_no text,         -- 출원번호 (예: '4020230012345')
  top_mark_reg_no text,         -- 등록번호
  top_mark_status text,         -- '등록' | '출원' | '거절' | '소멸'
  top_mark_app_date date,
  top_mark_expire_date date,

  -- 대체어 후보 (LLM/룰 기반 모방형 한글/영문 변형)
  alt_terms text[] NOT NULL DEFAULT ARRAY[]::text[],

  -- 원본 보존
  raw_payload jsonb,

  scanned_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT jimscanner_ip_risk_unique UNIQUE (keyword, keyword_kind, ip_class)
);

CREATE INDEX IF NOT EXISTS jimscanner_ip_risk_keyword
  ON jimscanner_ip_risk (keyword);
CREATE INDEX IF NOT EXISTS jimscanner_ip_risk_grade
  ON jimscanner_ip_risk (risk_grade, scanned_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_ip_risk_scanned
  ON jimscanner_ip_risk (scanned_at DESC);

ALTER TABLE jimscanner_ip_risk ENABLE ROW LEVEL SECURITY;
-- service-role only

-- updated_at trigger
CREATE OR REPLACE FUNCTION jimscanner_ip_risk_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_ip_risk_updated_at ON jimscanner_ip_risk;
CREATE TRIGGER jimscanner_ip_risk_updated_at
  BEFORE UPDATE ON jimscanner_ip_risk
  FOR EACH ROW EXECUTE FUNCTION jimscanner_ip_risk_set_updated_at();


-- 2) 스캔 감사 로그
CREATE TABLE IF NOT EXISTS jimscanner_ip_risk_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  scanned_keywords int NOT NULL DEFAULT 0,
  blocked_count int NOT NULL DEFAULT 0,
  caution_count int NOT NULL DEFAULT 0,
  safe_count int NOT NULL DEFAULT 0,
  error_count int NOT NULL DEFAULT 0,
  note text
);

ALTER TABLE jimscanner_ip_risk_runs ENABLE ROW LEVEL SECURITY;


-- 3) ggsan recommend RPC 갱신 — ip_block_only 옵션 + 키워드 단위 LEFT JOIN
--    기존 시그니처 외에 ip_block_only 인자 추가 (default false).
--    매칭된 tv_top_keyword / search_top_keyword 의 risk_grade 를 표면화.
CREATE OR REPLACE FUNCTION jimscanner_ggsan_recommend(
  days_window int DEFAULT 30,
  min_sim float DEFAULT 0.20,
  min_score float DEFAULT 0.5,
  result_limit int DEFAULT 100,
  ip_block_only boolean DEFAULT false
)
RETURNS TABLE (
  goods_no text,
  title text,
  cate_cd text,
  cate_label text,
  price_krw int,
  is_imminent boolean,
  image_url text,
  detail_url text,
  ggsan_last_seen timestamptz,
  tv_score real,
  search_score real,
  raw_score real,
  imminent_bonus real,
  final_score real,
  tv_match_count int,
  tv_top_keyword text,
  tv_total_pushes int,
  search_match_count int,
  search_top_keyword text,
  search_sources text[],
  ip_grade text,
  ip_score real,
  ip_top_mark text,
  ip_top_applicant text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  tv_keywords AS (
    SELECT keyword, COUNT(*)::int AS tv_count
    FROM jimscanner_trends_keywords
    WHERE source = 'naver_tvtime'
      AND collected_at > now() - (days_window || ' days')::interval
    GROUP BY keyword
  ),
  tv_matches AS (
    SELECT
      gp.goods_no,
      tv.keyword AS tv_keyword,
      tv.tv_count,
      similarity(tv.keyword, gp.title) AS sim,
      tv.tv_count::real * similarity(tv.keyword, gp.title) AS strength
    FROM tv_keywords tv
    CROSS JOIN LATERAL (
      SELECT g.goods_no, g.title
      FROM jimscanner_ggsan_products g
      WHERE g.title % tv.keyword
      ORDER BY similarity(tv.keyword, g.title) DESC
      LIMIT 5
    ) gp
    WHERE similarity(tv.keyword, gp.title) >= min_sim
  ),
  tv_agg AS (
    SELECT
      goods_no,
      SUM(strength)::real AS tv_score,
      COUNT(DISTINCT tv_keyword)::int AS tv_match_count,
      SUM(tv_count)::int AS tv_total_pushes,
      (ARRAY_AGG(tv_keyword ORDER BY strength DESC))[1] AS tv_top_keyword
    FROM tv_matches
    GROUP BY goods_no
  ),
  search_keywords AS (
    SELECT
      keyword,
      source,
      COUNT(*)::int AS occurrences
    FROM jimscanner_trends_keywords
    WHERE source IN (
      'naver_shopping_hot',
      'naver_search_trend',
      'aliex_best',
      'musinsa_best'
    )
      AND collected_at > now() - (days_window || ' days')::interval
    GROUP BY keyword, source
  ),
  search_matches AS (
    SELECT
      gp.goods_no,
      sk.keyword AS search_keyword,
      sk.source,
      sk.occurrences,
      similarity(sk.keyword, gp.title) AS sim,
      sk.occurrences::real * similarity(sk.keyword, gp.title) AS strength
    FROM search_keywords sk
    CROSS JOIN LATERAL (
      SELECT g.goods_no, g.title
      FROM jimscanner_ggsan_products g
      WHERE g.title % sk.keyword
      ORDER BY similarity(sk.keyword, g.title) DESC
      LIMIT 5
    ) gp
    WHERE similarity(sk.keyword, gp.title) >= min_sim
  ),
  search_agg AS (
    SELECT
      goods_no,
      SUM(strength)::real AS search_score,
      COUNT(DISTINCT search_keyword)::int AS search_match_count,
      (ARRAY_AGG(search_keyword ORDER BY strength DESC))[1] AS search_top_keyword,
      ARRAY_AGG(DISTINCT source) AS search_sources
    FROM search_matches
    GROUP BY goods_no
  ),
  scored AS (
    SELECT
      gp.goods_no, gp.title, gp.cate_cd, gp.cate_label, gp.price_krw,
      gp.is_imminent, gp.image_url, gp.detail_url, gp.last_seen_at,
      COALESCE(tv.tv_score, 0)::real AS tv_score,
      COALESCE(s.search_score, 0)::real AS search_score,
      COALESCE(tv.tv_match_count, 0) AS tv_match_count,
      COALESCE(tv.tv_top_keyword, '') AS tv_top_keyword,
      COALESCE(tv.tv_total_pushes, 0) AS tv_total_pushes,
      COALESCE(s.search_match_count, 0) AS search_match_count,
      COALESCE(s.search_top_keyword, '') AS search_top_keyword,
      COALESCE(s.search_sources, ARRAY[]::text[]) AS search_sources
    FROM jimscanner_ggsan_products gp
    LEFT JOIN tv_agg tv ON tv.goods_no = gp.goods_no
    LEFT JOIN search_agg s ON s.goods_no = gp.goods_no
    WHERE tv.tv_score IS NOT NULL OR s.search_score IS NOT NULL
  ),
  -- IP 매핑: top tv/search keyword 와 ggsan 브랜드 모두에 대한 가장 위험한 risk row 1개씩.
  ip_lookup AS (
    SELECT
      sc.goods_no,
      (
        SELECT row_to_json(r)
        FROM (
          SELECT risk_score, risk_grade, top_mark_name, top_mark_applicant
          FROM jimscanner_ip_risk
          WHERE keyword IN (sc.tv_top_keyword, sc.search_top_keyword)
            AND ip_class IN ('all','05','29','30','03')
          ORDER BY risk_score DESC, scanned_at DESC
          LIMIT 1
        ) r
      ) AS ip_row
    FROM scored sc
  )
  SELECT
    s.goods_no,
    s.title,
    s.cate_cd,
    s.cate_label,
    s.price_krw,
    s.is_imminent,
    s.image_url,
    s.detail_url,
    s.last_seen_at AS ggsan_last_seen,
    s.tv_score,
    s.search_score,
    (s.tv_score * 1.5 + s.search_score * 1.0)::real AS raw_score,
    (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)::real AS imminent_bonus,
    ((s.tv_score * 1.5 + s.search_score * 1.0)
       * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END))::real AS final_score,
    s.tv_match_count,
    s.tv_top_keyword,
    s.tv_total_pushes,
    s.search_match_count,
    s.search_top_keyword,
    s.search_sources,
    COALESCE((il.ip_row->>'risk_grade')::text, 'unknown') AS ip_grade,
    COALESCE((il.ip_row->>'risk_score')::real, 0)::real AS ip_score,
    (il.ip_row->>'top_mark_name')::text AS ip_top_mark,
    (il.ip_row->>'top_mark_applicant')::text AS ip_top_applicant
  FROM scored s
  LEFT JOIN ip_lookup il ON il.goods_no = s.goods_no
  WHERE ((s.tv_score * 1.5 + s.search_score * 1.0)
           * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)) >= min_score
    AND (
      ip_block_only = false
      OR COALESCE((il.ip_row->>'risk_grade')::text, 'unknown') <> 'block'
    )
  ORDER BY
    (CASE WHEN s.is_imminent THEN 1 ELSE 0 END) DESC,
    ((s.tv_score * 1.5 + s.search_score * 1.0)
       * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)) DESC
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_ggsan_recommend(int, float, float, int, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_ggsan_recommend(int, float, float, int, boolean) TO service_role;
