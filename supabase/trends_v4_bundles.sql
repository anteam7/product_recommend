-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — AOV 묶음 시너지 후보 (Bundle Candidates)
-- ─────────────────────────────────────────────────────────────
-- 목적: 단일 SKU 가 아닌 '쌍/세트' 단위 진입 기회를 발굴.
-- 시그널: ① naver_blog/news 본문 동시언급, ② 네이버 쇼핑 '함께 본 상품',
--         ③ 동일 세션 검색 쿼리 쌍.
-- LLM 으로 보완 vs 대체 분류 → 보완 페어만 후보 적재.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_bundle_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 페어 (a_id < b_id 정렬 강제 — 중복 방지)
  product_a_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  product_b_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  -- 시그널 지표
  co_mention_count int NOT NULL DEFAULT 0,           -- naver_blog/news 본문 동시언급 횟수
  co_search_score numeric NOT NULL DEFAULT 0,        -- 0~100, 검색쿼리 쌍 + '함께 본 상품' 통합 점수
  complementarity_score numeric NOT NULL DEFAULT 0,  -- 0~100, LLM 보완성 판정 (보완=80~100, 중립=40~60, 대체=0~20)

  -- 경제성 지표 (LLM 또는 정규화 계산)
  expected_aov_lift numeric,            -- 단품 대비 객단가 상승 예상 % (예: 35.0 = +35%)
  combined_supplier_cost numeric,       -- 양쪽 supplier price_krw 합 (KRW)
  both_in_ggsan boolean NOT NULL DEFAULT false,   -- ggsan 도매에 양쪽 다 있는지

  -- 결합 리스팅 카피 (핀 시 LLM 자동 생성, JSON: {title, bullet_points[], description})
  listing_copy jsonb,

  -- 분류 메타
  relation_type text,                   -- 'complement' | 'substitute' | 'neutral' | NULL(미분류)
  classified_by text,                   -- 'llm_haiku' | 'manual' | 'rule_engine'
  classified_at timestamptz,

  -- 핀
  pinned boolean NOT NULL DEFAULT false,
  pinned_at timestamptz,
  pinned_notes text,

  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- a_id < b_id 강제로 (A,B) (B,A) 중복 방지
  CONSTRAINT bundle_candidates_ordered_pair CHECK (product_a_id < product_b_id),
  UNIQUE (product_a_id, product_b_id)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_bundle_candidates_a
  ON jimscanner_trends_bundle_candidates(product_a_id);
CREATE INDEX IF NOT EXISTS jimscanner_trends_bundle_candidates_b
  ON jimscanner_trends_bundle_candidates(product_b_id);
CREATE INDEX IF NOT EXISTS jimscanner_trends_bundle_candidates_score
  ON jimscanner_trends_bundle_candidates(complementarity_score DESC, co_mention_count DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_bundle_candidates_pinned
  ON jimscanner_trends_bundle_candidates(pinned, pinned_at DESC) WHERE pinned = true;
CREATE INDEX IF NOT EXISTS jimscanner_trends_bundle_candidates_ggsan
  ON jimscanner_trends_bundle_candidates(both_in_ggsan, complementarity_score DESC) WHERE both_in_ggsan = true;

ALTER TABLE jimscanner_trends_bundle_candidates ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만 접근.

-- updated_at 자동 갱신
CREATE OR REPLACE FUNCTION jimscanner_trends_bundle_candidates_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_trends_bundle_candidates_updated_at ON jimscanner_trends_bundle_candidates;
CREATE TRIGGER jimscanner_trends_bundle_candidates_updated_at
  BEFORE UPDATE ON jimscanner_trends_bundle_candidates
  FOR EACH ROW EXECUTE FUNCTION jimscanner_trends_bundle_candidates_set_updated_at();

-- 코멘션 원시 로그 (디버깅·재처리용, 30일 보관)
CREATE TABLE IF NOT EXISTS jimscanner_trends_cobuy_raw (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_a_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  product_b_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  signal_source text NOT NULL,    -- 'naver_blog' | 'naver_news' | 'naver_shopping_related' | 'search_session'
  raw_id uuid,                    -- jimscanner_market_raw.id 참조 (느슨)
  snippet text,                   -- '같이 샀어요/세트/추천 조합' 패턴 일부
  pattern_matched text,           -- 'co_buy' | 'set' | 'recommend_combo' | 'related_view'
  weight numeric NOT NULL DEFAULT 1.0,
  captured_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
  CONSTRAINT cobuy_raw_ordered_pair CHECK (product_a_id < product_b_id)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_cobuy_raw_pair
  ON jimscanner_trends_cobuy_raw(product_a_id, product_b_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_cobuy_raw_expires
  ON jimscanner_trends_cobuy_raw(expires_at);

ALTER TABLE jimscanner_trends_cobuy_raw ENABLE ROW LEVEL SECURITY;
