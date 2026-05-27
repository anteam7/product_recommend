-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 리뷰 적립속도 → 추정 판매량 보드
-- ─────────────────────────────────────────────────────────────
-- 가설: Δreviews/일 × (1 / 리뷰전환률) = 추정 일판매량
-- 채널별 디폴트 리뷰전환률:
--   coupang     : 2.5%
--   smartstore  : 1.5%
-- 캘리브레이션: 자기 발행 SKU 의 실주문 ÷ 리뷰증가 비율로 자동 학습.
-- ─────────────────────────────────────────────────────────────

-- 1) 경쟁 SKU 마스터 (제품과 채널/상품 ID 매핑)
CREATE TABLE IF NOT EXISTS jimscanner_trends_competitor_skus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('coupang','smartstore','naver_shopping','aliex','musinsa','other')),
  external_sku_id text NOT NULL,
  name text,
  url text,
  category_path text,
  rank_serp int,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_sku_id)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_competitor_skus_product
  ON jimscanner_trends_competitor_skus(product_id);

ALTER TABLE jimscanner_trends_competitor_skus ENABLE ROW LEVEL SECURITY;


-- 2) 리뷰 스냅샷 (일 1회)
CREATE TABLE IF NOT EXISTS jimscanner_competitor_review_snapshots (
  id bigserial PRIMARY KEY,
  competitor_sku_id uuid NOT NULL REFERENCES jimscanner_trends_competitor_skus(id) ON DELETE CASCADE,
  channel text NOT NULL,
  external_sku_id text NOT NULL,
  review_count int NOT NULL,
  rating_avg numeric(3,2),
  price_krw int,
  observed_at timestamptz NOT NULL DEFAULT now(),
  observed_date date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Seoul')::date,
  UNIQUE (competitor_sku_id, observed_date)
);

CREATE INDEX IF NOT EXISTS jimscanner_competitor_review_snapshots_sku_at
  ON jimscanner_competitor_review_snapshots(competitor_sku_id, observed_date DESC);

CREATE INDEX IF NOT EXISTS jimscanner_competitor_review_snapshots_channel_at
  ON jimscanner_competitor_review_snapshots(channel, observed_date DESC);

ALTER TABLE jimscanner_competitor_review_snapshots ENABLE ROW LEVEL SECURITY;


-- 3) 채널별 리뷰전환률 캘리브레이션 테이블
CREATE TABLE IF NOT EXISTS jimscanner_review_calibration (
  channel text PRIMARY KEY,
  review_rate numeric(6,5) NOT NULL,   -- 실주문 대비 리뷰 작성 비율 (0~1)
  sample_size int NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'default',   -- 'default' | 'self_calibrated'
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE jimscanner_review_calibration ENABLE ROW LEVEL SECURITY;

-- 디폴트 시드: 업계 통념
INSERT INTO jimscanner_review_calibration (channel, review_rate, sample_size, source, notes)
VALUES
  ('coupang',         0.02500, 0, 'default', '쿠팡 통상 2~3% (업계 통념). 자기 SKU 캘리브레이션 후 자동 갱신.'),
  ('smartstore',      0.01500, 0, 'default', '네이버 스마트스토어 1~2% (업계 통념).'),
  ('naver_shopping',  0.01500, 0, 'default', '스마트스토어와 동일 가정.'),
  ('aliex',           0.03500, 0, 'default', '알리 통상 3~4% (해외 직구 표본).'),
  ('musinsa',         0.02000, 0, 'default', '무신사 추정치.'),
  ('other',           0.02000, 0, 'default', '미지정 채널 디폴트.')
ON CONFLICT (channel) DO NOTHING;


-- 4) 일별 추정 판매량 뷰
--    LAG 로 전일 review_count 와 차분 → 리뷰전환률로 나눠 일판매량 추정.
CREATE OR REPLACE VIEW jimscanner_competitor_daily_sales AS
WITH diffed AS (
  SELECT
    s.competitor_sku_id,
    s.channel,
    s.external_sku_id,
    s.observed_date,
    s.review_count,
    s.review_count - LAG(s.review_count) OVER (
      PARTITION BY s.competitor_sku_id ORDER BY s.observed_date
    ) AS delta_reviews,
    s.observed_date - LAG(s.observed_date) OVER (
      PARTITION BY s.competitor_sku_id ORDER BY s.observed_date
    ) AS day_gap,
    s.price_krw
  FROM jimscanner_competitor_review_snapshots s
)
SELECT
  d.competitor_sku_id,
  d.channel,
  d.external_sku_id,
  d.observed_date,
  d.review_count,
  d.delta_reviews,
  d.day_gap,
  d.price_krw,
  c.review_rate,
  CASE
    WHEN d.delta_reviews IS NULL OR d.delta_reviews < 0 OR d.day_gap IS NULL OR d.day_gap = 0 THEN NULL
    ELSE ROUND( (d.delta_reviews::numeric / d.day_gap) / NULLIF(c.review_rate, 0) )::int
  END AS estimated_daily_sales,
  CASE
    WHEN d.delta_reviews IS NULL OR d.delta_reviews < 0 OR d.day_gap IS NULL OR d.day_gap = 0 OR d.price_krw IS NULL THEN NULL
    ELSE ROUND( ((d.delta_reviews::numeric / d.day_gap) / NULLIF(c.review_rate, 0)) * d.price_krw )::bigint
  END AS estimated_daily_revenue_krw
