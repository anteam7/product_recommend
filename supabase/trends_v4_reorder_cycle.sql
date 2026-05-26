-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — Reorder Cadence 자동 검출 (2026-05-26)
-- ─────────────────────────────────────────────────────────────
-- Naver search_trend·shopping_insight 일별 시계열에 ACF(자기상관)를
-- 돌려 product/keyword 별 자연 재구매 주기를 추정.
-- LTV proxy (가격 × 12개월 ÷ cycle_days) 로 진성 소모재(consumable)
-- vs 1회성 hype SKU 분리. classify-trends-llm cron 직후 호출.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_reorder_cycle (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  source text NOT NULL,                 -- 'naver_search_trend' | 'naver_shopping_insight' | 'aggregate'
  cycle_days int NOT NULL CHECK (cycle_days >= 1 AND cycle_days <= 365),
  peak_strength numeric NOT NULL CHECK (peak_strength >= -1 AND peak_strength <= 1),
  confidence numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  p_value numeric,                      -- approximate (Bartlett / large-N gaussian)

  segment text NOT NULL,                -- 'consumable' (≤45d) | 'repeatable' (46~120d) | 'durable' (>120d)

  series_length int NOT NULL DEFAULT 0,
  series_start date,
  series_end date,

  -- ACF 상위 lag 값들 (디버그 + 시각화). [{lag, acf}, ...]
  acf_top_lags jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- LTV proxy (있으면). price_krw × (365 / cycle_days)
  ltv_proxy_krw numeric,
  ltv_basis_price numeric,

  computed_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (product_id, source)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_reorder_cycle_product
  ON jimscanner_trends_reorder_cycle(product_id);

CREATE INDEX IF NOT EXISTS jimscanner_trends_reorder_cycle_segment
  ON jimscanner_trends_reorder_cycle(segment, confidence DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_reorder_cycle_recent
  ON jimscanner_trends_reorder_cycle(computed_at DESC);

ALTER TABLE jimscanner_trends_reorder_cycle ENABLE ROW LEVEL SECURITY;
-- service-role 만 (RLS 정책 정의 X) — 기존 trends_v4 패턴 동일.
