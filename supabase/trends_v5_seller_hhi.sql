-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v5 — Seller HHI (Naver SERP 판매자 집중도)
-- ─────────────────────────────────────────────────────────────
-- 목적:
--   각 canonical product 의 Naver Shopping SERP 상위 20 listing 의
--   판매자(seller_name) 점유율을 계산하여 시장구조(buyer-side concentration)
--   를 정량화한다. HHI = Σ shareᵢ²
--
-- 판정 기준:
--   HHI < 0.15  : 분산 시장 (entry friendly)
--   0.15~0.25   : 중간 시장
--   > 0.25      : 과점 시장 (entry hard)
--
-- RLS: 정책 정의 X — service-role 만 접근 (기존 패턴 유지)
-- ─────────────────────────────────────────────────────────────


-- 1) 판매자별 share (개별 listing 단위로 저장)
--    하나의 product 에 N 개 (≤20) row.
CREATE TABLE IF NOT EXISTS jimscanner_trends_seller_share (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  seller_name text NOT NULL,
  share_pct numeric NOT NULL CHECK (share_pct >= 0 AND share_pct <= 1),
  review_count int NOT NULL DEFAULT 0,
  listing_rank int NOT NULL,           -- SERP 내 첫 등장 순위 (1~20)

  snapshot_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_seller_share_product_at
  ON jimscanner_trends_seller_share(product_id, snapshot_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_seller_share_snapshot
  ON jimscanner_trends_seller_share(snapshot_at DESC);

ALTER TABLE jimscanner_trends_seller_share ENABLE ROW LEVEL SECURITY;


-- 2) Product 단위 HHI 요약 (UI 가 빠르게 읽도록 별도 테이블)
CREATE TABLE IF NOT EXISTS jimscanner_trends_seller_hhi (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  hhi numeric NOT NULL CHECK (hhi >= 0 AND hhi <= 1),
  top1_share numeric NOT NULL CHECK (top1_share >= 0 AND top1_share <= 1),
  top3_share numeric NOT NULL CHECK (top3_share >= 0 AND top3_share <= 1),
  seller_count_effective numeric NOT NULL,   -- 1/HHI 환산 (유효 셀러 수)
  total_listings int NOT NULL DEFAULT 0,
  top1_seller text,

  snapshot_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_seller_hhi_product_at
  ON jimscanner_trends_seller_hhi(product_id, snapshot_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_seller_hhi_recent
  ON jimscanner_trends_seller_hhi(snapshot_at DESC, hhi ASC);

ALTER TABLE jimscanner_trends_seller_hhi ENABLE ROW LEVEL SECURITY;
