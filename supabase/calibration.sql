-- =============================================
-- 추천 사후성과 캘리브레이션 보드 (Post-Pin Outcome Tracker)
-- 핀(pin) 채택 상품의 +30/+60/+90일 실현 성과를 추적해 추천 모델 자신을 학습시킴.
-- =============================================

-- ─────────────────────────────────────────────
-- 1. jimscanner_pin_outcomes — 핀별 사후 성과 시계열
-- ─────────────────────────────────────────────
-- 한 pin (source, keyword) 는 +30/+60/+90 각 1행씩 = 최대 3행.
-- product_id 는 nullable — v3 키워드 핀 (v4 product 매핑 안 된 것) 은 비워둠.
-- predicted_* 는 핀 시점 점수 스냅샷, realized_* 는 checkpoint 시점 실제 관측치.

CREATE TABLE IF NOT EXISTS jimscanner_pin_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 핀 식별 (jimscanner_trends_pins 의 자연키)
  pin_source text NOT NULL,
  pin_keyword text NOT NULL,
  pin_pinned_at timestamptz NOT NULL,
  product_id uuid REFERENCES jimscanner_trends_products(id) ON DELETE SET NULL,

  -- 체크포인트
  checkpoint_days smallint NOT NULL CHECK (checkpoint_days IN (30, 60, 90)),
  observed_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'observed', -- 'observed' | 'missing_data' | 'stale_pin'

  -- 예측 (핀 시점 스냅샷)
  predicted_final_score numeric,
  predicted_trend_score numeric,
  predicted_commerce_score numeric,
  predicted_supplier_score numeric,
  predicted_competition_score numeric,
  predicted_category text,

  -- 실현 (관측치)
  realized_serp_rank int,              -- 1=최상위, NULL=노출 안됨
  realized_search_vol numeric,         -- 월간 검색량 추정 (raw counts)
  realized_supplier_avail numeric,     -- 0~1 (도매 재고 가용성)
  realized_margin_est numeric,         -- 추정 마진 (KRW)
  realized_score numeric,              -- 0~100 — 실현 점수 (4지표 종합)

  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (pin_source, pin_keyword, checkpoint_days)
);

