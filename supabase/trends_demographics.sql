-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 — DataLab 연령·성별 분포 수집
-- ─────────────────────────────────────────────────────────────
-- naver-datalab.ts 의 ages/gender 분기 호출 결과를 적재.
-- 한 키워드/카테고리(seed)당 6 age bucket × 2 gender = 12 segment.
-- 어드민(service-role)만 접근 — RLS enable, 정책 미정의.

CREATE TABLE IF NOT EXISTS jimscanner_trends_demographics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  source text NOT NULL,                 -- 'naver_search_trend' | 'naver_shopping_insight'
  keyword text NOT NULL,                -- seed groupName / category name (= jimscanner_trends_keywords.keyword)
  product_id uuid REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE, -- LLM/운영자 매핑 후 채움 (nullable)

  age_bucket text NOT NULL CHECK (age_bucket IN ('10','20','30','40','50','60')),
  gender text NOT NULL CHECK (gender IN ('m','f')),

  ratio_index numeric,                  -- 해당 segment 의 가장 최근 시점 ratio (0~100)
  payload jsonb,                        -- 세그먼트별 시계열 raw (sparkline 추출용, optional)

  collected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_demographics_keyword_at
  ON jimscanner_trends_demographics(keyword, collected_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_demographics_product_at
  ON jimscanner_trends_demographics(product_id, collected_at DESC)
  WHERE product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS jimscanner_trends_demographics_segment
  ON jimscanner_trends_demographics(source, age_bucket, gender, collected_at DESC);

ALTER TABLE jimscanner_trends_demographics ENABLE ROW LEVEL SECURITY;
