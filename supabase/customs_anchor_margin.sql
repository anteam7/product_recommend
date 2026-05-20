-- ────────────────────────────────────────────────────────────
-- Customs-Anchor Margin (PR-CAM-1, 2026-05-21)
-- ────────────────────────────────────────────────────────────
-- jimscanner_manifest_items (실측 통관 신고가) × jimscanner_ggsan_products (도매가)
-- → 카테고리·HS별 위탁 마진 박스플롯 + ggsan SKU Top 20
--
-- 데이터 흐름:
--   1) manifest_items.unit_value_usd × exchange_rates(USD→KRW) → 실지불 단가(KRW)
--   2) category_tag 별 P10/P50/P90 분위 산출 (single-item invoice + non-outlier만)
--   3) jimscanner_manifest_to_ggsan_cate 정적 매핑으로 ggsan.cate_cd 연결
--   4) 카테고리평균 부피무게비용 = invoice_volumetric_weight_kg median × 10,000원/kg (CN/JP/US 평균치 근사)
--   5) margin = (P50_KRW - ggsan_price_krw - vol_cost_krw) / ggsan_price_krw
-- ────────────────────────────────────────────────────────────

-- 1) 정적 매핑: ggsan.cate_cd / cate_label ↔ manifest.category_tag
CREATE TABLE IF NOT EXISTS jimscanner_manifest_to_ggsan_cate (
  ggsan_cate_cd text PRIMARY KEY,
  ggsan_cate_label text NOT NULL,
  manifest_category_tag text NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_manifest_to_ggsan_cate_tag
  ON jimscanner_manifest_to_ggsan_cate (manifest_category_tag);

ALTER TABLE jimscanner_manifest_to_ggsan_cate ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow service_role manifest_to_ggsan_cate" ON jimscanner_manifest_to_ggsan_cate;
CREATE POLICY "Allow service_role manifest_to_ggsan_cate"
  ON jimscanner_manifest_to_ggsan_cate
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 시드: ggsan 14개 카테고리 → manifest 의 NUTRITIONAL PRODUCTS / FOODS 등 매핑
-- (매니페스트 [TAG] 분포가 압도적으로 NUTRITIONAL PRODUCTS · FOODS 인 점 활용)
INSERT INTO jimscanner_manifest_to_ggsan_cate (ggsan_cate_cd, ggsan_cate_label, manifest_category_tag, notes)
VALUES
  ('001', '장건강',       'NUTRITIONAL PRODUCTS', '프로바이오틱스·식이섬유'),
  ('002', '눈건강',       'NUTRITIONAL PRODUCTS', '루테인·아스타잔틴'),
  ('003', '간건강',       'NUTRITIONAL PRODUCTS', '밀크씨슬'),
  ('005', '혈행건강',     'NUTRITIONAL PRODUCTS', '오메가3·홍국'),
  ('006', '관절건강',     'NUTRITIONAL PRODUCTS', '글루코사민·MSM'),
  ('007', '면역건강',     'NUTRITIONAL PRODUCTS', '비타민·아연'),
  ('008', '체지방',       'NUTRITIONAL PRODUCTS', '가르시니아·CLA'),
  ('009', '건기식기타',   'NUTRITIONAL PRODUCTS', '기타 건강기능식품'),
  ('010', '전통건강식품', 'FOODS',                '홍삼·꿀'),
  ('011', '전립선',       'NUTRITIONAL PRODUCTS', '쏘팔메토'),
  ('012', '식품분말',     'FOODS',                '단백질·식사대용'),
  ('013', '가공식품기타', 'FOODS',                '가공식품'),
  ('014', '신선식품',     'FOODS',                '신선·냉장'),
  ('020', '임박특가',     'NUTRITIONAL PRODUCTS', '임박특가 카테고리 — 매핑은 NUTRITIONAL 으로 폴백')
ON CONFLICT (ggsan_cate_cd) DO UPDATE SET
  ggsan_cate_label = EXCLUDED.ggsan_cate_label,
  manifest_category_tag = EXCLUDED.manifest_category_tag,
  notes = EXCLUDED.notes,
  updated_at = now();


-- 2) RPC: jimscanner_customs_anchor_margin(category, days_window)
--    category NULL → 전체 카테고리. category 지정 → 해당 ggsan.cate_cd 만.
--    days_window: manifest 최근 N일 (collected_date 기준)
DROP FUNCTION IF EXISTS jimscanner_customs_anchor_margin(text, int);

