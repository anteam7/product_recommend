-- ────────────────────────────────────────────────────────────
-- ggsan 단위가(원/mg, 원/정, 원/g) 정규화 — 가격 경쟁력 보드 (2026-05-18)
-- ────────────────────────────────────────────────────────────
-- jimscanner_ggsan_products 에 용량·수량·단위가 컬럼 추가 + 카테고리별 분위수 뷰.
-- ggsan 은 건강기능식품 위주라 '오메가3 1000mg×60정' 식 표기가 표준화돼 있어
-- 정규식 (+ LLM fallback) 으로 추출 가능. price_krw 단독으로는 비교 불가했던
-- 가격 경쟁력을 '같은 카테고리 내 단위가 분위수' 라벨로 한눈에 본다.
-- ────────────────────────────────────────────────────────────

-- 1) 컬럼 추가
ALTER TABLE jimscanner_ggsan_products
  ADD COLUMN IF NOT EXISTS volume_value numeric,            -- 1정/1포/단위 1개당 용량 수치 (예: 1000)
  ADD COLUMN IF NOT EXISTS volume_unit text,                -- 'mg' | 'g' | 'ml' | 'iu' | null
  ADD COLUMN IF NOT EXISTS pack_count integer,              -- 정/캡슐/포/개수 (예: 60)
  ADD COLUMN IF NOT EXISTS pack_unit text,                  -- '정' | '캡슐' | '포' | '개' | 'ea' | null
  ADD COLUMN IF NOT EXISTS unit_price numeric,              -- 원/mg, 원/g, 원/정 등 (단위는 unit_price_basis)
  ADD COLUMN IF NOT EXISTS unit_price_basis text,           -- 'per_mg' | 'per_g' | 'per_ml' | 'per_tablet' | 'per_pack' | null
  ADD COLUMN IF NOT EXISTS unit_extracted_at timestamptz,
  ADD COLUMN IF NOT EXISTS unit_extract_method text;        -- 'regex' | 'llm' | 'manual' | null

CREATE INDEX IF NOT EXISTS jimscanner_ggsan_products_unit_price
  ON jimscanner_ggsan_products(cate_cd, unit_price_basis, unit_price);

CREATE INDEX IF NOT EXISTS jimscanner_ggsan_products_unit_unextracted
  ON jimscanner_ggsan_products(last_seen_at DESC)
  WHERE unit_extracted_at IS NULL;


-- 2) 단위가 분위수 뷰 — 카테고리×단위가기준(basis) 별 p25/p50/p75 + 상품별 quantile_label
-- 'low' = p25 이하 (저가, 가격경쟁력 ↑)
-- 'mid' = p25~p75
-- 'high' = p75 이상 (고가)
CREATE OR REPLACE VIEW jimscanner_ggsan_unit_price_view AS
WITH stats AS (
  SELECT
    cate_cd,
    unit_price_basis,
    percentile_cont(0.25) WITHIN GROUP (ORDER BY unit_price) AS p25,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY unit_price) AS p50,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY unit_price) AS p75,
    count(*)                                                  AS sample_count,
    min(unit_price)                                           AS min_price,
    max(unit_price)                                           AS max_price
  FROM jimscanner_ggsan_products
  WHERE unit_price IS NOT NULL
    AND unit_price_basis IS NOT NULL
    AND cate_cd IS NOT NULL
    AND status <> 'removed'
  GROUP BY cate_cd, unit_price_basis
)
SELECT
  p.goods_no,
  p.title,
  p.cate_cd,
  p.cate_label,
  p.price_krw,
  p.volume_value,
  p.volume_unit,
  p.pack_count,
  p.pack_unit,
  p.unit_price,
  p.unit_price_basis,
  s.p25,
  s.p50,
  s.p75,
  s.sample_count,
  CASE
    WHEN p.unit_price IS NULL OR s.p25 IS NULL THEN NULL
    WHEN p.unit_price <= s.p25 THEN 'low'
    WHEN p.unit_price >= s.p75 THEN 'high'
    ELSE 'mid'
  END AS quantile_label,
  CASE
    WHEN p.unit_price IS NULL OR s.p50 IS NULL OR s.p50 = 0 THEN NULL
    ELSE round(((p.unit_price - s.p50) / s.p50)::numeric * 100, 1)
  END AS pct_diff_from_median
FROM jimscanner_ggsan_products p
LEFT JOIN stats s
  ON s.cate_cd = p.cate_cd AND s.unit_price_basis = p.unit_price_basis;

-- 카테고리×basis 별 박스플롯/요약 뷰
CREATE OR REPLACE VIEW jimscanner_ggsan_unit_price_dist AS
SELECT
  cate_cd,
  unit_price_basis,
  count(*)                                                    AS sample_count,
  percentile_cont(0.10) WITHIN GROUP (ORDER BY unit_price)    AS p10,
  percentile_cont(0.25) WITHIN GROUP (ORDER BY unit_price)    AS p25,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY unit_price)    AS p50,
  percentile_cont(0.75) WITHIN GROUP (ORDER BY unit_price)    AS p75,
  percentile_cont(0.90) WITHIN GROUP (ORDER BY unit_price)    AS p90,
  min(unit_price)                                             AS min_price,
  max(unit_price)                                             AS max_price
FROM jimscanner_ggsan_products
WHERE unit_price IS NOT NULL
  AND unit_price_basis IS NOT NULL
  AND cate_cd IS NOT NULL
  AND status <> 'removed'
GROUP BY cate_cd, unit_price_basis;