CREATE INDEX IF NOT EXISTS idx_pin_outcomes_observed
  ON jimscanner_pin_outcomes(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pin_outcomes_product
  ON jimscanner_pin_outcomes(product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pin_outcomes_category
  ON jimscanner_pin_outcomes(predicted_category);

ALTER TABLE jimscanner_pin_outcomes ENABLE ROW LEVEL SECURITY;
-- service-role 만. anon 정책 의도적으로 정의하지 않음.


-- ─────────────────────────────────────────────
-- 2. jimscanner_calibration_weights — 학습된 카테고리별 가중치
-- ─────────────────────────────────────────────
-- recompute_scores 가 final_score 산식에 사용. 데이터로 진화.
-- 잔차 회귀(realized_score ~ trend + commerce + supplier + competition) 결과를
-- 카테고리별로 저장. 표본 부족 (n<5) 카테고리는 default 가중치 사용.

CREATE TABLE IF NOT EXISTS jimscanner_calibration_weights (
  category_top text PRIMARY KEY,    -- 'health' | 'living' | 'digital' | '_default'
  w_trend numeric NOT NULL DEFAULT 0.30,
  w_commerce numeric NOT NULL DEFAULT 0.25,
  w_supplier numeric NOT NULL DEFAULT 0.25,
  w_competition numeric NOT NULL DEFAULT 0.20,
  bias numeric NOT NULL DEFAULT 0,
  sample_n int NOT NULL DEFAULT 0,
  residual_rmse numeric,            -- 잔차 RMSE (낮을수록 모델 적합)
  computed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE jimscanner_calibration_weights ENABLE ROW LEVEL SECURITY;

-- 기본 가중치 시드 (recompute_scores 호출 시 fallback)
INSERT INTO jimscanner_calibration_weights (category_top, w_trend, w_commerce, w_supplier, w_competition)
VALUES ('_default', 0.30, 0.25, 0.25, 0.20)
ON CONFLICT (category_top) DO NOTHING;


-- ─────────────────────────────────────────────
-- 3. 뷰: 캘리브레이션 잔차 (UI 가 직접 쿼리)
-- ─────────────────────────────────────────────
CREATE OR REPLACE VIEW jimscanner_calibration_residuals AS
SELECT
  o.id,
  o.pin_source,
  o.pin_keyword,
  o.product_id,
  o.checkpoint_days,
  o.observed_at,
  o.predicted_final_score,
  o.realized_score,
  (COALESCE(o.realized_score, 0) - COALESCE(o.predicted_final_score, 0)) AS residual,
  o.predicted_category,
  o.predicted_trend_score,
  o.predicted_commerce_score,
  o.predicted_supplier_score,
  o.predicted_competition_score,
  o.realized_serp_rank,
  o.realized_supplier_avail
FROM jimscanner_pin_outcomes o
WHERE o.status = 'observed';


-- ─────────────────────────────────────────────
-- 4. RPC: recompute_scores_calibrated
-- ─────────────────────────────────────────────
-- 최신 score row 의 4지표를 카테고리별 학습된 가중치로 재가중해 final_score 갱신.
-- 호출 시점: track-pin-outcomes 마지막 단계 또는 수동.
-- 안전성: 입력은 weights 테이블만 사용. SQL injection 없음.

CREATE OR REPLACE FUNCTION recompute_scores_calibrated()
RETURNS TABLE(category text, updated_count int) AS $$
DECLARE
  default_w record;
BEGIN
  SELECT * INTO default_w FROM jimscanner_calibration_weights WHERE category_top = '_default';

  -- 최신 score row 만 갱신 (product_id 별 MAX(computed_at))
  WITH latest AS (
    SELECT DISTINCT ON (product_id) id, product_id
    FROM jimscanner_trends_scores
    ORDER BY product_id, computed_at DESC
  ),
  weighted AS (
    SELECT
      l.id,
      p.category_top,
      COALESCE(w.w_trend, default_w.w_trend)             AS wt,
      COALESCE(w.w_commerce, default_w.w_commerce)       AS wc,
      COALESCE(w.w_supplier, default_w.w_supplier)       AS ws,
      COALESCE(w.w_competition, default_w.w_competition) AS wcomp,
      COALESCE(w.bias, default_w.bias)                   AS bias,
      s.trend_score, s.commerce_score, s.supplier_score, s.competition_score
    FROM latest l
    JOIN jimscanner_trends_scores s ON s.id = l.id
    JOIN jimscanner_trends_products p ON p.id = l.product_id
    LEFT JOIN jimscanner_calibration_weights w ON w.category_top = p.category_top
  )
  UPDATE jimscanner_trends_scores s
  SET final_score = LEAST(100, GREATEST(0,
        weighted.wt * weighted.trend_score
      + weighted.wc * weighted.commerce_score
      + weighted.ws * weighted.supplier_score
      + weighted.wcomp * weighted.competition_score
      + weighted.bias)),
      score_components = COALESCE(s.score_components, '{}'::jsonb) || jsonb_build_object(
        'calibrated', true,
        'w_trend', weighted.wt,
        'w_commerce', weighted.wc,
        'w_supplier', weighted.ws,
        'w_competition', weighted.wcomp,
        'bias', weighted.bias,
        'recalibrated_at', now()
      )
  FROM weighted
  WHERE s.id = weighted.id;

  RETURN QUERY
    SELECT '_all'::text, (SELECT COUNT(*)::int FROM jimscanner_calibration_weights WHERE category_top <> '_default');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ─────────────────────────────────────────────
-- 롤백
-- ─────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS recompute_scores_calibrated();
-- DROP VIEW IF EXISTS jimscanner_calibration_residuals;
-- DROP TABLE IF EXISTS jimscanner_calibration_weights;
-- DROP TABLE IF EXISTS jimscanner_pin_outcomes CASCADE;
