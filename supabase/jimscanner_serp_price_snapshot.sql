-- ─────────────────────────────────────────────────────────────
-- SERP 가격분산 알파 — 가격형성 비효율 진입 게이트 (2026-05-25)
-- ─────────────────────────────────────────────────────────────
-- 후보 핀 키워드별로 Naver 쇼핑 SERP top 20~30 리스팅 판매가를
-- 주기 수집해 CV, IQR/median, min/max 갭을 산출.
-- high-CV (앵커링 미형성) = pricing power 여지, low-CV = commodity.
-- 관련 보드: /admin/trend-radar/price-dispersion
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_serp_price_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  keyword text NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT now(),

  -- 원 raw: [{title, price, mallName, link}, ...]
  prices jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- 통계 (cron 수집 시 계산해서 저장 — 보드에서 즉시 사용)
  n_listings int NOT NULL DEFAULT 0,
  mean_price numeric,
  median_price numeric,
  p25_price numeric,
  p75_price numeric,
  min_price numeric,
  max_price numeric,
  stddev_price numeric,
  cv numeric,                 -- σ/μ (coefficient of variation)
  iqr_ratio numeric,          -- (p75 - p25) / median
  minmax_gap_ratio numeric,   -- (max - min) / median

  -- 어느 카테고리/핀과 연결되는지 (옵션)
  product_id uuid REFERENCES jimscanner_trends_products(id) ON DELETE SET NULL,
  category_top text,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_serp_price_snapshot_keyword_at
  ON jimscanner_serp_price_snapshot(keyword, collected_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_serp_price_snapshot_cv_at
  ON jimscanner_serp_price_snapshot(cv DESC, collected_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_serp_price_snapshot_product
  ON jimscanner_serp_price_snapshot(product_id, collected_at DESC);

ALTER TABLE jimscanner_serp_price_snapshot ENABLE ROW LEVEL SECURITY;
-- service-role only (어드민/cron 전용)
