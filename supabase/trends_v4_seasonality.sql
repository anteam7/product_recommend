-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 계절성 분해 (Seasonality, 2026-05-19)
-- ─────────────────────────────────────────────────────────────
-- jimscanner_trends_seasonality: product 또는 category 레벨의 월별
-- seasonal_index (장기 트렌드 제거 후 정규화). 위탁 셀러가 비수기
-- 바닥에서 소싱하고 성수기 직전 진입하는 사이클을 시각화.
--
-- - subject_kind = 'product' | 'category'
--   product 일 때만 product_id 채움. category 일 때는 category_key
--   (예: 'health' 같은 category_top, 혹은 'naver:50000003' 같은 외부 키)
-- - period_month 1..12 (KST 기준 캘린더 월). 한 row 당 12개 row 묶음.
-- - seasonal_index 0.0 ~ ~2.0 (1.0 = 연평균).
--   trend(장기 추세) 제거 후, 월별 평균을 연중 평균으로 정규화.
-- - amp_ratio = max(seasonal_index)/min(seasonal_index)
-- - peak_month / trough_month: 1..12
-- - fit_quality 0~1: 24개월 중 실제 사용된 개월수 / 24 (데이터 충분도)
-- - lead_time_days_default: 권장 소싱 리드타임 (배대지·1688 평균)
-- - source_payload: 디버깅용 월별 평균/std/사용 row 수 등
--
-- 노출 정책: service-role only (기존 v4 패턴).
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_seasonality (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  subject_kind text NOT NULL CHECK (subject_kind IN ('product','category')),
  product_id uuid REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  category_key text,                  -- subject_kind='category' 일 때 (예: 'health', 'living', 'digital')

  period_month int NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  seasonal_index numeric NOT NULL,    -- 0.0 ~ ~2.0
  sample_count int NOT NULL DEFAULT 0,

  -- 12 row 묶음의 메타 (모든 row 에 동일 값 복제 — UI 조회 단순화)
  peak_month int CHECK (peak_month BETWEEN 1 AND 12),
  trough_month int CHECK (trough_month BETWEEN 1 AND 12),
  amp_ratio numeric,                  -- peak/trough
  fit_quality numeric NOT NULL DEFAULT 0,   -- 0~1
  lead_time_days_default int NOT NULL DEFAULT 21,
  inherited_from_category boolean NOT NULL DEFAULT false,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,

  computed_at timestamptz NOT NULL DEFAULT now(),

  -- subject 단위 유니크: 같은 subject 의 같은 month 는 1 row.
  CONSTRAINT seasonality_subject_check
    CHECK ( (subject_kind = 'product' AND product_id IS NOT NULL AND category_key IS NULL)
         OR (subject_kind = 'category' AND category_key IS NOT NULL AND product_id IS NULL) )
);

CREATE UNIQUE INDEX IF NOT EXISTS jimscanner_trends_seasonality_product_month
  ON jimscanner_trends_seasonality(product_id, period_month)
  WHERE subject_kind = 'product';

CREATE UNIQUE INDEX IF NOT EXISTS jimscanner_trends_seasonality_category_month
  ON jimscanner_trends_seasonality(category_key, period_month)
  WHERE subject_kind = 'category';

CREATE INDEX IF NOT EXISTS jimscanner_trends_seasonality_computed_at
  ON jimscanner_trends_seasonality(computed_at DESC);

ALTER TABLE jimscanner_trends_seasonality ENABLE ROW LEVEL SECURITY;
-- service-role only — 정책 정의 X (기존 v4 패턴).
