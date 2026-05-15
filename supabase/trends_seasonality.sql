-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 — 계절성·신규성 분해 (2026-05-15)
-- ─────────────────────────────────────────────────────────────
-- 목적: jimscanner_trends_keywords 시계열을 product_id 별로
--       연-주(年-週) 단위 베이스라인으로 분해하여
--       매년 반복되는 시즌 스파이크 vs 진짜 신규 트렌드를 분리한다.
--
-- 입력: jimscanner_trends_keywords (source IN ('naver_search_trend',
--                                              'naver_shopping_insight'))
--       → jimscanner_trends_aliases 로 product_id 매핑
-- 출력: jimscanner_trends_seasonality (product_id, year, week_of_year,
--                                      value, baseline_mean, baseline_std,
--                                      novelty_z, seasonality_recurrence)
--
-- 산출 시점: 매일 KST 03:00 (classify-trends-llm 직후, run-crons 마지막 단계)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_seasonality (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  year int NOT NULL,
  week_of_year int NOT NULL,            -- 1~53 (ISO week)

  value numeric NOT NULL,                -- 해당 (year, week) 의 평균 volume_relative
  sample_count int NOT NULL DEFAULT 0,   -- 해당 주차 누적 row 수 (anti-noise)

  -- 동주차 과거 평균/표준편차 (현재 (year, week) 제외한 과거 same-week)
  baseline_mean numeric,
  baseline_std numeric,
  baseline_years int NOT NULL DEFAULT 0, -- 베이스라인 산출에 쓰인 과거 연도 수

  novelty_z numeric,                     -- (value - baseline_mean) / std. NULL=베이스라인 부족
  seasonality_recurrence numeric,        -- 0~1. 동주차 평균/연중 평균 비율 정규화.

  computed_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (product_id, year, week_of_year)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_seasonality_product_at
  ON jimscanner_trends_seasonality(product_id, year DESC, week_of_year DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_seasonality_recurrence
  ON jimscanner_trends_seasonality(seasonality_recurrence DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS jimscanner_trends_seasonality_novelty
  ON jimscanner_trends_seasonality(novelty_z DESC NULLS LAST);

ALTER TABLE jimscanner_trends_seasonality ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만. 정책 정의 X = service-role 만 접근.