CREATE OR REPLACE FUNCTION jimscanner_customs_anchor_margin(
  p_category text DEFAULT NULL,
  p_days_window int DEFAULT 180
)
RETURNS TABLE (
  goods_no text,
  title text,
  ggsan_cate_cd text,
  ggsan_cate_label text,
  ggsan_price_krw int,
  is_imminent boolean,
  image_url text,
  detail_url text,
  manifest_category_tag text,
  manifest_sample_n int,
  manifest_p10_krw numeric,
  manifest_p50_krw numeric,
  manifest_p90_krw numeric,
  volumetric_cost_krw numeric,
  margin_krw numeric,
  margin_pct numeric,
  gmv_expected_krw numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH fx AS (
    SELECT rate_krw
    FROM jimscanner_exchange_rates
    WHERE currency = 'USD'
    ORDER BY updated_at DESC
    LIMIT 1
  ),
  fx_value AS (
    SELECT COALESCE((SELECT rate_krw FROM fx), 1380.0)::numeric AS usd_krw
  ),
  -- 매니페스트 카테고리별 분위 (single-item invoice + non-outlier)
  manifest_agg AS (
    SELECT
      mi.category_tag AS manifest_category_tag,
      COUNT(*)::int AS sample_n,
      (percentile_cont(0.10) WITHIN GROUP (ORDER BY mi.unit_value_usd * (SELECT usd_krw FROM fx_value)))::numeric AS p10_krw,
      (percentile_cont(0.50) WITHIN GROUP (ORDER BY mi.unit_value_usd * (SELECT usd_krw FROM fx_value)))::numeric AS p50_krw,
      (percentile_cont(0.90) WITHIN GROUP (ORDER BY mi.unit_value_usd * (SELECT usd_krw FROM fx_value)))::numeric AS p90_krw,
      (percentile_cont(0.50) WITHIN GROUP (ORDER BY COALESCE(mi.invoice_volumetric_weight_kg, mi.invoice_total_weight_kg)))::numeric AS vol_kg_median
    FROM jimscanner_manifest_items mi
    WHERE mi.is_single_item_invoice = true
      AND mi.is_outlier = false
      AND mi.unit_value_usd IS NOT NULL
      AND mi.category_tag IS NOT NULL
      AND (
        p_days_window IS NULL
        OR mi.collected_date IS NULL
        OR mi.collected_date >= (current_date - (p_days_window || ' days')::interval)::date
      )
    GROUP BY mi.category_tag
  ),
  joined AS (
    SELECT
      gp.goods_no,
      gp.title,
      gp.cate_cd AS ggsan_cate_cd,
      gp.cate_label AS ggsan_cate_label,
      gp.price_krw AS ggsan_price_krw,
      gp.is_imminent,
      gp.image_url,
      gp.detail_url,
      m2g.manifest_category_tag,
      ma.sample_n,
      ma.p10_krw,
      ma.p50_krw,
      ma.p90_krw,
      ma.vol_kg_median,
      -- 부피무게비용: median vol_kg * 10,000원/kg (CN air 약 7천, JP/US air 약 12천 근사)
      (COALESCE(ma.vol_kg_median, 0) * 10000.0)::numeric AS vol_cost_krw
    FROM jimscanner_ggsan_products gp
    JOIN jimscanner_manifest_to_ggsan_cate m2g ON m2g.ggsan_cate_cd = gp.cate_cd
    JOIN manifest_agg ma ON ma.manifest_category_tag = m2g.manifest_category_tag
    WHERE gp.price_krw IS NOT NULL
      AND gp.price_krw > 0
      AND gp.status = 'active'
      AND (p_category IS NULL OR gp.cate_cd = p_category)
  )
  SELECT
    j.goods_no,
    j.title,
    j.ggsan_cate_cd,
    j.ggsan_cate_label,
    j.ggsan_price_krw,
    j.is_imminent,
    j.image_url,
    j.detail_url,
    j.manifest_category_tag,
    j.sample_n AS manifest_sample_n,
    j.p10_krw AS manifest_p10_krw,
    j.p50_krw AS manifest_p50_krw,
    j.p90_krw AS manifest_p90_krw,
    j.vol_cost_krw AS volumetric_cost_krw,
    (j.p50_krw - j.ggsan_price_krw - j.vol_cost_krw)::numeric AS margin_krw,
    CASE
      WHEN j.ggsan_price_krw > 0 THEN
        ((j.p50_krw - j.ggsan_price_krw - j.vol_cost_krw) / j.ggsan_price_krw)::numeric
      ELSE NULL
    END AS margin_pct,
    -- GMV 기대치: manifest 의 P50 × sample_n (직구러 수요 강도 proxy)
    (j.p50_krw * j.sample_n)::numeric AS gmv_expected_krw
  FROM joined j
  ORDER BY margin_pct DESC NULLS LAST
  LIMIT 500;
$$;

REVOKE ALL ON FUNCTION jimscanner_customs_anchor_margin(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_customs_anchor_margin(text, int) TO service_role;
