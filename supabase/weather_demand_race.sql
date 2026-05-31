-- ─────────────────────────────────────────────────────────────
-- 기상 연동 수요 급등 선점 보드 — 폭염·한파·미세먼지 이벤트 레이스
-- (product_discovery, 2026-06-01)
-- ─────────────────────────────────────────────────────────────
-- 외부 인과 드라이버 '날씨'를 트렌드 레이더에 추가.
-- 한국 위탁 시장은 폭염/한파/장마/황사처럼 예보 가능한 단기 이벤트에
-- 특정 SKU 수요가 폭증한다. ggsan 리드타임(1~3일) < 예보 신뢰 구간(7~10일)
-- 이므로 '지금 소싱하면 이벤트 전 도착 가능' 선점이 실제로 가능하다.
--
-- 노출 정책: 기존 jimscanner_trends_* 패턴과 동일.
--   모든 테이블 RLS enable + 정책 정의 X = service-role(어드민·cron)만 접근.
-- ─────────────────────────────────────────────────────────────


-- 1) 기상청(KMA) 단기예보 적재 — 지역·예보일 단위 1 row
--    같은 (region, forecast_date) 가 매 수집마다 갱신되도록 upsert 한다.
CREATE TABLE IF NOT EXISTS jimscanner_weather_forecast (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  region        text NOT NULL,            -- 'seoul' | 'busan' 등 운영 지역 코드
  region_label  text,                     -- 사람이 읽는 이름 ('서울')
  forecast_date date NOT NULL,            -- 예보 대상 날짜 (KST)

  temp_min   numeric,                     -- 일 최저기온 (°C, KMA TMN)
  temp_max   numeric,                     -- 일 최고기온 (°C, KMA TMX)
  precip_prob numeric,                    -- 강수확률 % (KMA POP, 일중 최댓값)
  precip_mm  numeric,                     -- 예상 강수량 mm (KMA PCP 합)
  pm10       numeric,                     -- 미세먼지 예보 (㎍/㎥, 보조 소스)
  pm25       numeric,                     -- 초미세먼지 예보 (㎍/㎥)

  -- 이벤트 플래그 (적재 시 임계값으로 도출, 분석 단순화용)
  is_heatwave  boolean NOT NULL DEFAULT false,  -- 폭염: temp_max >= 33
  is_coldwave  boolean NOT NULL DEFAULT false,  -- 한파: temp_min <= -12
  is_rainy     boolean NOT NULL DEFAULT false,  -- 장마/강수: precip_prob >= 60
  is_dusty     boolean NOT NULL DEFAULT false,  -- 황사/미세먼지: pm10 >= 81

  raw_payload jsonb,                       -- KMA 원천 응답 일부
  collected_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (region, forecast_date)
);

CREATE INDEX IF NOT EXISTS jimscanner_weather_forecast_date
  ON jimscanner_weather_forecast(forecast_date, region);

ALTER TABLE jimscanner_weather_forecast ENABLE ROW LEVEL SECURITY;


-- 2) 날씨 민감 상품 사전 (seed) — 카테고리 ↔ 기상변수 매핑
--    운영자가 관리하는 시드. weather_event 발생 시 매칭될 상품군.
--    base_sensitivity: 과거 상관 분석 전의 운영자 사전 가중치 (0~1).
--    correlation_coef: 분석 cron 이 채우는 기상-검색량 상관계수 (-1~1).
CREATE TABLE IF NOT EXISTS jimscanner_weather_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  category_label text NOT NULL,            -- '제습기' | '우산' | '손난로' 등
  weather_event  text NOT NULL,            -- 'heatwave' | 'coldwave' | 'rainy' | 'dusty'
  match_keywords text[] NOT NULL DEFAULT '{}',  -- trends_keywords 매칭용 키워드

  base_sensitivity  numeric NOT NULL DEFAULT 0.5,  -- 운영자 사전 가중치 0~1
  correlation_coef  numeric,                       -- 분석 산출 상관계수 -1~1
  lead_time_days    int NOT NULL DEFAULT 2,         -- ggsan 소싱→도착 리드타임(일)

  is_active boolean NOT NULL DEFAULT true,
  display_order int NOT NULL DEFAULT 0,
  notes text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (category_label, weather_event)
);

CREATE INDEX IF NOT EXISTS jimscanner_weather_products_event
  ON jimscanner_weather_products(weather_event, is_active, display_order)
  WHERE is_active;

ALTER TABLE jimscanner_weather_products ENABLE ROW LEVEL SECURITY;

-- updated_at 자동 갱신 (기존 trends_seeds 패턴 재사용)
CREATE OR REPLACE FUNCTION jimscanner_weather_products_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_weather_products_updated_at ON jimscanner_weather_products;
CREATE TRIGGER jimscanner_weather_products_updated_at
  BEFORE UPDATE ON jimscanner_weather_products
  FOR EACH ROW EXECUTE FUNCTION jimscanner_weather_products_set_updated_at();


-- 3) 초기 시드 — 날씨 민감 상품 사전
--    lead_time_days 는 ggsan 소싱 경험치(1~3일) 기준.
INSERT INTO jimscanner_weather_products
  (category_label, weather_event, match_keywords, base_sensitivity, lead_time_days, display_order) VALUES
  ('선풍기',     'heatwave', ARRAY['선풍기','서큘레이터','휴대용선풍기'], 0.85, 2, 0),
  ('제습기',     'rainy',    ARRAY['제습기','제습제','물먹는하마'],       0.80, 2, 1),
  ('우산',       'rainy',    ARRAY['우산','장우산','자동우산','레인부츠'], 0.75, 1, 2),
  ('손난로',     'coldwave', ARRAY['손난로','핫팩','충전식손난로'],       0.82, 2, 3),
  ('가습기',     'coldwave', ARRAY['가습기','가열식가습기'],             0.70, 2, 4),
  ('전기요',     'coldwave', ARRAY['전기요','전기장판','온수매트'],       0.78, 3, 5),
  ('마스크',     'dusty',    ARRAY['황사마스크','kf94','보건용마스크'],   0.83, 1, 6),
  ('공기청정기', 'dusty',    ARRAY['공기청정기','필터','헤파필터'],       0.72, 3, 7),
  ('선크림',     'heatwave', ARRAY['선크림','자외선차단제','쿨링패치'],   0.65, 2, 8),
  ('아이스조끼', 'heatwave', ARRAY['쿨조끼','아이스조끼','넥쿨러'],       0.68, 2, 9)
ON CONFLICT DO NOTHING;