FROM diffed d
LEFT JOIN jimscanner_review_calibration c ON c.channel = d.channel;


-- 5) 제품 단위 집계 뷰 (7/30 일 합산, 최근 가속도)
CREATE OR REPLACE VIEW jimscanner_product_sales_estimate AS
WITH base AS (
  SELECT
    cs.product_id,
    ds.competitor_sku_id,
    ds.channel,
    ds.external_sku_id,
    ds.observed_date,
    ds.estimated_daily_sales,
    ds.estimated_daily_revenue_krw
  FROM jimscanner_competitor_daily_sales ds
  JOIN jimscanner_trends_competitor_skus cs ON cs.id = ds.competitor_sku_id
)
SELECT
  product_id,
  SUM(CASE WHEN observed_date >= (now() AT TIME ZONE 'Asia/Seoul')::date - 7  THEN estimated_daily_sales        ELSE 0 END) AS est_sales_7d,
  SUM(CASE WHEN observed_date >= (now() AT TIME ZONE 'Asia/Seoul')::date - 30 THEN estimated_daily_sales        ELSE 0 END) AS est_sales_30d,
  SUM(CASE WHEN observed_date >= (now() AT TIME ZONE 'Asia/Seoul')::date - 7  THEN estimated_daily_revenue_krw  ELSE 0 END) AS est_revenue_7d_krw,
  SUM(CASE WHEN observed_date >= (now() AT TIME ZONE 'Asia/Seoul')::date - 30 THEN estimated_daily_revenue_krw  ELSE 0 END) AS est_revenue_30d_krw,
  -- 최근 14일 가속도: 최근 7일 일평균 ÷ 이전 7일 일평균
  COALESCE(
    SUM(CASE WHEN observed_date >= (now() AT TIME ZONE 'Asia/Seoul')::date - 7  THEN estimated_daily_sales ELSE 0 END)::numeric
    / NULLIF(SUM(CASE WHEN observed_date BETWEEN (now() AT TIME ZONE 'Asia/Seoul')::date - 14 AND (now() AT TIME ZONE 'Asia/Seoul')::date - 8 THEN estimated_daily_sales ELSE 0 END), 0)
  , 1.0) AS accel_ratio_14d,
  COUNT(DISTINCT competitor_sku_id) AS tracked_sku_count,
  MAX(observed_date) AS latest_observed_date
FROM base
GROUP BY product_id;
