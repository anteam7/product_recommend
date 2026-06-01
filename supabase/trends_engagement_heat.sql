-- ────────────────────────────────────────────────────────────
-- 커뮤니티 화제 열량(Engagement Heat) 가중 — 2026-06-01
-- ────────────────────────────────────────────────────────────
-- 문제: jimscanner_ggsan_recommend 의 TV·검색 시그널이 'COUNT(*) = 언급 1건당 가중치 1'
--       로만 집계돼, 댓글 0개 단발 글 10건의 얕은 메아리와 댓글 500개 단일 토론의
--       깊은 수요가 동일 가중치로 합산된다.
-- 해결: 글당 조회/댓글/추천/랭킹을 metadata jsonb 에 담고, 집계를
--       COUNT(*) → Σ jimscanner_heat_weight(metadata) '열량 가중합' 으로 교체.
--       strength = heat * similarity 로 보정.
--
-- TS 동일 공식: src/lib/trends/heat.ts (computeHeatWeight). 두 구현 동기화 유지.
-- ────────────────────────────────────────────────────────────

-- 1) 엔게이지먼트 metadata 컬럼 (소스 파서가 채움; 미수집 소스는 '{}' → 가중치 1.0)
ALTER TABLE jimscanner_trends_keywords
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 2) 열량 가중치 함수
--    heat = 1 + ln(1 + views + 8·comments + 20·recommends + 30/rank)
--    엔게이지먼트가 전혀 없으면 1.0 (= 기존 빈도 1건과 동치).
CREATE OR REPLACE FUNCTION jimscanner_heat_weight(meta jsonb)
RETURNS real
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN meta IS NULL THEN 1.0::real
    ELSE (
      WITH e AS (
        SELECT
          GREATEST(COALESCE((meta->>'views')::numeric, 0), 0)      AS views,
          GREATEST(COALESCE((meta->>'comments')::numeric, 0), 0)   AS comments,
          GREATEST(COALESCE((meta->>'recommends')::numeric, 0), 0) AS recommends,
          GREATEST(COALESCE((meta->>'rank')::numeric, 0), 0)       AS rnk
      )
      SELECT CASE
        WHEN (views + 8*comments + 20*recommends + CASE WHEN rnk > 0 THEN 30/rnk ELSE 0 END) <= 0
          THEN 1.0::real
        ELSE (1 + ln(1 + views + 8*comments + 20*recommends
                       + CASE WHEN rnk > 0 THEN 30/rnk ELSE 0 END))::real
      END
      FROM e
    )
  END;
$$;

-- ────────────────────────────────────────────────────────────
-- 3) RPC 교체 — COUNT(*) → Σ heat_weight, 단순 빈도(occurrences)는 2축 비교용 병행 노출
-- ────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS jimscanner_ggsan_recommend(int, float, float, int);

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
  final_score real,
  -- 열량 vs 빈도 2축 (도달 깊이)
  freq_score real,            -- 옛 COUNT 기반 점수 (얕은 메아리 포함)
  heat_weighted_score real,   -- 열량 가중 최종 점수
  heat_depth real,            -- heat_weighted_score / NULLIF(freq_score,0)
  -- 매칭 근거
  tv_match_count int,
  tv_top_keyword text,
  tv_total_pushes int,
  search_match_count int,
  search_top_keyword text,
  search_sources text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  -- 1) TV 편성 키워드 — 빈도(COUNT) + 열량(Σ heat_weight) 병행
  tv_keywords AS (
    SELECT
      keyword,
      COUNT(*)::int AS tv_count,
      SUM(jimscanner_heat_weight(metadata))::real AS tv_heat
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
      -- strength: 열량 가중 × 유사도
      tv.tv_heat * similarity(tv.keyword, gp.title) AS strength,
      tv.tv_count::real * similarity(tv.keyword, gp.title) AS freq_strength
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
      SUM(freq_strength)::real AS tv_freq_score,
      COUNT(DISTINCT tv_keyword)::int AS tv_match_count,
      SUM(tv_count)::int AS tv_total_pushes,
      (ARRAY_AGG(tv_keyword ORDER BY strength DESC))[1] AS tv_top_keyword
    FROM tv_matches
    GROUP BY goods_no
  ),

  -- 2) 검색·쇼핑·커뮤니티 키워드 (수요 측 시그널)
  search_keywords AS (
    SELECT
      keyword,
      source,
      COUNT(*)::int AS occurrences,
      SUM(jimscanner_heat_weight(metadata))::real AS heat
    FROM jimscanner_trends_keywords
    WHERE source IN (
      'naver_shopping_hot',
      'naver_search_trend',
      'aliex_best',
      'musinsa_best',
      -- 커뮤니티/뉴스 열량 소스
      'ppomppu',
      'dcinside',
      '82cook',
      'natepan',
      'daum_news'
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
      sk.heat * similarity(sk.keyword, gp.title) AS strength,
      sk.occurrences::real * similarity(sk.keyword, gp.title) AS freq_strength
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
      SUM(freq_strength)::real AS search_freq_score,
      COUNT(DISTINCT search_keyword)::int AS search_match_count,
      (ARRAY_AGG(search_keyword ORDER BY strength DESC))[1] AS search_top_keyword,
      ARRAY_AGG(DISTINCT source) AS search_sources
    FROM search_matches
    GROUP BY goods_no
  ),

  -- 3) ggsan 상품에 점수 매핑
  scored AS (
    SELECT
      gp.goods_no, gp.title, gp.cate_cd, gp.cate_label, gp.price_krw,
      gp.is_imminent, gp.image_url, gp.detail_url, gp.last_seen_at,
      COALESCE(tv.tv_score, 0)::real AS tv_score,
      COALESCE(s.search_score, 0)::real AS search_score,
      COALESCE(tv.tv_freq_score, 0)::real AS tv_freq_score,
      COALESCE(s.search_freq_score, 0)::real AS search_freq_score,
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
    -- 2축 비교: 옛 빈도 점수 vs 열량 가중 점수
    ((s.tv_freq_score * 1.5 + s.search_freq_score * 1.0)
       * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END))::real AS freq_score,
    ((s.tv_score * 1.5 + s.search_score * 1.0)
       * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END))::real AS heat_weighted_score,
    (((s.tv_score * 1.5 + s.search_score * 1.0))
       / NULLIF((s.tv_freq_score * 1.5 + s.search_freq_score * 1.0), 0))::real AS heat_depth,
    s.tv_match_count,
    s.tv_top_keyword,
    s.tv_total_pushes,
    s.search_match_count,
    s.search_top_keyword,
    s.search_sources
  FROM scored s
  WHERE ((s.tv_score * 1.5 + s.search_score * 1.0)
           * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)) >= min_score
  ORDER BY
    (CASE WHEN s.is_imminent THEN 1 ELSE 0 END) DESC,
    ((s.tv_score * 1.5 + s.search_score * 1.0)
       * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)) DESC
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_ggsan_recommend(int, float, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_ggsan_recommend(int, float, float, int) TO service_role;
REVOKE ALL ON FUNCTION jimscanner_heat_weight(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_heat_weight(jsonb) TO service_role;
