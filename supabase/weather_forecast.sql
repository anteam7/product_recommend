-- ────────────────────────────────────────────────────────────
-- KMA 기상예보 수집 + 상품-기상 결합 (PR-WEATHER-1, 2026-05-26)
-- ────────────────────────────────────────────────────────────
-- 목적: 단·중기 기상예보(폭염/한파/강수/미세먼지/UV/습도)를 사전 수집해
--       ggsan 카탈로그·트렌드 상품과 매칭, 발주·픽 의사결정에 선행 시그널 제공.
-- 사용처:
--   - scripts/collect-weather-forecast.mjs (KMA → DB 적재)
--   - scripts/classify-weather-tags.mjs    (LLM/룰 기반 weather_tags 부여)
--   - /admin/trend-radar/weather           (14일 타임라인 + 매칭 SKU)
--   - jimscanner_ggsan_recommend RPC (V1 보강 시 weather_boost 가산)
-- ────────────────────────────────────────────────────────────

-- 1) 기상예보 시계열 테이블
-- 각 행은 (지역 × 예보 기준일자) 1건; 14일치 일별 예보를 jsonb daily 배열로.
CREATE TABLE IF NOT EXISTS jimscanner_weather_forecast (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region_code text NOT NULL DEFAULT '11B10101',  -- 기본: 서울 (KMA 단기예보 격자)
  region_name text NOT NULL DEFAULT '서울',
  forecast_base_at timestamptz NOT NULL,          -- 예보 발표 기준시각
  -- 일자별 예보: [{ date: '2026-05-27', tmin: 18, tmax: 28, rain_prob: 60, pm10: 'normal', uv: 7, humidity: 65, alert_tags: ['rain'] }, ...]
  daily jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 활성 경보 태그 (예: ['heat','dust']) — 컴포넌트 빠른 필터링용
  active_tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  raw_payload jsonb,                              -- KMA 원본 응답
  collected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_weather_forecast_region_at
  ON jimscanner_weather_forecast(region_code, forecast_base_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_weather_forecast_active_tags
  ON jimscanner_weather_forecast USING gin (active_tags);

ALTER TABLE jimscanner_weather_forecast ENABLE ROW LEVEL SECURITY;
-- service-role 만 접근.

-- 2) ggsan 상품 / trends 상품에 weather_tags 컬럼 추가
-- weather_tags 형태: { cool: 0.9, heat: 0.0, rain: 0.3, dust: 0.0, uv: 0.4, humidity: 0.6 }
-- 0~1 confidence score. 0.5 이상이면 해당 기상 시그널에 매칭으로 간주.
ALTER TABLE jimscanner_ggsan_products
  ADD COLUMN IF NOT EXISTS weather_tags jsonb;

ALTER TABLE jimscanner_trends_products
  ADD COLUMN IF NOT EXISTS weather_tags jsonb;

CREATE INDEX IF NOT EXISTS jimscanner_ggsan_products_weather_tags
  ON jimscanner_ggsan_products USING gin (weather_tags);
CREATE INDEX IF NOT EXISTS jimscanner_trends_products_weather_tags
  ON jimscanner_trends_products USING gin (weather_tags);

-- 3) 최신 예보 1행 빠른 조회 뷰
CREATE OR REPLACE VIEW jimscanner_weather_forecast_latest AS
SELECT DISTINCT ON (region_code)
  region_code,
  region_name,
  forecast_base_at,
  daily,
  active_tags,
  collected_at
FROM jimscanner_weather_forecast
ORDER BY region_code, forecast_base_at DESC;
