-- ────────────────────────────────────────────────────────────
-- 패키지 시각속성 자동추출 — Vision LLM 라벨링 결과 저장소
-- (Trend Radar PRO v4 — Visual Trends 매트릭스용)
-- ────────────────────────────────────────────────────────────
-- 상품 이미지(jimscanner_ggsan_products.image_url 또는 trends_products
-- 의 대표 sample image) 1장에 대해 Vision LLM 으로 6가지 속성을 분류:
--   - primary_color   : 'beige' | 'pastel' | 'vivid' | 'mono' | 'other'
--   - package_form    : 'pouch' | 'bottle' | 'box' | 'zipper' | 'stick' | 'other'
--   - design_style    : 'minimal' | 'retro' | 'natural' | 'kpop' | 'other'
--   - model_in_scene  : boolean  (모델/사용씬 등장 여부)
--   - has_korean      : boolean  (패키지에 한글 표기 여부)
--   - size_label      : boolean  (사이즈/용량 명시 여부)
--
-- 동일 상품을 ggsan 카탈로그 측(goods_no) / canonical product 측
-- (product_id) 양쪽으로 기록할 수 있도록 두 컬럼 모두 nullable +
-- CHECK 제약으로 최소 1개는 채워야 한다.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_vision_attrs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goods_no text REFERENCES jimscanner_ggsan_products(goods_no) ON DELETE CASCADE,
  product_id uuid REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  category_top text,                       -- 'health' | 'living' | 'digital' | 'other' (snapshot)
  image_url text NOT NULL,                 -- 분류 대상 이미지 URL (원본)
  attrs jsonb NOT NULL,                    -- 6속성 라벨 + raw confidence
  embed_version text NOT NULL DEFAULT 'v1',
  vision_model text,                       -- 'gpt-4o-mini' / 'gemini-2.0-flash' 등
  classified_at timestamptz NOT NULL DEFAULT now(),
  CHECK (goods_no IS NOT NULL OR product_id IS NOT NULL)
);

-- ggsan 카탈로그 → 1:1 mirror (동일 goods_no 재실행 시 갱신은 INSERT)
CREATE INDEX IF NOT EXISTS jimscanner_trends_vision_attrs_goods
  ON jimscanner_trends_vision_attrs(goods_no, classified_at DESC)
  WHERE goods_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS jimscanner_trends_vision_attrs_product
  ON jimscanner_trends_vision_attrs(product_id, classified_at DESC)
  WHERE product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS jimscanner_trends_vision_attrs_cat_at
  ON jimscanner_trends_vision_attrs(category_top, classified_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_vision_attrs_attrs_gin
  ON jimscanner_trends_vision_attrs USING gin (attrs);

ALTER TABLE jimscanner_trends_vision_attrs ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role) 만.
