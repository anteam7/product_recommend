-- ────────────────────────────────────────────────────────────
-- 도매 신규입고 펄스 × 트렌드 시드 first-mover 보드 RPC
-- (PR-GGSAN-NEWARRIVAL, 2026-05-28)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/ggsan/new-arrivals
-- 시그널:
--   1) jimscanner_ggsan_products.first_seen_at 가 최근 N일 이내 (신규 입고 펄스)
--   2) 같은 ±match_window_days 윈도우에 trends_keywords 의 여러 source 에서
--      title 토큰과 매칭되는 가속 시그널이 min_sources 이상
--   3) 같은 매칭 키워드에 잡히는 다른 ggsan SKU 수(=경쟁 SKU 수)가 max_competitors 이하
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_ggsan_newarrival_match(
  days_back        int     DEFAULT 14,    -- first_seen_at 윈도우 (7, 14, 30)
  match_window_days int    DEFAULT 14,    -- first_seen_at ± N일 안에서 트렌드 매칭
  min_sim          float   DEFAULT 0.20,
  min_sources      int     DEFAULT 2,     -- 가속 시그널이 잡혀야 하는 최소 source 개수
  max_competitors  int     DEFAULT 3,     -- 같은 키워드에 잡힌 다른 ggsan SKU 수 상한
  result_limit     int     DEFAULT 200
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
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  age_days int,
  -- 매칭 시그널
  top_keyword text,
  best_sim real,
  source_count int,
  sources text[],
  match_count int,
  total_volume_relative numeric,
  -- 경쟁
  competitor_sku_count int,
  -- 종합 점수 (source_count × best_sim × log(match_count+1))
  golden_score real
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  new_arrivals AS (
    SELECT
      gp.goods_no, gp.title, gp.cate_cd, gp.cate_label, gp.price_krw,
      gp.is_imminent, gp.image_url, gp.detail_url,
      gp.first_seen_at, gp.last_seen_at
    FROM jimscanner_ggsan_products gp
    WHERE gp.first_seen_at > now() - (days_back || ' days')::interval
      AND gp.status IS DISTINCT FROM 'removed'
  ),
  trend_window AS (
    SELECT
      k.keyword,
      k.source,
      k.collected_at,
      COALESCE(k.volume_relative, 0)::numeric AS volume_relative
    FROM jimscanner_trends_keywords k
    WHERE k.source IN (
      'trends_products',
      'naver_search_trend',
      'naver_shopping_insight',
      'naver_shopping_hot',
      'google_suggest',
      'google_trends_kr',
      'naver_news',
      'naver_tvtime'
    )
      AND k.collected_at > now() - ((days_back + match_window_days) || ' days')::interval
  ),
  matches AS (
    SELECT
      na.goods_no,
      tw.keyword,
      tw.source,
      similarity(tw.keyword, na.title) AS sim,
      tw.volume_relative,
      tw.collected_at
    FROM new_arrivals na
    CROSS JOIN LATERAL (
      SELECT t.keyword, t.source, t.volume_relative, t.collected_at
      FROM trend_window t
      WHERE t.keyword % na.title
        AND t.collected_at BETWEEN
             na.first_seen_at - (match_window_days || ' days')::interval
         AND na.first_seen_at + (match_window_days || ' days')::interval
    ) tw
    WHERE similarity(tw.keyword, na.title) >= min_sim
  ),
  per_sku AS (
    SELECT
      m.goods_no,
      COUNT(*)::int                              AS match_count,
      COUNT(DISTINCT m.source)::int              AS source_count,
      ARRAY_AGG(DISTINCT m.source)               AS sources,
      MAX(m.sim)::real                           AS best_sim,
      SUM(m.volume_relative)::numeric            AS total_volume_relative,
      (ARRAY_AGG(m.keyword ORDER BY m.sim DESC))[1] AS top_keyword
    FROM matches m
    GROUP BY m.goods_no
  ),
  -- 경쟁 SKU 수: 같은 top_keyword 에 trigram 매칭되는 다른 ggsan 상품(신규 여부 무관)
  competitors AS (
    SELECT
      ps.goods_no,
      ps.top_keyword,
      (
        SELECT COUNT(*)::int
        FROM jimscanner_ggsan_products g
        WHERE g.goods_no <> ps.goods_no
          AND g.status IS DISTINCT FROM 'removed'
          AND g.title % ps.top_keyword
          AND similarity(ps.top_keyword, g.title) >= min_sim
      ) AS competitor_sku_count
    FROM per_sku ps
  )
  SELECT
    na.goods_no,
    na.title,
    na.cate_cd,
    na.cate_label,
    na.price_krw,
    na.is_imminent,
    na.image_url,
    na.detail_url,
    na.first_seen_at,
    na.last_seen_at,
    EXTRACT(DAY FROM now() - na.first_seen_at)::int AS age_days,
    ps.top_keyword,
    ps.best_sim,
    ps.source_count,
    ps.sources,
    ps.match_count,
    ps.total_volume_relative,
    COALESCE(c.competitor_sku_count, 0) AS competitor_sku_count,
    (ps.source_count::real * ps.best_sim * ln(ps.match_count + 1)::real) AS golden_score
  FROM new_arrivals na
  JOIN per_sku ps ON ps.goods_no = na.goods_no
  LEFT JOIN competitors c ON c.goods_no = na.goods_no
  WHERE ps.source_count >= min_sources
    AND COALESCE(c.competitor_sku_count, 0) <= max_competitors
  ORDER BY
    -- 신규성 우선
    (na.first_seen_at > now() - INTERVAL '7 days') DESC,
    -- golden_score
    (ps.source_count::real * ps.best_sim * ln(ps.match_count + 1)::real) DESC,
    -- 경쟁 적은 순
    COALESCE(c.competitor_sku_count, 0) ASC
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_ggsan_newarrival_match(int, int, float, int, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_ggsan_newarrival_match(int, int, float, int, int, int) TO service_role;

-- ────────────────────────────────────────────────────────────
-- 부가: first_seen_at NULL/잘못된 row backfill 헬퍼 (idempotent)
-- 정책: first_seen_at < created_at 이거나 NULL 인 경우 created_at 으로 보정
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_ggsan_backfill_first_seen()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  fixed int;
BEGIN
  UPDATE jimscanner_ggsan_products
     SET first_seen_at = created_at
   WHERE first_seen_at IS NULL
      OR first_seen_at > last_seen_at
      OR first_seen_at > now() + INTERVAL '1 day';
  GET DIAGNOSTICS fixed = ROW_COUNT;
  RETURN fixed;
END;
$$;

REVOKE ALL ON FUNCTION jimscanner_ggsan_backfill_first_seen() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_ggsan_backfill_first_seen() TO service_role;
