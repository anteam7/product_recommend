-- ────────────────────────────────────────────────────────────
-- SERP 옵션변형 커버리지 (Variant Whitespace, 2026-05-26)
-- ────────────────────────────────────────────────────────────
-- 같은 키워드 안에서 변형 축(용량/팩수/사이즈/맛·향/색상/연령대/성별)별
-- 노출 분포를 집계해 underserved 변형 셀을 발굴.
-- raw SERP HTML / 제목 리스트는 jimscanner_trends_raw 또는 외부 수집기 산출물에서 옴.
-- scripts/extract-serp-variants.mjs 가 주기적으로 채움.
-- ────────────────────────────────────────────────────────────

-- 축 enum 대신 text 로 유연하게: 'capacity','pack','size','flavor','color','age','gender'
CREATE TABLE IF NOT EXISTS jimscanner_serp_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword text NOT NULL,
  axis text NOT NULL,                 -- 변형 축 (capacity, pack, size, flavor, color, age, gender)
  value text NOT NULL,                -- 정규화된 값 (예: capacity='30정', pack='2팩', flavor='딸기')
  listing_count int NOT NULL DEFAULT 0,
  avg_rank numeric,                   -- 그 축·값의 평균 SERP 순위 (낮을수록 상위)
  review_sum bigint,                  -- 매칭 리스팅 리뷰 수 합
  price_p50 integer,                  -- 가격 중앙값 (원)
  price_p10 integer,
  price_p90 integer,
  -- 갭 스코어 (낮을수록 underserved → 빈 칸 후보)
  -- 0=완전 비어있음, 1=평균 수준, 2+=과포화
  density_z numeric,                  -- 같은 (keyword) 내 다른 value 와 비교한 z-score
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- (keyword, axis, value, captured_at) UNIQUE — 같은 수집 시점엔 중복 없음
CREATE UNIQUE INDEX IF NOT EXISTS jimscanner_serp_variants_unique
  ON jimscanner_serp_variants(keyword, axis, value, captured_at);

CREATE INDEX IF NOT EXISTS jimscanner_serp_variants_keyword_axis_at
  ON jimscanner_serp_variants(keyword, axis, captured_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_serp_variants_keyword_at
  ON jimscanner_serp_variants(keyword, captured_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_serp_variants_density
  ON jimscanner_serp_variants(density_z) WHERE density_z IS NOT NULL;

ALTER TABLE jimscanner_serp_variants ENABLE ROW LEVEL SECURITY;
-- service-role 만.

-- ────────────────────────────────────────────────────────────
-- 핀: 어드민이 "이 변형 셀로 진입한다" 표시한 셀 (action_queue)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jimscanner_serp_variant_pins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword text NOT NULL,
  axis text NOT NULL,
  value text NOT NULL,
  ggsan_goods_no text REFERENCES jimscanner_ggsan_products(goods_no) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued', -- 'queued' | 'sourcing' | 'listed' | 'rejected'
  note text,
  pinned_by text,                        -- 어드민 email or 'system'
  pinned_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS jimscanner_serp_variant_pins_uniq
  ON jimscanner_serp_variant_pins(keyword, axis, value);

CREATE INDEX IF NOT EXISTS jimscanner_serp_variant_pins_status
  ON jimscanner_serp_variant_pins(status, pinned_at DESC);

ALTER TABLE jimscanner_serp_variant_pins ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION jimscanner_serp_variant_pins_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_serp_variant_pins_updated_at ON jimscanner_serp_variant_pins;
CREATE TRIGGER jimscanner_serp_variant_pins_updated_at
  BEFORE UPDATE ON jimscanner_serp_variant_pins
  FOR EACH ROW EXECUTE FUNCTION jimscanner_serp_variant_pins_set_updated_at();
