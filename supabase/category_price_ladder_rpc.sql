-- ────────────────────────────────────────────────────────────
-- 카테고리 가격사다리 커버리지 갭 RPC (2026-05-25)
-- ────────────────────────────────────────────────────────────
-- 어디 가격대 슬롯이 SERP 공급은 희박한데 ggsan 후보로 채울 수 있는가.
-- 사용처: /admin/trend-radar/price-ladder
--
-- 매트릭스: (category_top in health|living|digital) × (6 가격버킷)
-- 각 셀에 3개 지표
--   (a) SERP 공급 밀도 = jimscanner_trends_supplier × jimscanner_trends_products
--   (b) ggsan 후보 수 = price * (1 + markup) 가 버킷에 떨어지는 SKU
--   (c) 기대마진 = (SERP 중위가 - ggsan 도매 중위가) / SERP 중위가
--
-- is_entry_slot = SERP 공급 < 5 × ggsan_count > 0 × margin >= 35%
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_category_price_ladder(
  days_window int DEFAULT 30,
  sale_markup_pct numeric DEFAULT 100.0
)
RETURNS TABLE (
  category_top text,
  bucket_idx int,
  bucket_label text,
  bucket_min int,
  bucket_max int,
  serp_count int,
  serp_median numeric,
  ggsan_count int,
  ggsan_wholesale_median numeric,
  ggsan_resale_median numeric,
  ggsan_wholesale_min int,
  ggsan_wholesale_max int,
  expected_margin_pct numeric,
  is_entry_slot boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH buckets AS (
    SELECT * FROM (VALUES
      (1, '<5k',     0,      5000),
      (2, '5-10k',   5000,   10000),
      (3, '10-20k',  10000,  20000),
      (4, '20-50k',  20000,  50000),
      (5, '50-100k', 50000,  100000),
      (6, '>100k',   100000, 2147483647)
    ) AS b(bucket_idx, bucket_label, bucket_min, bucket_max)
  ),
  cats AS (
    SELECT unnest(ARRAY['health','living','digital']) AS category_top
  ),
  serp AS (
    SELECT p.category_top, s.price_krw
    FROM jimscanner_trends_supplier s
    JOIN jimscanner_trends_products p ON p.id = s.product_id
    WHERE s.collected_at > now() - (days_window || ' days')::interval
      AND p.category_top IN ('health','living','digital')
      AND s.price_krw IS NOT NULL
      AND s.price_krw > 0
  ),
  -- ggsan 카탈로그는 식품·건기식 도매 위주(001~014) — 일단 모두 'health' 매핑.
  -- 추후 cate_cd → category_top 매핑 테이블 도입 시 교체.
  ggsan AS (
    SELECT
      'health'::text AS category_top,
      g.goods_no,
      g.price_krw::numeric AS wholesale_krw,
      (g.price_krw::numeric * (1.0 + sale_markup_pct / 100.0)) AS resale_krw
    FROM jimscanner_ggsan_products g
    WHERE g.status <> 'removed'
      AND g.price_krw IS NOT NULL
      AND g.price_krw > 0
  ),
  serp_stats AS (
    SELECT
      b.bucket_idx, b.bucket_label, b.bucket_min, b.bucket_max,
      c.category_top,
      COUNT(s.price_krw)::int AS serp_count,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_krw)::numeric AS serp_median
    FROM buckets b
    CROSS JOIN cats c
    LEFT JOIN serp s
      ON s.category_top = c.category_top
     AND s.price_krw >= b.bucket_min
     AND s.price_krw <  b.bucket_max
    GROUP BY b.bucket_idx, b.bucket_label, b.bucket_min, b.bucket_max, c.category_top
  ),
  ggsan_stats AS (
    SELECT
      b.bucket_idx, c.category_top,
      COUNT(g.goods_no)::int AS ggsan_count,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY g.wholesale_krw)::numeric AS ggsan_wholesale_median,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY g.resale_krw)::numeric AS ggsan_resale_median,
      MIN(g.wholesale_krw)::int AS ggsan_wholesale_min,
      MAX(g.wholesale_krw)::int AS ggsan_wholesale_max
    FROM buckets b
    CROSS JOIN cats c
    LEFT JOIN ggsan g
      ON g.category_top = c.category_top
     AND g.resale_krw >= b.bucket_min
     AND g.resale_krw <  b.bucket_max
    GROUP BY b.bucket_idx, c.category_top
  )
  SELECT
    ss.category_top,
    ss.bucket_idx,
    ss.bucket_label,
    ss.bucket_min::int,
    ss.bucket_max::int,
    ss.serp_count,
    ss.serp_median,
    COALESCE(gs.ggsan_count, 0) AS ggsan_count,
    gs.ggsan_wholesale_median,
    gs.ggsan_resale_median,
    gs.ggsan_wholesale_min,
    gs.ggsan_wholesale_max,
    CASE
      WHEN ss.serp_median IS NOT NULL
       AND gs.ggsan_wholesale_median IS NOT NULL
       AND ss.serp_median > 0
        THEN ((ss.serp_median - gs.ggsan_wholesale_median) / ss.serp_median * 100.0)::numeric
      ELSE NULL
    END AS expected_margin_pct,
    (
      ss.serp_count < 5
      AND COALESCE(gs.ggsan_count, 0) > 0
      AND ss.serp_median IS NOT NULL
      AND gs.ggsan_wholesale_median IS NOT NULL
      AND ss.serp_median > 0
      AND ((ss.serp_median - gs.ggsan_wholesale_median) / ss.serp_median) >= 0.35
    ) AS is_entry_slot
  FROM serp_stats ss
  LEFT JOIN ggsan_stats gs
    ON gs.bucket_idx = ss.bucket_idx
   AND gs.category_top = ss.category_top
  ORDER BY ss.category_top, ss.bucket_idx;
$$;

REVOKE ALL ON FUNCTION jimscanner_category_price_ladder(int, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_category_price_ladder(int, numeric) TO service_role;
