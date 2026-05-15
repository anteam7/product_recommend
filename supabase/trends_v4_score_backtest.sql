-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 점수 백테스트 & 가중치 캘리브레이션
-- ─────────────────────────────────────────────────────────────
-- 매일 1회 30/14/7일 전 jimscanner_trends_scores 스냅샷을 잡고
-- 해당 baseline 이후 기간의 실제 outcome (aliases 증가, supplier 신규,
-- naver_tvtime push, search_trend volume_relative 상승) 을 측정하여
-- hit 판정. 이를 통해 4점수 + final_score 의 precision/recall 추적.
-- 어드민: /admin/trend-radar/calibration
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_score_backtest (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  -- 베이스라인 시점 (스냅샷을 잡은 과거 시각)
  baseline_at timestamptz NOT NULL,

  -- 베이스라인 시점의 final_score (정밀도 회귀에 사용)
  baseline_final numeric NOT NULL,

  -- 베이스라인 시점의 4점수 + 컴포넌트 디테일 (가중치 시뮬레이션용)
  -- 예: {"trend":..,"commerce":..,"supplier":..,"competition":..,"components":{...}}
  baseline_components jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- 평가 호라이즌 (7 / 14 / 30 일)
  horizon_days int NOT NULL,

  -- 호라이즌 만료 시점에 측정한 실제 시그널 증분
  -- 예: {"alias_delta":3,"supplier_new":1,"tv_push":2,"volume_lift_pct":42.5}
  outcome_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- hit 판정: outcome_metrics 가 정의된 임계치 통과 시 true
  -- (스크립트 측 정의: alias_delta>=2 OR supplier_new>=1 OR tv_push>=1 OR volume_lift_pct>=30)
  hit boolean NOT NULL DEFAULT false,

  evaluated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (product_id, baseline_at, horizon_days)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_score_backtest_baseline_horizon
  ON jimscanner_trends_score_backtest(baseline_at DESC, horizon_days);

CREATE INDEX IF NOT EXISTS jimscanner_trends_score_backtest_final_hit
  ON jimscanner_trends_score_backtest(horizon_days, baseline_final DESC, hit);

CREATE INDEX IF NOT EXISTS jimscanner_trends_score_backtest_evaluated
  ON jimscanner_trends_score_backtest(evaluated_at DESC);

ALTER TABLE jimscanner_trends_score_backtest ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만 접근.
