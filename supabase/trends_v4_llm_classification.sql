-- ────────────────────────────────────────────────────────────
-- PR-4.5: Gemma 4 LLM 분류 인프라 (2026-05-09)
-- ────────────────────────────────────────────────────────────
-- 위탁 판매 후보 product 의 canonical 정제·brand·category_mid·intent 분류
-- 호출: Vercel cron /api/cron/classify-trends-llm (KST 06:30, recompute 직후)
-- 일일 호출 카운터로 무료 티어 한도 가드
-- ────────────────────────────────────────────────────────────

-- 1) jimscanner_trends_products 에 LLM 분류 컬럼 추가
ALTER TABLE jimscanner_trends_products
  ADD COLUMN IF NOT EXISTS intent_label text,
  ADD COLUMN IF NOT EXISTS llm_classified_at timestamptz,
  ADD COLUMN IF NOT EXISTS llm_model text;

CREATE INDEX IF NOT EXISTS jimscanner_trends_products_unclassified
  ON jimscanner_trends_products(updated_at DESC)
  WHERE llm_classified_at IS NULL;

-- 2) 일일 LLM 호출 카운터 (무료 티어 한도 가드)
-- 단순 일별 row, UPSERT 패턴.
CREATE TABLE IF NOT EXISTS jimscanner_trends_llm_calls (
  day date PRIMARY KEY DEFAULT current_date,
  model text NOT NULL DEFAULT 'gemma-4-26b-a4b-it',
  request_count int NOT NULL DEFAULT 0,
  product_count int NOT NULL DEFAULT 0,        -- 분류된 product 누적
  input_token_count bigint NOT NULL DEFAULT 0, -- 추정/실측 합
  output_token_count bigint NOT NULL DEFAULT 0,
  last_call_at timestamptz,
  notes text
);

ALTER TABLE jimscanner_trends_llm_calls ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────────────────
-- PR-4.6: 상품화 가능성 게이트 + 실물 SKU 후보 추출 (2026-06-03)
-- ────────────────────────────────────────────────────────────
-- 문제: raw 인서트가 daum_news·naver_tvtime·82cook·natepan 등 비상품
--   커뮤니티/뉴스에 압도적으로 쏠려 있어 인물·사건·드라마 키워드가
--   발굴 큐를 오염시킨다. 기존 intent/category 분류는 '구매의도·주제'는
--   잡지만 '실물로 위탁 소싱 가능한가'는 판정하지 못한다.
-- 해결: classify-trends-llm 단계에 실물성 게이트를 끼워
--   ① non_product   — 인물/사건/정치/드라마 등 소싱 불가 노이즈 (기본 숨김)
--   ② theme_to_sku  — '수면·캠핑·홈카페' 같은 추상 테마 → 구체 SKU 1~3개 역산
--   ③ direct_sku    — 이미 그 자체로 판매 SKU
--   를 productizability_label 에 적재하고, theme/direct 의 판매 후보를
--   sku_candidates(jsonb 배열) 에 담는다. productizable_score(0~100)는
--   /admin/trend-radar 의 노이즈 필터 토글 기준값.
-- ────────────────────────────────────────────────────────────
ALTER TABLE jimscanner_trends_products
  ADD COLUMN IF NOT EXISTS productizability_label text,   -- 'direct_sku' | 'theme_to_sku' | 'non_product'
  ADD COLUMN IF NOT EXISTS productizable_score int,       -- 0~100 (실물 소싱 가능성)
  ADD COLUMN IF NOT EXISTS sku_candidates jsonb NOT NULL DEFAULT '[]'::jsonb;
  -- sku_candidates 예: [{"name":"수면안대","reason":"수면 테마 대표 소모품"},{"name":"중량담요"}]

-- non_product 노이즈는 발굴 큐/대시보드에서 빠르게 걸러야 하므로 부분 인덱스.
CREATE INDEX IF NOT EXISTS jimscanner_trends_products_productizable
  ON jimscanner_trends_products(productizable_score DESC)
  WHERE productizability_label IS DISTINCT FROM 'non_product';
