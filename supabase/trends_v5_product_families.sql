-- ────────────────────────────────────────────────────────────
-- PR-V5: 상품 패밀리(제품군) 클러스터링 — 2026-05-15
-- ────────────────────────────────────────────────────────────
-- 배경:
--   jimscanner_trends_products 는 canonical_name 1:1 단위라
--   "샤오미 미밴드 10" 본체와 "미밴드 10 스트랩/필름/충전기" 같은
--   변형·액세서리가 별도 row 로 흩어져 시그널이 분산된다.
--   위탁 발굴 단위는 보통 '제품군' 이고, 액세서리 동시 발굴은
--   번들 판매 마진과 직결되므로 family-level 집계가 필요.
--
-- 본 마이그레이션:
--   1) jimscanner_trends_product_families 테이블 신설
--   2) jimscanner_trends_products·jimscanner_trends_keywords 에
--      family_id 컬럼 추가 (nullable FK)
--   3) jimscanner_trends_families_scores 뷰 — family 단위 집계
--      (sum trend_score / distinct keyword / lead variant / accessory ratio)
-- ────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1) Product family (제품군 root)
CREATE TABLE IF NOT EXISTS jimscanner_trends_product_families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  root_name text NOT NULL,                -- "샤오미 미밴드 10" 형태의 root product 이름
  root_brand text,                        -- "샤오미"
  category_top text NOT NULL,             -- 'health' | 'living' | 'digital'
  category_mid text,                      -- variant 들의 대표 mid

  -- 어떤 토큰/표현이 이 family 에 매칭되는지 정규화된 사전
  -- {"core": ["미밴드 10", "샤오미 미밴드 10"], "accessory_tokens": ["스트랩","필름","충전기","케이스","파우치"]}
  normalized_aliases jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- denormalized cache — extractor cron 이 갱신
  variant_count int NOT NULL DEFAULT 0,             -- family 에 속한 product row 수
  accessory_count int NOT NULL DEFAULT 0,           -- 액세서리로 분류된 variant 수
  lead_variant_id uuid,                              -- 최고 final_score variant
  total_trend_score numeric,                         -- 직전 집계 시점 합산
  last_aggregated_at timestamptz,

  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (root_name, category_top)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_product_families_category_at
  ON jimscanner_trends_product_families(category_top, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_product_families_brand
  ON jimscanner_trends_product_families(root_brand);
CREATE INDEX IF NOT EXISTS jimscanner_trends_product_families_root_trgm
  ON jimscanner_trends_product_families USING gin (root_name gin_trgm_ops);

ALTER TABLE jimscanner_trends_product_families ENABLE ROW LEVEL SECURITY;
-- service-role 만.

-- updated_at 자동 갱신 트리거
CREATE OR REPLACE FUNCTION jimscanner_trends_product_families_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_trends_product_families_updated_at
  ON jimscanner_trends_product_families;
CREATE TRIGGER jimscanner_trends_product_families_updated_at
  BEFORE UPDATE ON jimscanner_trends_product_families
  FOR EACH ROW EXECUTE FUNCTION jimscanner_trends_product_families_set_updated_at();


-- 2) FK 추가 (nullable — 점진 적용)
ALTER TABLE jimscanner_trends_products
  ADD COLUMN IF NOT EXISTS family_id uuid
    REFERENCES jimscanner_trends_product_families(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS variant_role text;
-- variant_role: 'core' | 'accessory' | 'bundle' | 'unknown'
-- core = 본체, accessory = 스트랩/필름/충전기/케이스, bundle = 묶음/세트

ALTER TABLE jimscanner_trends_keywords
  ADD COLUMN IF NOT EXISTS family_id uuid
    REFERENCES jimscanner_trends_product_families(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS jimscanner_trends_products_family
  ON jimscanner_trends_products(family_id) WHERE family_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS jimscanner_trends_keywords_family
  ON jimscanner_trends_keywords(family_id) WHERE family_id IS NOT NULL;


-- 3) Family 단위 집계 뷰
-- 최신 score 만 사용해서 family 단위로 sum / lead 변형 / accessory 비율 계산.
CREATE OR REPLACE VIEW jimscanner_trends_families_scores AS
WITH latest_scores AS (
  SELECT DISTINCT ON (product_id)
    product_id,
    trend_score,
    commerce_score,
    supplier_score,
    competition_score,
    final_score,
    score_components,
    computed_at
  FROM jimscanner_trends_scores
  ORDER BY product_id, computed_at DESC
),
fam_kw AS (
  SELECT family_id, COUNT(DISTINCT keyword) AS distinct_keywords
  FROM jimscanner_trends_keywords
  WHERE family_id IS NOT NULL
  GROUP BY family_id
),
fam_agg AS (
  SELECT
    p.family_id,
    COUNT(*) AS variant_count,
    SUM(CASE WHEN p.variant_role = 'accessory' THEN 1 ELSE 0 END) AS accessory_count,
    SUM(CASE WHEN p.variant_role = 'core' THEN 1 ELSE 0 END) AS core_count,
    SUM(COALESCE(ls.trend_score, 0)) AS sum_trend_score,
    SUM(COALESCE(ls.commerce_score, 0)) AS sum_commerce_score,
    SUM(COALESCE(ls.supplier_score, 0)) AS sum_supplier_score,
    MAX(COALESCE(ls.final_score, 0)) AS max_final_score,
    AVG(COALESCE(ls.final_score, 0)) AS avg_final_score
  FROM jimscanner_trends_products p
  LEFT JOIN latest_scores ls ON ls.product_id = p.id
  WHERE p.family_id IS NOT NULL
  GROUP BY p.family_id
),
fam_lead AS (
  SELECT DISTINCT ON (p.family_id)
    p.family_id,
    p.id AS lead_variant_id,
    p.canonical_name AS lead_variant_name,
    ls.final_score AS lead_final_score
  FROM jimscanner_trends_products p
  LEFT JOIN latest_scores ls ON ls.product_id = p.id
  WHERE p.family_id IS NOT NULL
  ORDER BY p.family_id, ls.final_score DESC NULLS LAST
)
SELECT
  f.id AS family_id,
  f.root_name,
  f.root_brand,
  f.category_top,
  f.category_mid,
  COALESCE(fa.variant_count, 0) AS variant_count,
  COALESCE(fa.accessory_count, 0) AS accessory_count,
  COALESCE(fa.core_count, 0) AS core_count,
  CASE
    WHEN COALESCE(fa.variant_count, 0) = 0 THEN 0
    ELSE ROUND(COALESCE(fa.accessory_count, 0)::numeric / fa.variant_count::numeric, 3)
  END AS accessory_ratio,
  COALESCE(fa.sum_trend_score, 0) AS sum_trend_score,
  COALESCE(fa.sum_commerce_score, 0) AS sum_commerce_score,
  COALESCE(fa.sum_supplier_score, 0) AS sum_supplier_score,
  COALESCE(fa.max_final_score, 0) AS max_final_score,
  COALESCE(fa.avg_final_score, 0) AS avg_final_score,
  COALESCE(fk.distinct_keywords, 0) AS distinct_keywords,
  fl.lead_variant_id,
  fl.lead_variant_name,
  fl.lead_final_score,
  f.last_seen_at,
  f.last_aggregated_at
FROM jimscanner_trends_product_families f
LEFT JOIN fam_agg fa ON fa.family_id = f.id
LEFT JOIN fam_kw fk ON fk.family_id = f.id
LEFT JOIN fam_lead fl ON fl.family_id = f.id;

COMMENT ON VIEW jimscanner_trends_families_scores IS
  'Family-level aggregate: variant·accessory 카운트, sum/max/avg final_score, lead variant. extractor cron 이 family_id 매핑 후에 비로소 의미있는 값.';
