-- ─────────────────────────────────────────────────────────────
-- 자기 발행 SKU 카니발리제이션 게이트 (2026-05-27)
-- ─────────────────────────────────────────────────────────────
-- 발행 SKU 들이 동일 쿠팡 SERP 키워드를 두고 잠식하는 정도를 정량화.
-- 일배치: scripts/scan-self-cannibal.mjs
-- UI: /admin/trend-radar/self-cannibal + /admin/coupang-publish 게이트 배지
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_self_cannibal_overlap (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 둘 다 jimscanner_coupang_listings.id 를 가리킴 (FK 는 두지 않음 — listings 가 다른 마이그레이션)
  listing_id uuid NOT NULL,
  competing_listing_id uuid NOT NULL,

  shared_keyword text NOT NULL,

  -- 쿠팡 SERP top-20 내 순위 (NULL = 토큰 매칭만으로 추정)
  listing_rank int,
  competing_rank int,
  rank_gap int,

  -- 0.0~1.0 — 잠식으로 인한 점유 손실 추정치
  estimated_share_loss numeric NOT NULL DEFAULT 0.0
    CHECK (estimated_share_loss >= 0 AND estimated_share_loss <= 1),

  -- 'serp' | 'token' — 어떤 방법으로 추정했는지
  detection_method text NOT NULL DEFAULT 'token',

  computed_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (listing_id, competing_listing_id, shared_keyword)
);

CREATE INDEX IF NOT EXISTS jimscanner_self_cannibal_listing
  ON jimscanner_self_cannibal_overlap(listing_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_self_cannibal_competing
  ON jimscanner_self_cannibal_overlap(competing_listing_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_self_cannibal_keyword
  ON jimscanner_self_cannibal_overlap(shared_keyword);

ALTER TABLE jimscanner_self_cannibal_overlap ENABLE ROW LEVEL SECURITY;
-- service-role 만. 어드민 외부 접근 차단.

-- ─────────────────────────────────────────────────────────────
-- SKU 별 cannibalization risk score (0~100)
--   - shared_keyword 수 가중
--   - estimated_share_loss 평균 가중
-- UI 에서 직접 join 으로도 계산 가능하지만 view 로 노출해 두면 편함.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW jimscanner_self_cannibal_risk AS
SELECT
  listing_id,
  COUNT(DISTINCT shared_keyword) AS overlapping_keywords,
  COUNT(DISTINCT competing_listing_id) AS competing_sku_count,
  COALESCE(AVG(estimated_share_loss), 0) AS avg_share_loss,
  -- 0~100 스케일링: 키워드 수가 많을수록, 평균 손실이 클수록 위험
  LEAST(
    100,
    ROUND(
      (COUNT(DISTINCT shared_keyword)::numeric * 8) +
      (COALESCE(AVG(estimated_share_loss), 0) * 100 * 0.6)
    )
  ) AS risk_score,
  MAX(computed_at) AS last_computed_at
FROM jimscanner_self_cannibal_overlap
GROUP BY listing_id;
