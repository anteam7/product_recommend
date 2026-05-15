-- ────────────────────────────────────────────────────────────
-- PR-4.painpoints: 경쟁 SKU 리뷰 페인포인트 마이닝 (2026-05-15)
-- ────────────────────────────────────────────────────────────
-- 상위 점수 트렌드 상품마다 네이버 쇼핑 상위 3~5개 경쟁 SKU 리뷰를
-- 수집·LLM 분류하여 6대 카테고리(배송/품질/사이즈/향맛/효능/가격)로 적재.
-- 차별화 스펙 도출용 갭 매트릭스(jimscanner_painpoint_gap_matrix) 노출.
-- 적재: scripts/mine-review-painpoints.mjs (run-crons.mjs 끝단)
-- 노출: /admin/trend-radar/products/[id]
-- ────────────────────────────────────────────────────────────

-- 1) 페인포인트 raw 적재 테이블
CREATE TABLE IF NOT EXISTS jimscanner_trends_review_painpoints (
  id bigserial PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  competitor_sku text NOT NULL,             -- 경쟁 SKU 명/ID (네이버 쇼핑 productId or 표시명)
  competitor_url text,                       -- 네이버 쇼핑 상품 URL (있으면)
  painpoint_category text NOT NULL,         -- shipping|quality|size|flavor|efficacy|price|other
  quote text NOT NULL,                       -- 대표 인용 (≤200자)
  severity smallint NOT NULL DEFAULT 3,     -- 1(약함) ~ 5(심각)
  mentions int NOT NULL DEFAULT 1,          -- 해당 SKU 리뷰 중 같은 페인 인용 횟수
  sentiment smallint NOT NULL DEFAULT -1,   -- -2 매우부정 ~ +2 매우긍정 (대부분 음수)
  source text NOT NULL DEFAULT 'naver_shopping_review',
  collected_at timestamptz NOT NULL DEFAULT now(),
  llm_model text,
  CONSTRAINT jimscanner_trends_review_painpoints_severity_chk
    CHECK (severity BETWEEN 1 AND 5),
  CONSTRAINT jimscanner_trends_review_painpoints_sentiment_chk
    CHECK (sentiment BETWEEN -2 AND 2),
  CONSTRAINT jimscanner_trends_review_painpoints_category_chk
    CHECK (painpoint_category IN ('shipping','quality','size','flavor','efficacy','price','other'))
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_review_painpoints_product_idx
  ON jimscanner_trends_review_painpoints(product_id);

CREATE INDEX IF NOT EXISTS jimscanner_trends_review_painpoints_product_cat_idx
  ON jimscanner_trends_review_painpoints(product_id, painpoint_category);

CREATE INDEX IF NOT EXISTS jimscanner_trends_review_painpoints_collected_idx
  ON jimscanner_trends_review_painpoints(collected_at DESC);

ALTER TABLE jimscanner_trends_review_painpoints ENABLE ROW LEVEL SECURITY;

-- 동일 (product_id, competitor_sku, painpoint_category, quote) 중복 방지
CREATE UNIQUE INDEX IF NOT EXISTS jimscanner_trends_review_painpoints_uq
  ON jimscanner_trends_review_painpoints(product_id, competitor_sku, painpoint_category, md5(quote));

COMMENT ON TABLE jimscanner_trends_review_painpoints IS
  '경쟁 SKU 리뷰에서 추출한 페인포인트. 차별화 스펙 도출용 (위탁 상품 의사결정).';

-- 2) 마이닝 진행 상태 보조 테이블 (상품별 마지막 수집 시점)
CREATE TABLE IF NOT EXISTS jimscanner_trends_painpoint_runs (
  product_id uuid PRIMARY KEY REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  last_mined_at timestamptz NOT NULL DEFAULT now(),
  competitor_count int NOT NULL DEFAULT 0,
  painpoint_count int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'ok',
  error_message text
);

ALTER TABLE jimscanner_trends_painpoint_runs ENABLE ROW LEVEL SECURITY;

-- 3) 갭 매트릭스 RPC — 카테고리×빈도 + 대표 인용 (severity 가중)
CREATE OR REPLACE FUNCTION jimscanner_painpoint_gap_matrix(p_product_id uuid)
RETURNS TABLE (
  painpoint_category text,
  total_mentions int,
  weighted_severity numeric,
  competitor_count int,
  top_quotes jsonb
)
LANGUAGE sql
STABLE
AS $$
  WITH base AS (
    SELECT
      painpoint_category,
      competitor_sku,
      quote,
      severity,
      mentions,
      sentiment,
      collected_at
    FROM jimscanner_trends_review_painpoints
    WHERE product_id = p_product_id
  ),
  ranked AS (
    SELECT
      b.*,
      ROW_NUMBER() OVER (
        PARTITION BY b.painpoint_category
        ORDER BY b.severity * b.mentions DESC, b.collected_at DESC
      ) AS rk
    FROM base b
  ),
  agg AS (
    SELECT
      painpoint_category,
      SUM(mentions)::int AS total_mentions,
      ROUND(AVG(severity * mentions)::numeric, 2) AS weighted_severity,
      COUNT(DISTINCT competitor_sku)::int AS competitor_count
    FROM base
    GROUP BY painpoint_category
  ),
  top3 AS (
    SELECT
      painpoint_category,
      jsonb_agg(
        jsonb_build_object(
          'quote', quote,
          'competitor_sku', competitor_sku,
          'severity', severity,
          'mentions', mentions,
          'sentiment', sentiment
        )
        ORDER BY severity * mentions DESC
      ) AS top_quotes
    FROM ranked
    WHERE rk <= 3
    GROUP BY painpoint_category
  )
  SELECT
    agg.painpoint_category,
    agg.total_mentions,
    agg.weighted_severity,
    agg.competitor_count,
    COALESCE(top3.top_quotes, '[]'::jsonb) AS top_quotes
  FROM agg
  LEFT JOIN top3 USING (painpoint_category)
  ORDER BY agg.total_mentions DESC, agg.weighted_severity DESC;
$$;

COMMENT ON FUNCTION jimscanner_painpoint_gap_matrix IS
  '한 product 의 경쟁 SKU 리뷰 페인포인트를 6대 카테고리 갭 매트릭스로 반환.';
