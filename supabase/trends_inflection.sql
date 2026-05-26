-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 — score 시계열 2차미분 변곡점 (가속·감속 4사분면)
-- ─────────────────────────────────────────────────────────────
-- 목적: jimscanner_trends_scores 가 매 recompute 마다 누적해 둔 score 시계열에서
--   1차 미분(slope, 7일 회귀 기울기) 과 2차 미분(accel = slope 의 7일 변화량)
--   을 사전계산해 두고 UI 가 4사분면 매핑(가속↑/감속, level↑/↓)으로 사용한다.
-- score_kind: 'final' | 'trend' | 'commerce' | 'supplier' | 'competition'
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_inflection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  -- 'final' | 'trend' | 'commerce' | 'supplier' | 'competition'
  score_kind text NOT NULL,

  -- 최근 점수 (해당 score_kind, 최근 recompute)
  latest_score numeric NOT NULL,

  -- 1차 미분: 최근 7일 회귀 slope (단위: score / day)
  slope_7d numeric NOT NULL DEFAULT 0,

  -- 2차 미분: slope 의 변화량 (= 직전 7일 slope 와의 차이)
  accel_7d numeric NOT NULL DEFAULT 0,

  -- 표본 수 (slope 산출에 쓰인 row 수)
  sample_count int NOT NULL DEFAULT 0,

  -- 사분면: 'accel_up' | 'decel_up' | 'accel_down' | 'decel_down' | 'flat'
  --   accel_up   : slope > 0 AND accel > 0   (가속·상승) → 즉시 진입 큐
  --   decel_up   : slope > 0 AND accel <= 0  (감속·상승) → 정점 임박 회피
  --   accel_down : slope < 0 AND accel < 0   (가속·하락) → 손절
  --   decel_down : slope < 0 AND accel >= 0  (감속·하락) → 반등 후보
  --   flat       : slope ≈ 0
  quadrant text NOT NULL,

  -- 정렬 키: |slope| * |accel|
  rank_score numeric NOT NULL DEFAULT 0,

  computed_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (product_id, score_kind)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_inflection_kind_quadrant
  ON jimscanner_trends_inflection(score_kind, quadrant, rank_score DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_inflection_product
  ON jimscanner_trends_inflection(product_id);

CREATE INDEX IF NOT EXISTS jimscanner_trends_inflection_rank
  ON jimscanner_trends_inflection(rank_score DESC);

ALTER TABLE jimscanner_trends_inflection ENABLE ROW LEVEL SECURITY;
-- service-role 만 (기존 jimscanner_trends_* 정책과 동일)
