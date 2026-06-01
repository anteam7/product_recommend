-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 수요 대체(Displacement) 탐지 (2026-06-01)
-- ─────────────────────────────────────────────────────────────
-- 같은 니드 공간(동일 category_mid) 안에서 trend_score 시계열이
-- 음의 상관(한쪽↑·다른쪽↓)을 보이는 '대체 페어'를 적재한다.
--
-- 떠오르는 쪽(rising_id) = 기존 수요를 잠식하며 뜨는 검증된 위탁 후보,
-- 쇠퇴하는 쪽(declining_id) = 소싱 회피 대상.
--
-- 적재: src/app/api/cron/compute-displacement (service-role)
-- 노출 정책: RLS enable + 정책 정의 X = service-role 만 접근.
--   (기존 jimscanner_trends_* 패턴과 동일)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_displacement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  rising_id    uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  declining_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  category_mid text,                  -- 두 상품이 공유하는 니드 공간 (NULL=공출현 클러스터)

  anti_corr   numeric NOT NULL,       -- 피어슨 상관계수 (음수일수록 강한 대체, -1.0~1.0)
  share_shift numeric NOT NULL DEFAULT 0,  -- 점유 이전량 추정 (rising 상승폭 - declining 하락폭 절대값 평균)

  rising_slope    numeric NOT NULL DEFAULT 0,  -- rising 의 trend_score 기울기 (+ 기대)
  declining_slope numeric NOT NULL DEFAULT 0,  -- declining 의 trend_score 기울기 (- 기대)

  window_days int NOT NULL DEFAULT 14,         -- 상관 계산에 쓴 관측 일수
  sample_points int NOT NULL DEFAULT 0,        -- 페어가 공유한 시계열 포인트 수

  -- 미니 라인차트용 두 궤적 직렬화: {"rising":[{t,v}...], "declining":[{t,v}...]}
  trajectories jsonb NOT NULL DEFAULT '{}'::jsonb,

  computed_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (rising_id, declining_id, window_days)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_displacement_recent
  ON jimscanner_trends_displacement(computed_at DESC, anti_corr ASC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_displacement_rising
  ON jimscanner_trends_displacement(rising_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_displacement_declining
  ON jimscanner_trends_displacement(declining_id, computed_at DESC);

ALTER TABLE jimscanner_trends_displacement ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.
