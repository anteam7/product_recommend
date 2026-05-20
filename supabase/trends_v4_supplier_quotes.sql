-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 공급원 도매가 분산 (Wholesaler Quote Dispersion)
-- 2026-05-20
-- ─────────────────────────────────────────────────────────────
-- 동일 canonical product 에 매핑된 복수 도매 공급원의 견적 분포 추적.
-- 기존 #40 (retail end-channel 차익), #59 (단일 공급사 안정성) 와는 별도 축.
-- CV(변동계수) 크면 협상 우위, 축소 추세 = commoditization 임박.
--
-- 노출 정책: service-role 만. (기존 jimscanner_trends_* 패턴 동일)
-- ─────────────────────────────────────────────────────────────

-- 1) 공급원 견적 시계열
CREATE TABLE IF NOT EXISTS jimscanner_trends_supplier_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  source text NOT NULL,                 -- 'ggsan' | 'domeggook' | '1688'
  supplier_id_or_seller_name text NOT NULL,  -- 셀러 식별자 (ggsan: goods_no 또는 seller, 1688: shop_id)
  external_url text,                    -- 원본 리스팅 URL (옵션)

  unit_price_krw numeric,               -- KRW 환산 단가
  currency text NOT NULL DEFAULT 'KRW',
  raw_price numeric,                    -- 원본 통화 가격
  moq integer,                          -- 최소 주문 수량

  captured_at timestamptz NOT NULL DEFAULT now(),
  raw_payload jsonb,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_supplier_quotes_product_at
  ON jimscanner_trends_supplier_quotes(product_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_supplier_quotes_source
  ON jimscanner_trends_supplier_quotes(source, captured_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_supplier_quotes_product_source_seller
  ON jimscanner_trends_supplier_quotes(product_id, source, supplier_id_or_seller_name, captured_at DESC);

ALTER TABLE jimscanner_trends_supplier_quotes ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role) 만.


-- 2) 일별 집계 view — 박스플롯 / CV 추세용
--    "당일 같은 product 의 N 공급원 견적 분포"
CREATE OR REPLACE VIEW jimscanner_trends_supplier_quotes_daily AS
WITH per_seller_daily AS (
  -- 같은 (product, source, seller) 가 하루에 여러 번 잡혀도 1행만 카운트
  -- (가장 최근 captured_at 의 단가 사용)
  SELECT DISTINCT ON (product_id, source, supplier_id_or_seller_name, captured_day)
    product_id,
    source,
    supplier_id_or_seller_name,
    (captured_at AT TIME ZONE 'Asia/Seoul')::date AS captured_day,
    unit_price_krw
  FROM jimscanner_trends_supplier_quotes
  WHERE unit_price_krw IS NOT NULL AND unit_price_krw > 0
  ORDER BY product_id, source, supplier_id_or_seller_name, captured_day, captured_at DESC
)
SELECT
  product_id,
  captured_day,
  COUNT(*)::int                                                          AS n_suppliers,
  COUNT(*) FILTER (WHERE source = 'ggsan')::int                           AS n_ggsan_sellers,
  COUNT(*) FILTER (WHERE source = 'domeggook')::int                       AS n_domeggook_sellers,
  COUNT(*) FILTER (WHERE source = '1688')::int                            AS n_1688_sellers,
  MIN(unit_price_krw)                                                    AS price_min,
  MAX(unit_price_krw)                                                    AS price_max,
  AVG(unit_price_krw)                                                    AS price_mean,
  percentile_cont(0.10) WITHIN GROUP (ORDER BY unit_price_krw)            AS price_p10,
  percentile_cont(0.25) WITHIN GROUP (ORDER BY unit_price_krw)            AS price_p25,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY unit_price_krw)            AS price_median,
  percentile_cont(0.75) WITHIN GROUP (ORDER BY unit_price_krw)            AS price_p75,
  percentile_cont(0.90) WITHIN GROUP (ORDER BY unit_price_krw)            AS price_p90,
  (percentile_cont(0.75) WITHIN GROUP (ORDER BY unit_price_krw)
    - percentile_cont(0.25) WITHIN GROUP (ORDER BY unit_price_krw))      AS iqr,
  stddev_samp(unit_price_krw)                                            AS price_stddev,
  CASE
    WHEN AVG(unit_price_krw) > 0 AND COUNT(*) > 1
      THEN stddev_samp(unit_price_krw) / AVG(unit_price_krw)
    ELSE NULL
  END                                                                    AS cv
FROM per_seller_daily
GROUP BY product_id, captured_day;


-- 3) 최근 N일 CV 추세 (30/60/90일 윈도우 평균) — 어드민 핀 보드용
CREATE OR REPLACE VIEW jimscanner_trends_supplier_quotes_window AS
SELECT
  d.product_id,
  MAX(d.captured_day) AS latest_day,
  COUNT(*) FILTER (WHERE d.captured_day >= (CURRENT_DATE - INTERVAL '30 days')) AS days_30d,
  COUNT(*) FILTER (WHERE d.captured_day >= (CURRENT_DATE - INTERVAL '60 days')) AS days_60d,
  COUNT(*) FILTER (WHERE d.captured_day >= (CURRENT_DATE - INTERVAL '90 days')) AS days_90d,
  AVG(d.cv) FILTER (WHERE d.captured_day >= (CURRENT_DATE - INTERVAL '30 days')) AS cv_30d,
  AVG(d.cv) FILTER (WHERE d.captured_day >= (CURRENT_DATE - INTERVAL '60 days')) AS cv_60d,
  AVG(d.cv) FILTER (WHERE d.captured_day >= (CURRENT_DATE - INTERVAL '90 days')) AS cv_90d,
  AVG(d.n_suppliers) FILTER (WHERE d.captured_day >= (CURRENT_DATE - INTERVAL '30 days')) AS avg_n_suppliers_30d,
  MAX(d.n_ggsan_sellers) FILTER (WHERE d.captured_day >= (CURRENT_DATE - INTERVAL '30 days')) AS max_n_ggsan_sellers_30d
FROM jimscanner_trends_supplier_quotes_daily d
GROUP BY d.product_id;
