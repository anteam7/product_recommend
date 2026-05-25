-- ────────────────────────────────────────────────────────────
-- PR-4.7: 카테고리 브랜드 집중도 (HHI) 보드 (2026-05-26)
-- ────────────────────────────────────────────────────────────
-- 각 category_top 의 Herfindahl-Hirschman Index 와 top-1/top-3 share 를
-- jimscanner_trends_products.brand · alias_count 로 계산해 적재한다.
-- 적재 주체: scripts/compute-category-hhi.mjs (로컬 cron, recompute 직후)
--
-- HHI = Σ (share_i × 100)^2,  share_i ∈ [0,1]    → 0 ~ 10000
--   < 1500  : fragmented (위탁 진입 추천)
--   1500-2500: 경합
--   > 2500  : 독과점
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_category_concentration (
  category_top text PRIMARY KEY,
  hhi numeric NOT NULL,                 -- 0 ~ 10000
  top1_brand text,
  top1_share numeric,                   -- 0 ~ 1
  top3_share numeric,                   -- 0 ~ 1
  brand_count int NOT NULL DEFAULT 0,   -- non-null brand 수
  distinct_skus int NOT NULL DEFAULT 0, -- canonical 상품 수 (분모)
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_category_concentration_hhi
  ON jimscanner_trends_category_concentration(hhi);

ALTER TABLE jimscanner_trends_category_concentration ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.
