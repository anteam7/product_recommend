-- ────────────────────────────────────────────────────────────
-- jimscanner_retail_price_probes — 리테일 시장가 시계열 (2026-05-15)
-- ────────────────────────────────────────────────────────────
-- 사용처:
--   - scripts/probe-retail-prices.mjs  →  Naver Shopping API 로 ggsan 활성 상품 검색
--   - /admin/trend-radar/margin        →  view jimscanner_margin_candidates 로 마진 정렬 노출
--   - /admin/trend-radar/recommend     →  카드 뱃지 (리테일 중앙가 / 마진 ▴)
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_retail_price_probes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goods_no text,                         -- ggsan goods_no (canonical product 만 들어오면 NULL)
  product_id text,                       -- canonical product id (jimscanner_trends_products.id) — 옵션
  query text NOT NULL,                   -- 실제 API 검색어
  source text NOT NULL DEFAULT 'naver_shopping_api',
  price_min int,
  price_med int,
  price_max int,
  listing_count int,                     -- API total (시장 등록상품수, saturation 지표)
  observed_at timestamptz NOT NULL DEFAULT now(),
  raw_payload jsonb
);

CREATE INDEX IF NOT EXISTS jimscanner_retail_price_probes_goods_at
  ON jimscanner_retail_price_probes(goods_no, observed_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_retail_price_probes_product_at
  ON jimscanner_retail_price_probes(product_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_retail_price_probes_observed
  ON jimscanner_retail_price_probes(observed_at DESC);

ALTER TABLE jimscanner_retail_price_probes ENABLE ROW LEVEL SECURITY;
-- service-role (admin·cron) 만 접근.


-- ────────────────────────────────────────────────────────────
-- jimscanner_margin_candidates view — ggsan 도매 × 최근 리테일 probe
-- ────────────────────────────────────────────────────────────
-- margin_pct      = (retail_med - wholesale) / retail_med
-- gross_profit    = retail_med - wholesale  (원, 단위 수익)
-- listing_count   = 경쟁 강도 (적을수록 진입 유리)
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW jimscanner_margin_candidates AS
WITH latest_probe AS (
  SELECT DISTINCT ON (goods_no)
    goods_no,
    price_min,
    price_med,
    price_max,
    listing_count,
    observed_at
  FROM jimscanner_retail_price_probes
  WHERE goods_no IS NOT NULL
  ORDER BY goods_no, observed_at DESC
)
SELECT
  g.goods_no,
  g.title,
  g.cate_cd,
  g.cate_label,
  g.price_krw     AS wholesale_krw,
  g.image_url,
  g.detail_url,
  g.is_imminent,
  g.status,
  l.price_min     AS retail_min_krw,
  l.price_med     AS retail_med_krw,
  l.price_max     AS retail_max_krw,
  l.listing_count,
  l.observed_at   AS probed_at,
  CASE
    WHEN l.price_med IS NOT NULL AND g.price_krw IS NOT NULL AND l.price_med > 0
    THEN ((l.price_med - g.price_krw)::float / l.price_med::float)
    ELSE NULL
  END AS margin_pct,
  CASE
    WHEN l.price_med IS NOT NULL AND g.price_krw IS NOT NULL
    THEN (l.price_med - g.price_krw)
    ELSE NULL
  END AS gross_profit_krw
FROM jimscanner_ggsan_products g
LEFT JOIN latest_probe l ON l.goods_no = g.goods_no;
