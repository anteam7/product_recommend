-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — Listing Studio (SEO 상세페이지 1클릭 초안)
-- 2026-05-17
-- ─────────────────────────────────────────────────────────────
-- 핀된 상품에 대해 (페인포인트·검색의도·도매가·N-gram) 컨텍스트 묶음을
-- LLM/룰엔진으로 가공해 SEO 친화 상세페이지 초안 4종 (title/tags/md/thumb_hook)
-- 을 생성. 운영자 채택 단계까지 트래킹.
--
-- 정책: RLS enable, policy 없음 = service-role 전용 (기존 v4 패턴).
-- ─────────────────────────────────────────────────────────────

-- 1) 초안 본체 (variant 단위로 누적, 최신 variant 가 UI 기본 표시)
CREATE TABLE IF NOT EXISTS jimscanner_listing_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  variant_idx int NOT NULL DEFAULT 1,        -- 재생성마다 +1
  kind text NOT NULL,                        -- 'title_short' | 'title_long' | 'tags' | 'detail_md' | 'thumb_hook'
  content_md text NOT NULL,                  -- 본문 (제목은 평문, detail_md 는 마크다운, tags 는 줄바꿈 구분)

  -- 생성 당시 컨텍스트 스냅샷 (디버깅·재현용)
  -- {"final_score":72, "trend_score":..., "supplier_count":..., "alias_count":..., "intent_label":"...", "sources":[...], ...}
  score_payload_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,

  llm_model text NOT NULL DEFAULT 'rule_engine_v1',  -- 'rule_engine_v1' | 'claude_haiku' 등
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_listing_drafts_product_at
  ON jimscanner_listing_drafts(product_id, variant_idx DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_listing_drafts_kind
  ON jimscanner_listing_drafts(product_id, kind, variant_idx DESC);

ALTER TABLE jimscanner_listing_drafts ENABLE ROW LEVEL SECURITY;


-- 2) 핀에 listing 진행단계 컬럼 추가 (운영자 워크플로 가시화)
--    pending  → 아직 초안 미생성
--    drafted  → Listing Studio 로 초안 생성됨
--    published → 외부 채널(스마트스토어 등) 업로드 완료, 운영자가 토글
ALTER TABLE jimscanner_trends_pins
  ADD COLUMN IF NOT EXISTS listing_status text NOT NULL DEFAULT 'pending'
    CHECK (listing_status IN ('pending', 'drafted', 'published'));

ALTER TABLE jimscanner_trends_pins
  ADD COLUMN IF NOT EXISTS listing_product_id uuid
    REFERENCES jimscanner_trends_products(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS jimscanner_trends_pins_listing_product
  ON jimscanner_trends_pins(listing_product_id);
