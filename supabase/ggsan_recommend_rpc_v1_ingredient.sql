-- ────────────────────────────────────────────────────────────
-- jimscanner_ggsan_recommend V1 — ingredient_score 컴포넌트 추가 (2026-05-21)
-- ────────────────────────────────────────────────────────────
-- ingredient_score (0~1) = matched_ingredients × 그 원료들의 velocity 평균
-- final_score 에 0.2 가중치로 반영
-- 의존: supabase/ingredient_lexicon.sql 가 먼저 적용되어야 함
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
  ingredient_score real,
  raw_score real,
  imminent_bonus real,
  final_score real,
  -- 매칭 근거
  tv_match_count int,
  tv_top_keyword text,
  tv_total_pushes int,
  search_match_count int,
  search_top_keyword text,
  search_sources text[],
  ingredient_match_count int,
  matched_ingredients text[]
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
    SELECT gp.goods_no, tv.keyword AS tv_keyword, tv.tv_count,
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
    SELECT goods_no,
           SUM(strength)::real AS tv_score,
           COUNT(DISTINCT tv_keyword)::int AS tv_match_count,
           SUM(tv_count)::int AS tv_total_pushes,
           (ARRAY_AGG(tv_keyword ORDER BY strength DESC))[1] AS tv_top_keyword
    FROM tv_matches GROUP BY goods_no
  ),
  search_keywords AS (
    SELECT keyword, source, COUNT(*)::int AS occurrences
    FROM jimscanner_trends_keywords
    WHERE source IN ('naver_shopping_hot','naver_search_trend','aliex_best','musinsa_best')
      AND collected_at > now() - (days_window || ' days')::interval
    GROUP BY keyword, source
  ),
  search_matches AS (
    SELECT gp.goods_no, sk.keyword AS search_keyword, sk.source, sk.occurrences,
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
    SELECT goods_no,
           SUM(strength)::real AS search_score,
           COUNT(DISTINCT search_keyword)::int AS search_match_count,
           (ARRAY_AGG(search_keyword ORDER BY strength DESC))[1] AS search_top_keyword,
           ARRAY_AGG(DISTINCT source) AS search_sources
    FROM search_matches GROUP BY goods_no
  ),
  -- 원료 점수: ggsan 상품에 매칭된 원료들의 velocity 평균 (0~1 로 clip)
  ingredient_agg AS (
    SELECT
      m.goods_no,
      m.ingredient_match_count,
      m.matched_ingredients,
      -- velocity 0..2 를 기대 → 0..1 로 normalize (clip)
      LEAST(1.0,
        COALESCE(
          AVG(LEAST(2.0, COALESCE(iv.velocity, 0.0))) / 2.0,
          0.0
        )
      )::real AS ingredient_score
    FROM jimscanner_ggsan_ingredient_match m
    LEFT JOIN jimscanner_ingredient_velocity iv
      ON iv.name = ANY(m.matched_ingredients)
    GROUP BY m.goods_no, m.ingredient_match_count, m.matched_ingredients
  ),
  scored AS (
    SELECT
      gp.goods_no, gp.title, gp.cate_cd, gp.cate_label, gp.price_krw,
      gp.is_imminent, gp.image_url, gp.detail_url, gp.last_seen_at,
      COALESCE(tv.tv_score, 0)::real AS tv_score,
      COALESCE(s.search_score, 0)::real AS search_score,
      COALESCE(ig.ingredient_score, 0)::real AS ingredient_score,
      COALESCE(tv.tv_match_count, 0) AS tv_match_count,
      COALESCE(tv.tv_top_keyword, '') AS tv_top_keyword,
      COALESCE(tv.tv_total_pushes, 0) AS tv_total_pushes,
      COALESCE(s.search_match_count, 0) AS search_match_count,
      COALESCE(s.search_top_keyword, '') AS search_top_keyword,
      COALESCE(s.search_sources, ARRAY[]::text[]) AS search_sources,
      COALESCE(ig.ingredient_match_count, 0) AS ingredient_match_count,
      COALESCE(ig.matched_ingredients, ARRAY[]::text[]) AS matched_ingredients
    FROM jimscanner_ggsan_products gp
    LEFT JOIN tv_agg tv ON tv.goods_no = gp.goods_no
    LEFT JOIN search_agg s ON s.goods_no = gp.goods_no
    LEFT JOIN ingredient_agg ig ON ig.goods_no = gp.goods_no
    WHERE tv.tv_score IS NOT NULL
       OR s.search_score IS NOT NULL
       OR (ig.ingredient_score IS NOT NULL AND ig.ingredient_score > 0)
  )
  SELECT
    s.goods_no, s.title, s.cate_cd, s.cate_label, s.price_krw,
    s.is_imminent, s.image_url, s.detail_url, s.last_seen_at AS ggsan_last_seen,
    s.tv_score,
    s.search_score,
    s.ingredient_score,
    (s.tv_score * 1.5 + s.search_score * 1.0 + s.ingredient_score * 0.2)::real AS raw_score,
    (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)::real AS imminent_bonus,
    ((s.tv_score * 1.5 + s.search_score * 1.0 + s.ingredient_score * 0.2)
       * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END))::real AS final_score,
    s.tv_match_count, s.tv_top_keyword, s.tv_total_pushes,
    s.search_match_count, s.search_top_keyword, s.search_sources,
    s.ingredient_match_count, s.matched_ingredients
  FROM scored s
  WHERE ((s.tv_score * 1.5 + s.search_score * 1.0 + s.ingredient_score * 0.2)
           * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)) >= min_score
  ORDER BY
    (CASE WHEN s.is_imminent THEN 1 ELSE 0 END) DESC,
    ((s.tv_score * 1.5 + s.search_score * 1.0 + s.ingredient_score * 0.2)
       * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)) DESC
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_ggsan_recommend(int, float, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_ggsan_recommend(int, float, float, int) TO service_role;
