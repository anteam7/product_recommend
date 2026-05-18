-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — Cross-sell 보완재 번들 후보 (2026-05-19)
-- ─────────────────────────────────────────────────────────────
-- 목적: anchor product 기준으로 '함께 팔면 객단가가 오르는' 보완재 Top N 발굴.
-- 매칭 로직 (compute-bundle-candidates.mjs 일배치):
--   (a) jimscanner_trends_products 임베딩 코사인 유사도 0.55 ~ 0.80 구간
--       — 같지도 다르지도 않음 = 보완재 영역 (>0.80 동일/유사, <0.55 무관)
--   (b) 동일 category_top + 다른 canonical_name
--   (c) 동일 intent_label / 페르소나 공유
--   (d) 자동완성 'X 같이', 'X 세트', 'X 추천' co-occurrence (alias 풀에서 검출)
--
-- 점수 = 위 4 시그널 가중합 (0~1). reasons jsonb 에 시그널 별 contribution.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_bundle_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_id     uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  complement_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  score numeric NOT NULL CHECK (score >= 0 AND score <= 1),
  -- 예시:
  -- {
  --   "cosine": 0.67,
  --   "category_match": true,
  --   "persona_match": true,
  --   "cooccurrence": ["멜라토닌 같이", "멜라토닌 세트"],
  --   "contrib": {"embed": 0.4, "category": 0.2, "persona": 0.2, "cooccur": 0.2}
  -- }
  reasons jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- 묶음 마진 / 공급사 / MOQ 표를 위한 denorm 캐시 (배치 시 채움)
  -- 가장 저렴한 supplier 1건 기준
  cheapest_supplier_source text,
  cheapest_supplier_price_krw numeric,
  cheapest_supplier_moq int,

  computed_at timestamptz NOT NULL DEFAULT now(),

  -- anchor → complement 방향성 있음 (A 의 보완재가 B 일 때 B 의 보완재가 항상 A 는 아님)
  UNIQUE (anchor_id, complement_id),
  CHECK (anchor_id <> complement_id)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_bundle_anchor_score
  ON jimscanner_trends_bundle_candidates(anchor_id, score DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_bundle_computed_at
  ON jimscanner_trends_bundle_candidates(computed_at DESC);

ALTER TABLE jimscanner_trends_bundle_candidates ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만 접근 — 정책 정의 X = service-role 단독 접근 (기존 trends_* 패턴)
