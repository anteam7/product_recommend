-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 — 대표이미지 재사용도(Image-Reuse) 레드오션 게이트
-- ─────────────────────────────────────────────────────────────
-- 발굴 상품마다 쿠팡 상위 N개 경쟁 리스팅 썸네일 + ggsan/도매 원본 사진을
-- perceptual hash(average-hash, 8x8 그레이스케일, sharp 산출)로 수집해
--   · stock_reuse_ratio   = 동일·근사 사진 비율 (0~1) → 높을수록 무차별 위탁 레드오션
--   · distinct_image_clusters = 시각적 군집 수 → 적을수록 차별화 여지 없음
-- 을 측정한다.
--
-- 기존 4점수(텍스트·수치) 신호로는 잡히지 않는 "차별화 불가능성"을
-- 사진 재사용도가 직접 드러내는 시각(이미지) 모달리티 게이트.
--
-- 수집: scripts/trends-image-audit-collect.mjs (로컬 WSL, sharp average-hash)
-- 적재: service-role
-- 노출: 어드민 read-only (기존 jimscanner_trends_* 패턴 동일, RLS enable + 정책 X)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_image_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  -- 경쟁 리스팅 대표이미지 average-hash 목록 (각 16-hex = 64bit)
  listing_phashes text[] NOT NULL DEFAULT '{}',
  -- ggsan/도매 원본 사진 average-hash (기준점)
  supplier_phash text,

  -- 동일·근사 사진 비율 (0~1). supplier 원본과 hamming≤threshold 인 리스팅 비율
  reuse_ratio numeric CHECK (reuse_ratio IS NULL OR (reuse_ratio >= 0 AND reuse_ratio <= 1)),
  -- 시각적 군집 수 (서로 다른 사진의 가짓수)
  cluster_count int,
  -- 수집된 경쟁 리스팅 수 (분모)
  listing_count int NOT NULL DEFAULT 0,

  -- UI 썸네일 그리드용: [{ url, phash, cluster, is_supplier }]
  thumbnails jsonb NOT NULL DEFAULT '[]'::jsonb,

  collected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_image_audit_product_at
  ON jimscanner_trends_image_audit(product_id, collected_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_image_audit_reuse
  ON jimscanner_trends_image_audit(reuse_ratio DESC, collected_at DESC);

ALTER TABLE jimscanner_trends_image_audit ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.
