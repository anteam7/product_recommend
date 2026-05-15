-- ─────────────────────────────────────────────────────────────
-- trends v5: Smartstore SERP SKU 실판매 추정 — 2026-05-15
--
-- 각 canonical product (jimscanner_trends_products) 의 대표 검색어로
-- 네이버 스마트스토어 SERP top 10 SKU 의 review_count / rating / price 를
-- 주 1~2회 적재. SQL 뷰로 WoW review 델타를 합산해 "주간 신규 리뷰량" =
-- 실판매 속도 proxy 를 산출한다.
--
-- naver_shopping_insight 와의 차이:
--   - shopping_insight: 카테고리 클릭 (관심)
--   - serp_skus:       SKU 수준 review 누적 (실판매 흐름)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_serp_skus (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  query         text NOT NULL,            -- 실제 사용한 검색어 (대표 alias)
  rank          int NOT NULL,             -- SERP 노출 순위 1~10
  sku_url       text NOT NULL,            -- 상품 상세 url (smartstore 등)
  sku_id        text,                     -- mall product id (있으면)
  seller        text,                     -- mall name
  title         text,
  price         int,                      -- KRW
  review_count  int,                      -- 누적 리뷰 수 (핵심 지표)
  rating        numeric(3,2),             -- 누적 평점 0~5
  captured_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_serp_skus_product_at
  ON jimscanner_serp_skus(product_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_serp_skus_sku_at
  ON jimscanner_serp_skus(sku_url, captured_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_serp_skus_captured_at
  ON jimscanner_serp_skus(captured_at DESC);

ALTER TABLE jimscanner_serp_skus ENABLE ROW LEVEL SECURITY;
-- service_role 만 사용 (어드민 SSR / cron).

-- ─────────────────────────────────────────────────────────────
-- 뷰 1: SKU 단위 WoW 리뷰 델타
--   각 sku_url 에 대해 최근 capture 와 7일 이전 capture 를 짝지어
--   delta_review_7d = 최근 review_count - 직전 review_count.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW jimscanner_serp_sku_velocity AS
WITH ranked AS (
  SELECT
    s.*,
    ROW_NUMBER() OVER (PARTITION BY s.sku_url ORDER BY s.captured_at DESC) AS rn_desc
  FROM jimscanner_serp_skus s
),
latest AS (
  SELECT product_id, sku_url, seller, title, price, review_count, rating, captured_at
  FROM ranked
  WHERE rn_desc = 1
),
prev AS (
  SELECT DISTINCT ON (sku_url)
    sku_url,
    review_count AS prev_review_count,
    captured_at  AS prev_captured_at
  FROM jimscanner_serp_skus
  WHERE captured_at < now() - interval '5 days'
  ORDER BY sku_url, captured_at DESC
)
SELECT
  l.product_id,
  l.sku_url,
  l.seller,
  l.title,
  l.price,
  l.review_count,
  l.rating,
  l.captured_at,
  p.prev_review_count,
  p.prev_captured_at,
  GREATEST(COALESCE(l.review_count, 0) - COALESCE(p.prev_review_count, 0), 0) AS delta_review_7d
FROM latest l
LEFT JOIN prev p USING (sku_url);

-- ─────────────────────────────────────────────────────────────
-- 뷰 2: product 단위 실판매 속도 proxy
--   product_id 별 SKU 들의 주간 신규 리뷰량 합산 + SKU 수 + 평균가.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW jimscanner_serp_product_velocity AS
SELECT
  v.product_id,
  COUNT(*)::int                                           AS sku_count,
  SUM(v.delta_review_7d)::int                             AS weekly_new_reviews,
  ROUND(AVG(NULLIF(v.price, 0)))::int                     AS avg_price,
  ROUND(AVG(NULLIF(v.rating, 0))::numeric, 2)             AS avg_rating,
  SUM(COALESCE(v.review_count, 0))::int                   AS total_reviews,
  MAX(v.captured_at)                                      AS last_captured_at
FROM jimscanner_serp_sku_velocity v
GROUP BY v.product_id;
