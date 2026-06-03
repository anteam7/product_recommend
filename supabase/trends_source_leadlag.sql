-- 출처 간 리드-랙 선행지표 — 2026-06-04
-- jimscanner_trends_keywords 에서 같은(정규화) 키워드가 2개 이상 출처에 등장한 케이스를 모아,
-- 출처 쌍별 '첫 등장 시간차(lead-lag)'를 집계한다.
--   source_a 가 source_b 를 median_lag_hours 만큼 선행(>0) — 즉 a 가 먼저 신호를 줌.
--   lead_winrate = 공유 키워드 중 a 가 b 보다 먼저 등장한 비율 (0~1).
-- 집계 스크립트: scripts/compute-source-leadlag.mjs (run-crons.mjs 막바지 단계).

CREATE TABLE IF NOT EXISTS jimscanner_trends_source_leadlag (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_a text NOT NULL,                 -- 선행(리드) 출처
  source_b text NOT NULL,                 -- 후행(랙) 출처
  median_lag_hours numeric NOT NULL,      -- median(first_b - first_a) in hours; >0 이면 a 가 b 를 선행
  mean_lag_hours numeric,                 -- 참고용 평균 시차
  sample_n int NOT NULL,                  -- 두 출처에 모두 등장한 공유 키워드 수
  lead_winrate numeric NOT NULL,          -- a 가 b 보다 먼저 등장한 비율 0~1
  window_days int NOT NULL DEFAULT 60,    -- 집계 대상 기간
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_source_leadlag_computed_at
  ON jimscanner_trends_source_leadlag(computed_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_source_leadlag_pair
  ON jimscanner_trends_source_leadlag(source_a, source_b, computed_at DESC);

ALTER TABLE jimscanner_trends_source_leadlag ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만 접근.
