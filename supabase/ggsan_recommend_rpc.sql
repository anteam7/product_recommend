-- ────────────────────────────────────────────────────────────
-- ggsan 위탁 후보 추천 RPC (V0, 2026-05-11)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/recommend
-- 입력 신호:
--   1) TV 편성 (jimscanner_trends_keywords, source='naver_tvtime')
--   2) 검색·쇼핑 (source IN naver_shopping_hot, naver_search_trend, aliex_best, musinsa_best)
--   3) 임박특가 플래그 (jimscanner_ggsan_products.is_imminent)
-- 출력: ggsan 상품 단위, 각 점수와 매칭 근거 펼침
-- V1 보강 예정: 스마트스토어 등록상품수(saturation_penalty), 커뮤니티 시그널, 가격 인하 추세
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_ggsan_recommend(
  days_window int DEFAULT 30,
  min_sim float DEFAULT 0.20,
  min_score float DEFAULT 0.5,
  result_limit int DEFAULT 100
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
  -- 점수 분해
  tv_score real,
  search_score real,
  raw_score real,
  imminent_bonus real,
  decision_penalty real,
  final_score real,
  -- 매칭 근거
  tv_match_count int,
  tv_top_keyword text,
  tv_total_pushes int,
  search_match_count int,
  search_top_keyword text,
  search_sources text[],
  -- 기각사유 학습 신호
  rejected_siblings int,
  top_reject_reason text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  -- 1) TV 편성 키워드 (30일 누적, source=naver_tvtime)
  tv_keywords AS (
    SELECT keyword, COUNT(*)::int AS tv_count
    FROM jimscanner_trends_keywords
    WHERE source = 'naver_tvtime'
      AND collected_at > now() - (days_window || ' days')::interval
    GROUP BY keyword
  ),
  -- 2) TV ↔ ggsan trigram 매칭 (ggsan title gin_trgm 인덱스 활용)
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

  -- 3) 검색·쇼핑 키워드 (수요 측 시그널)
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
  -- 4) 검색 ↔ ggsan trigram 매칭
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

  -- 4.5) 운영자 기각사유 학습 신호
  --   active_decisions: 현재 유효한 결정 (스누즈는 만료 전만)
  active_decisions AS (
    SELECT goods_no, cate_cd, decision, reason_code, expires_at
    FROM jimscanner_trends_decisions
    WHERE decision IN ('rejected', 'snoozed')
      AND (decision <> 'snoozed' OR expires_at IS NULL OR expires_at > now())
  ),
  --   숨길 goods_no (rejected = 영구, snoozed = 만료 전)
  hidden_goods AS (
    SELECT goods_no FROM active_decisions
  ),
  --   카테고리별 기각 누적 (같은 cate_cd 신규 후보에 패널티 가산)
  reject_by_cate AS (
    SELECT
      cate_cd,
      COUNT(*)::int AS reject_count,
      (ARRAY_AGG(reason_code ORDER BY expires_at NULLS FIRST))[1] AS top_reason
    FROM active_decisions
    WHERE decision = 'rejected' AND cate_cd IS NOT NULL
    GROUP BY cate_cd
  ),

  -- 5) ggsan 상품에 점수 매핑 (시그널 1개 이상 있는 것만)
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
      COALESCE(s.search_sources, ARRAY[]::text[]) AS search_sources,
      COALESCE(rc.reject_count, 0) AS rejected_siblings,
      COALESCE(rc.top_reason, '') AS top_reject_reason,
      -- 같은 카테고리 기각 누적 → 점수 하향 (decay, 0.55 까지 바닥)
      GREATEST(0.55, 1.0 / (1.0 + 0.15 * COALESCE(rc.reject_count, 0)))::real AS decision_penalty
    FROM jimscanner_ggsan_products gp
    LEFT JOIN tv_agg tv ON tv.goods_no = gp.goods_no
    LEFT JOIN search_agg s ON s.goods_no = gp.goods_no
    LEFT JOIN reject_by_cate rc ON rc.cate_cd = gp.cate_cd
    WHERE (tv.tv_score IS NOT NULL OR s.search_score IS NOT NULL)
      -- 운영자가 기각/스누즈한 후보는 큐에서 숨김
      AND gp.goods_no NOT IN (SELECT goods_no FROM hidden_goods)
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
    s.decision_penalty,
    ((s.tv_score * 1.5 + s.search_score * 1.0)
       * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)
       * s.decision_penalty)::real AS final_score,
    s.tv_match_count,
    s.tv_top_keyword,
    s.tv_total_pushes,
    s.search_match_count,
    s.search_top_keyword,
    s.search_sources,
    s.rejected_siblings,
    s.top_reject_reason
  FROM scored s
  WHERE ((s.tv_score * 1.5 + s.search_score * 1.0)
           * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)
           * s.decision_penalty) >= min_score
  ORDER BY
    -- 임박특가 우선
    (CASE WHEN s.is_imminent THEN 1 ELSE 0 END) DESC,
    -- final_score (기각사유 패널티 반영)
    ((s.tv_score * 1.5 + s.search_score * 1.0)
       * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)
       * s.decision_penalty) DESC
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출
REVOKE ALL ON FUNCTION jimscanner_ggsan_recommend(int, float, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_ggsan_recommend(int, float, float, int) TO service_role;
