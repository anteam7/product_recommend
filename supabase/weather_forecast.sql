-- 기상예보 충격 × 카테고리 수요 예측 선점 보드
-- KMA 단기·중기 예보를 적재하고, 카테고리×기상변수 elasticity 와 결합해
--   7~10일 선행 demand surge 큐를 만든다.
--
-- 적용:
--   PGPASSWORD=... psql "host=...pooler.supabase.co port=6543 dbname=postgres user=..." -f supabase/weather_forecast.sql
--
-- 2026-05-28 — Phase 0 (data scaffolding + UI 보드)

-- ─────────────────────────────────────────
-- 1) 기상예보 스냅샷 — 한 row = (region, target_date, captured_at)
CREATE TABLE IF NOT EXISTS jimscanner_weather_forecast (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region text NOT NULL DEFAULT 'KR',         -- 'KR' (전국 평균) / '서울' / '부산' …
  target_date date NOT NULL,                 -- 예보 대상일 (예: 2026-06-04)
  lead_days int NOT NULL,                    -- target_date - today (수집시점 기준)
  -- 단기/중기 핵심 변수
  temp_min numeric,                          -- 일 최저 (°C)
  temp_max numeric,                          -- 일 최고 (°C)
  temp_anomaly numeric,                      -- 평년 대비 편차 (°C)
  precipitation_mm numeric,                  -- 강수량 (mm)
  precipitation_prob numeric,                -- 강수확률 (0~100)
  pm10 numeric,                              -- 미세먼지 µg/m³
  pm25 numeric,                              -- 초미세먼지 µg/m³
  heat_wave boolean DEFAULT false,           -- 폭염특보 가능성
  cold_wave boolean DEFAULT false,           -- 한파특보 가능성
  typhoon boolean DEFAULT false,             -- 태풍 영향권
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,    -- KMA 원천 응답
  source text NOT NULL DEFAULT 'kma',        -- 'kma' / 'mock' / 'manual'
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (region, target_date, captured_at)
);
CREATE INDEX IF NOT EXISTS jimscanner_weather_forecast_target
  ON jimscanner_weather_forecast (target_date, region);
CREATE INDEX IF NOT EXISTS jimscanner_weather_forecast_captured
  ON jimscanner_weather_forecast (captured_at DESC);

ALTER TABLE jimscanner_weather_forecast ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────
-- 2) 카테고리×기상변수 elasticity — 회귀계수 캐시
-- 과거 naver_search_trend / shopping_insight 시계열을 기상 변수에 회귀시켜
-- 카테고리별 (변수 → 수요) 탄력성을 저장. 주 1회 재계산.
CREATE TABLE IF NOT EXISTS jimscanner_weather_category_elasticity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,                    -- '쿨매트' / '제습기' / '우산' …
  weather_var text NOT NULL,                 -- 'temp_max' / 'temp_anomaly' / 'precipitation_mm' / 'pm10' / 'heat_wave' / 'cold_wave'
  coefficient numeric NOT NULL,              -- 회귀계수 (수요 변화율 per 단위)
  r_squared numeric,                         -- 모형 적합도
  sample_size int,                           -- 샘플 일수
  lead_days int NOT NULL DEFAULT 3,          -- 기상 → 수요 lead time (보통 3~5일 선행)
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category, weather_var, lead_days)
);
CREATE INDEX IF NOT EXISTS jimscanner_weather_elasticity_cat
  ON jimscanner_weather_category_elasticity (category);

ALTER TABLE jimscanner_weather_category_elasticity ENABLE ROW LEVEL SECURITY;

-- 부트스트랩 seed — 외생충격 휴리스틱 계수 (Phase 0).
-- weather-demand-forecast.mjs 가 회귀로 덮어쓰기 전까지 임시 가동에 사용.
INSERT INTO jimscanner_weather_category_elasticity
  (category, weather_var, coefficient, r_squared, sample_size, lead_days)
VALUES
  -- 폭염 → 쿨링 surge
  ('쿨매트',       'temp_max',        0.65, NULL, 0, 3),
  ('휴대선풍기',   'temp_max',        0.55, NULL, 0, 3),
  ('아이스조끼',   'heat_wave',       0.80, NULL, 0, 3),
  ('얼음정수기',   'temp_max',        0.40, NULL, 0, 3),
  ('차량용선풍기', 'temp_max',        0.45, NULL, 0, 3),
  -- 한파 → 방한 surge
  ('전기요',       'cold_wave',       0.70, NULL, 0, 3),
  ('온수매트',     'temp_min',       -0.55, NULL, 0, 3),
  ('히터',         'temp_min',       -0.50, NULL, 0, 3),
  ('패딩',         'cold_wave',       0.65, NULL, 0, 3),
  -- 강수 → 우산/방수
  ('우산',         'precipitation_mm',  0.60, NULL, 0, 2),
  ('레인부츠',     'precipitation_mm',  0.45, NULL, 0, 3),
  ('차량용와이퍼', 'precipitation_mm',  0.30, NULL, 0, 3),
  -- 미세먼지
  ('공기청정기',   'pm25',            0.55, NULL, 0, 2),
  ('마스크',       'pm10',            0.50, NULL, 0, 2),
  ('마스크',       'pm25',            0.45, NULL, 0, 2),
  -- 태풍
  ('방수포',       'typhoon',         0.40, NULL, 0, 4),
  ('휴대용배터리', 'typhoon',         0.35, NULL, 0, 4)
ON CONFLICT (category, weather_var, lead_days) DO NOTHING;

-- ─────────────────────────────────────────
-- 3) 예측된 수요 surge — 일자×카테고리 단위
-- weather-demand-forecast.mjs 가 forecast × elasticity 를 곱해 채움.
CREATE TABLE IF NOT EXISTS jimscanner_weather_demand_forecast (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_date date NOT NULL,                 -- 수요 surge 예상일
  category text NOT NULL,
  surge_score numeric NOT NULL,              -- elasticity × normalized forecast (0~10 scale)
  drivers jsonb NOT NULL DEFAULT '[]'::jsonb,-- [{var:'temp_max', value:34, coef:0.65, contribution:1.7}, ...]
  recommend_publish_date date,               -- 발행 권장일 (target_date - lead_days)
  ggsan_match_count int DEFAULT 0,           -- ggsan 카탈로그에서 매칭되는 SKU 수
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_date, category, computed_at)
);
CREATE INDEX IF NOT EXISTS jimscanner_weather_demand_target
  ON jimscanner_weather_demand_forecast (target_date, surge_score DESC);
CREATE INDEX IF NOT EXISTS jimscanner_weather_demand_category
  ON jimscanner_weather_demand_forecast (category, target_date);

ALTER TABLE jimscanner_weather_demand_forecast ENABLE ROW LEVEL SECURITY;
