-- 기상예보 연동 수요 회귀 — 2026-05-19
-- KMA 단기예보 일일 적재 + 핀(product) 단위 lag 회귀 결과 저장.
-- run-crons.mjs 에서 fetch-weather-kma → fit-weather-coupling 순차 실행.

-- ─────────────────────────────────────────
-- 1) 일일 기상 적재
CREATE TABLE IF NOT EXISTS jimscanner_weather_daily (
  date date NOT NULL,
  region text NOT NULL,                  -- 'KR' 전국 평균 / 'seoul' 등
  tmin numeric,                          -- 최저기온 (℃)
  tmax numeric,                          -- 최고기온 (℃)
  tavg numeric,                          -- 평균기온 (℃)
  humidity numeric,                      -- 평균 습도 (%)
  precip numeric,                        -- 강수량 합 (mm)
  feels_like numeric,                    -- 체감온도 (℃, 추정)
  forecast boolean NOT NULL DEFAULT false, -- true: 예보 / false: 실측
  payload jsonb,                          -- 원천 응답 일부
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, region, forecast)
);
CREATE INDEX IF NOT EXISTS jimscanner_weather_daily_date
  ON jimscanner_weather_daily(date DESC);
ALTER TABLE jimscanner_weather_daily ENABLE ROW LEVEL SECURITY;
-- service-role 만 접근.

-- ─────────────────────────────────────────
-- 2) 핀(product) ↔ 기상 변수 회귀 결과
--   같은 (product_id, lead_days, weather_var) 조합으로 매 fit 시 새 row append.
--   최신만 보고 싶으면 DISTINCT ON (product_id, lead_days, weather_var) ORDER BY fitted_at DESC.
CREATE TABLE IF NOT EXISTS jimscanner_trends_weather_coupling (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,              -- jimscanner_trends_products.id
  lead_days int NOT NULL,                -- 0,1,2,3,5,7
  weather_var text NOT NULL,             -- 'tmin' / 'tmax' / 'tavg' / 'humidity' / 'precip' / 'feels_like'
  beta numeric NOT NULL,                 -- 회귀계수
  r2 numeric NOT NULL,                   -- 0~1
  n_obs int NOT NULL,                    -- 사용된 일자 수
  intercept numeric,                     -- 회귀 절편 (선택)
  sample jsonb,                          -- 진단용 (예: 최근 7일 예측값 등)
  fitted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jimscanner_trends_weather_coupling_product
  ON jimscanner_trends_weather_coupling(product_id, fitted_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_weather_coupling_r2
  ON jimscanner_trends_weather_coupling(r2 DESC, fitted_at DESC);
ALTER TABLE jimscanner_trends_weather_coupling ENABLE ROW LEVEL SECURITY;
