-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — Analog Overlay 결과 라벨 테이블
-- (2026-05-17, "유사 과거 케이스 결과 매칭 보드")
-- ─────────────────────────────────────────────────────────────
-- 목적:
--   각 canonical 상품의 "그 이후 30일" 결말(winner/sideways/decay/dead)을
--   사전 계산해서 보관. analog top-k 검색 시 join 만으로 결과 라벨을 보여줌.
--
-- 산출 정의 (recompute-analog-outcomes.mjs 가 dirty-write):
--   - peak_final           : 최근 90일 final_score 의 최대값
--   - days_to_peak         : 첫 score row → peak 까지의 일수
--   - post_peak_drawdown_pct: peak 이후 점수 하락률 (0~100)
--   - outcome_label        : winner | sideways | decay | dead
--       winner   : peak_final >= 70 AND drawdown < 30
--       sideways : peak_final 40~70 AND |drawdown| < 25
--       decay    : peak_final >= 50 AND drawdown >= 30
--       dead     : peak_final < 40 OR drawdown >= 60
--   - history_days         : score 시계열 보유 기간 (산출 정확도 판단용)
--
-- D5: 운영자 전용 / RLS enable (service-role 만 read+write).
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_analog_outcomes (
  product_id uuid PRIMARY KEY REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  peak_final numeric NOT NULL,
  days_to_peak int NOT NULL,
  post_peak_drawdown_pct numeric NOT NULL,
  outcome_label text NOT NULL CHECK (outcome_label IN ('winner','sideways','decay','dead','unknown')),
  history_days int NOT NULL DEFAULT 0,

  -- 라벨 산출 시점 (cron 마다 갱신)
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_analog_outcomes_label
  ON jimscanner_trends_analog_outcomes(outcome_label, peak_final DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_analog_outcomes_recent
  ON jimscanner_trends_analog_outcomes(computed_at DESC);

ALTER TABLE jimscanner_trends_analog_outcomes ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.
