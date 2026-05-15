-- 트렌드 라이프사이클 5단계 분류 — 2026-05-15
-- 각 canonical product 의 jimscanner_trends_scores 시계열로
-- final_score 의 slope·곡률·z-score 를 산출해 단계 라벨을 부여한다.
--
-- 단계:
--   emerging  🌱  최근 z>1, slope_7d>0, slope_28d 미정 (히스토리 짧음)
--   rising    🚀  slope_7d>0, slope_28d>0, 최근 z>0
--   peak      ⭐  최근 점수 절댓값 상위, slope_7d 작거나 음전환 직전
--   declining 📉  slope_7d<0, peak_lag_days >= 7
--   dormant   💤  최근 점수 낮음 + slope_7d|slope_28d 모두 0 근처

CREATE TABLE IF NOT EXISTS jimscanner_trends_lifecycle (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('emerging','rising','peak','declining','dormant')),
  -- 산출값
  latest_score numeric NOT NULL,
  slope_7d numeric NOT NULL DEFAULT 0,       -- 최근 7일 final_score 일평균 변화량
  slope_28d numeric NOT NULL DEFAULT 0,      -- 최근 28일 일평균 변화량
  z_recent numeric NOT NULL DEFAULT 0,       -- 최근 7일 평균의 전체 시계열 대비 z-score
  peak_score numeric NOT NULL DEFAULT 0,     -- 시계열 최고점
  peak_lag_days int NOT NULL DEFAULT 0,      -- 최고점 이후 경과일
  sample_count int NOT NULL DEFAULT 0,       -- 점수 시계열 row 수
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_lifecycle_product_at
  ON jimscanner_trends_lifecycle(product_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_lifecycle_stage_at
  ON jimscanner_trends_lifecycle(stage, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_lifecycle_latest
  ON jimscanner_trends_lifecycle(computed_at DESC);

ALTER TABLE jimscanner_trends_lifecycle ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role) 만 사용.
