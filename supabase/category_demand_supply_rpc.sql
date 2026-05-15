-- ────────────────────────────────────────────────────────────
-- 카테고리 × 채널 수요-공급 갭 RPC (Opportunity Map, 2026-05-15)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/opportunity-map
-- 행: ggsan cate_cd (14개, 001 장건강 ~ 020 임박특가)
-- 열: 4개 수요 채널 (tv / naver_search / naver_shopping / community)
-- 셀: demand_index / supply_depth (= 진입 기회 비율)
--
-- demand_index = SUM(occurrences × pg_trgm similarity)
--   - 키워드 ↔ ggsan 상품 title fuzzy 매칭 후 채널별 누적 신호 강도
-- supply_depth = active 매물 수 + 가격 다양성 가중치
--   - 낮을수록 제품군 단일 → 진입 가능성 ↑
-- ratio = demand / supply  (높을수록 빨강 — 수요 강한데 공급 얕음)
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_category_demand_supply(
  days_window int DEFAULT 30,
  min_sim float DEFAULT 0.20
)
RETURNS TABLE (
  cate_cd text,
  cate_label text,
  channel text,
  demand_index real,
  keyword_count int,
  supply_count int,
  price_stddev real,
  supply_depth real,
  ratio real
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH src_keywords AS (
    SELECT
      k.keyword,
      CASE
        WHEN k.source = 'naver_tvtime' THEN 'tv'
        WHEN k.source = 'naver_search_trend' THEN 'naver_search'
        WHEN k.source IN ('naver_shopping_hot', 'naver_shopping_insight') THEN 'naver_shopping'
        WHEN k.source IN ('naver_blog', 'naver_news', 'aliex_best', 'musinsa_best') THEN 'community'
        ELSE NULL
      END AS channel,
      COUNT(*)::int AS occurrences
    FROM jimscanner_trends_keywords k
    WHERE k.collected_at > now() - (days_window || ' days')::interval
    GROUP BY k.keyword,
      CASE
        WHEN k.source = 'naver_tvtime' THEN 'tv'
        WHEN k.source = 'naver_search_trend' THEN 'naver_search'
        WHEN k.source IN ('naver_shopping_hot', 'naver_shopping_insight') THEN 'naver_shopping'
        WHEN k.source IN ('naver_blog', 'naver_news', 'aliex_best', 'musinsa_best') THEN 'community'
        ELSE NULL
      END
  ),
  demand AS (
    SELECT
      gp.cate_cd,
      sk.channel,
      SUM(sk.occurrences::real * similarity(sk.keyword, gp.title))::real AS demand_index,
      COUNT(DISTINCT sk.keyword)::int AS keyword_count
    FROM src_keywords sk
    CROSS JOIN LATERAL (
      SELECT g.cate_cd, g.title
      FROM jimscanner_ggsan_products g
      WHERE g.cate_cd IS NOT NULL
        AND g.title % sk.keyword
        AND similarity(sk.keyword, g.title) >= min_sim
    ) gp
    WHERE sk.channel IS NOT NULL
    GROUP BY gp.cate_cd, sk.channel
  ),
  supply AS (
    SELECT
      gp.cate_cd,
      MAX(gp.cate_label) AS cate_label,
      COUNT(*) FILTER (WHERE gp.status IS NULL OR gp.status = 'active' OR gp.status = 'imminent')::int AS supply_count,
      COALESCE(stddev_pop(gp.price_krw), 0)::real AS price_stddev
    FROM jimscanner_ggsan_products gp
    WHERE gp.cate_cd IS NOT NULL
    GROUP BY gp.cate_cd
  ),
  channels AS (
    SELECT unnest(ARRAY['tv', 'naver_search', 'naver_shopping', 'community']) AS channel
  ),
  matrix AS (
    SELECT s.cate_cd, s.cate_label, s.supply_count, s.price_stddev, c.channel
    FROM supply s
    CROSS JOIN channels c
  )
  SELECT
    m.cate_cd,
    m.cate_label,
    m.channel,
    COALESCE(d.demand_index, 0)::real AS demand_index,
    COALESCE(d.keyword_count, 0) AS keyword_count,
    m.supply_count,
    m.price_stddev,
    (m.supply_count::real + LEAST(m.price_stddev / 10000.0, m.supply_count::real))::real AS supply_depth,
    CASE
      WHEN m.supply_count > 0
        THEN (COALESCE(d.demand_index, 0) / GREATEST(m.supply_count::real + LEAST(m.price_stddev / 10000.0, m.supply_count::real), 1.0))::real
      ELSE 0::real
    END AS ratio
  FROM matrix m
  LEFT JOIN demand d ON d.cate_cd = m.cate_cd AND d.channel = m.channel
  ORDER BY m.cate_cd, m.channel;
$$;

REVOKE ALL ON FUNCTION jimscanner_category_demand_supply(int, float) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_category_demand_supply(int, float) TO service_role;


-- ────────────────────────────────────────────────────────────
-- 셀 클릭 시 드릴다운: 해당 (cate_cd, channel) 의 키워드 Top10 + ggsan 상품 Top10
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_category_demand_supply_detail(
  p_cate_cd text,
  p_channel text,
  days_window int DEFAULT 30,
  min_sim float DEFAULT 0.20,
  result_limit int DEFAULT 10
)
RETURNS TABLE (
  kind text,             -- 'keyword' | 'product'
  ident text,            -- keyword text or goods_no
  label text,            -- 키워드 또는 상품명
  metric real,           -- 키워드: demand 강도 / 상품: price_krw 또는 last_seen
  occurrences int,
  source text,           -- 키워드일 때 원본 source
  detail_url text,       -- 상품일 때 URL
  image_url text,
  is_imminent boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH channel_sources AS (
    SELECT unnest(
      CASE p_channel
        WHEN 'tv' THEN ARRAY['naver_tvtime']
        WHEN 'naver_search' THEN ARRAY['naver_search_trend']
        WHEN 'naver_shopping' THEN ARRAY['naver_shopping_hot', 'naver_shopping_insight']
        WHEN 'community' THEN ARRAY['naver_blog', 'naver_news', 'aliex_best', 'musinsa_best']
        ELSE ARRAY[]::text[]
      END
    ) AS source
  ),
  kw AS (
    SELECT k.keyword, MAX(k.source) AS source, COUNT(*)::int AS occurrences
    FROM jimscanner_trends_keywords k
    WHERE k.source IN (SELECT source FROM channel_sources)
      AND k.collected_at > now() - (days_window || ' days')::interval
    GROUP BY k.keyword
  ),
  kw_matched AS (
    SELECT
      kw.keyword,
      kw.source,
      kw.occurrences,
      MAX(similarity(kw.keyword, gp.title))::real AS best_sim
    FROM kw
    JOIN jimscanner_ggsan_products gp
      ON gp.cate_cd = p_cate_cd
     AND gp.title % kw.keyword
     AND similarity(kw.keyword, gp.title) >= min_sim
    GROUP BY kw.keyword, kw.source, kw.occurrences
  ),
  top_keywords AS (
    SELECT
      'keyword'::text AS kind,
      keyword AS ident,
      keyword AS label,
      (occurrences::real * best_sim)::real AS metric,
      occurrences,
      source,
      NULL::text AS detail_url,
      NULL::text AS image_url,
      false AS is_imminent
    FROM kw_matched
    ORDER BY (occurrences::real * best_sim) DESC
    LIMIT result_limit
  ),
  top_products AS (
    SELECT
      'product'::text AS kind,
      gp.goods_no AS ident,
      gp.title AS label,
      COALESCE(gp.price_krw::real, 0)::real AS metric,
      0 AS occurrences,
      NULL::text AS source,
      gp.detail_url,
      gp.image_url,
      gp.is_imminent
    FROM jimscanner_ggsan_products gp
    WHERE gp.cate_cd = p_cate_cd
    ORDER BY gp.last_seen_at DESC NULLS LAST
    LIMIT result_limit
  )
  SELECT * FROM top_keywords
  UNION ALL
  SELECT * FROM top_products;
$$;

REVOKE ALL ON FUNCTION jimscanner_category_demand_supply_detail(text, text, int, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_category_demand_supply_detail(text, text, int, float, int) TO service_role;
