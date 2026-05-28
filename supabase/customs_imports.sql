-- 관세청 HS코드 수입통계 + 트렌드 선행지표 (2026-05-28)
--
-- 한국 수입 ground truth (TRASS / 관세청 OpenAPI) 를 HS코드 단위 월별로 적재.
-- jimscanner_trends_keywords (검색 시그널) 과 cross-correlation 분석하여
-- '수입 급증 + 검색 미반영 = 사전 진입 골든윈도우' 시그널을 뽑는다.

-- ─────────────────────────────────────────
-- 1) 수입통계 적재 테이블
CREATE TABLE IF NOT EXISTS jimscanner_customs_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hs_code text NOT NULL,                 -- 6~10단위 (정규화: 숫자만)
  hs_name text,                          -- HS 품목명 (한글)
  month date NOT NULL,                   -- 해당 월 1일 (YYYY-MM-01)
  import_value_usd numeric,              -- 수입금액 (USD)
  import_qty numeric,                    -- 수입수량
  prev_yoy numeric,                      -- 전년동월대비 증감률 (%)
  source text NOT NULL DEFAULT 'trass',  -- 'trass' / 'kcs_open_api' / 'manual'
  raw jsonb,                             -- 원천 응답 보존
  collected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hs_code, month, source)
);
CREATE INDEX IF NOT EXISTS jimscanner_customs_imports_hs_month
  ON jimscanner_customs_imports(hs_code, month DESC);
CREATE INDEX IF NOT EXISTS jimscanner_customs_imports_month
  ON jimscanner_customs_imports(month DESC);

ALTER TABLE jimscanner_customs_imports ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role) 전용. 클라이언트 직접 접근 없음.

-- ─────────────────────────────────────────
-- 2) taxonomy_category ↔ HS코드 매핑 (운영자 편집)
-- jimscanner_trends_products.taxonomy_category (또는 category_top) 와 HS코드 prefix 매칭.
CREATE TABLE IF NOT EXISTS customs_hs_taxonomy_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  taxonomy_category text NOT NULL,       -- 'health' / 'living' / 'digital' 또는 세분류
  hs_code_prefix text NOT NULL,          -- '2106' (HS4) / '210690' (HS6) 등
  label text,                            -- 운영자 메모 ("건강기능식품 - 멜라토닌 함유")
  is_active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (taxonomy_category, hs_code_prefix)
);
CREATE INDEX IF NOT EXISTS customs_hs_taxonomy_map_active
  ON customs_hs_taxonomy_map(taxonomy_category, hs_code_prefix)
  WHERE is_active;

ALTER TABLE customs_hs_taxonomy_map ENABLE ROW LEVEL SECURITY;

-- updated_at 자동 갱신
CREATE OR REPLACE FUNCTION customs_hs_taxonomy_map_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customs_hs_taxonomy_map_updated_at ON customs_hs_taxonomy_map;
CREATE TRIGGER customs_hs_taxonomy_map_updated_at
  BEFORE UPDATE ON customs_hs_taxonomy_map
  FOR EACH ROW EXECUTE FUNCTION customs_hs_taxonomy_map_set_updated_at();

-- 초기 시드 (운영자가 어드민에서 편집)
INSERT INTO customs_hs_taxonomy_map (taxonomy_category, hs_code_prefix, label) VALUES
  ('health', '2106', '건강기능식품 (조제식료품)'),
  ('health', '3004', '의약품/건강보조'),
  ('living', '3304', '화장품/스킨케어'),
  ('living', '9603', '브러시/생활용품'),
  ('digital', '8517', '스마트폰/통신기기'),
  ('digital', '8528', '모니터/디스플레이'),
  ('digital', '8504', '충전기/전원공급')
ON CONFLICT (taxonomy_category, hs_code_prefix) DO NOTHING;
