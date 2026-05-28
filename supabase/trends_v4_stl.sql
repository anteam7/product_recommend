-- ────────────────────────────────────────────────────────────
-- STL 계절성 분해 — 시즌 외 비정상 상승 게이트 보드 (2026-05-28)
-- ────────────────────────────────────────────────────────────
-- 목적: jimscanner_trends_keywords / jimscanner_market_raw 시계열을
-- trend·seasonal·residual 로 분해해 "같은 달 평년 시즌 효과 대비 +Nσ"
-- 키워드만 분리. nightly cron(scripts/stl-decompose.mjs) 이 채운다.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_stl (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword text NOT NULL,
  source text NOT NULL,                       -- 'naver_search_trend' | 'naver_shopping_insight' | 'naver_tvtime' | ...
  period int NOT NULL DEFAULT 7,              -- 시즌 주기 (일 단위) — 기본 주간 7
  window_days int NOT NULL DEFAULT 90,        -- fit 윈도우 (90/180/365)
  observed numeric,                           -- 가장 최근 raw 값 (정규화 후)
  trend numeric,                              -- 트렌드 성분 (moving average 기반)
  seasonal numeric,                           -- 시즌 성분 (period-aligned average)
  residual numeric,                           -- 잔차 (observed - trend - seasonal)
  trend_z numeric,                            -- 트렌드 z-score (윈도우 평균/표준편차 기준)
  seasonal_phase numeric,                     -- 시즌 진폭 — abs(seasonal)/sigma
  residual_z numeric,                         -- 잔차 z-score (탈시즌 이상 상승 시그널)
  in_season boolean,                          -- 현재 시즌 안인지 — seasonal > 0
  anomaly_label text,                         -- 'in_season_anomaly' | 'out_of_season_anomaly' | 'in_season_normal' | 'out_of_season_normal'
  n_samples int NOT NULL DEFAULT 0,           -- fit 에 사용된 관측 수
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_stl_keyword_at
  ON jimscanner_trends_stl(keyword, computed_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_stl_source_at
  ON jimscanner_trends_stl(source, computed_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_stl_residual_recent
  ON jimscanner_trends_stl(residual_z DESC, computed_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_stl_anomaly_recent
  ON jimscanner_trends_stl(anomaly_label, computed_at DESC)
  WHERE anomaly_label IN ('out_of_season_anomaly', 'in_season_anomaly');

ALTER TABLE jimscanner_trends_stl ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role) 전용. RLS 정책 없음 = 우회 키만 접근.
