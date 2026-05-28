-- ────────────────────────────────────────────────────────────
-- Aspect-Sentiment Weak-Axis 보드 (PR-WEAKAXIS-1, 2026-05-29)
-- ────────────────────────────────────────────────────────────
-- 카테고리 내 경쟁 SKU 리뷰를 LLM 으로 attribute × sentiment 분해.
-- 목적: 카테고리 단위 "경쟁 SKU 가 공통으로 못하는 약점 축" 정량화.
--   ggsan 위탁은 동일 도매상품을 여러 셀러가 같이 발행 → 카피·사진·상세
--   차별화가 CTR·CVR 을 가름. 그 근거를 경쟁 리뷰 부정 클러스터에서 도출.
--
-- aspect 표준 키 (8축):
--   delivery(배송) · packaging(포장) · quality(품질) · taste(맛·향)
--   size_fit(사이즈·핏) · design(디자인) · price(가격) · usability(사용감)
-- sentiment: pos | neg | neu
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_review_aspects (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku_external_id text NOT NULL,            -- 쿠팡/네이버 SERP 상위 SKU 식별자 (productId 등)
  source          text NOT NULL DEFAULT 'coupang',  -- 'coupang' | 'naver'
  product_title   text,                     -- 수집 당시 상품명 (디버그·드릴다운용)
  category_top    text NOT NULL,            -- health | living | digital | other
  aspect          text NOT NULL,            -- 표준 키 8축 (위 참조)
  sentiment       text NOT NULL,            -- 'pos' | 'neg' | 'neu'
  snippet         text,                     -- 근거 리뷰 발췌 (≤120자)
  confidence      real NOT NULL DEFAULT 0.7,
  captured_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT jimscanner_review_aspects_sentiment_chk
    CHECK (sentiment IN ('pos', 'neg', 'neu'))
);

CREATE INDEX IF NOT EXISTS jimscanner_review_aspects_cat_aspect
  ON jimscanner_review_aspects(category_top, aspect, sentiment, captured_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_review_aspects_sku
  ON jimscanner_review_aspects(sku_external_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_review_aspects_captured
  ON jimscanner_review_aspects(captured_at DESC);

ALTER TABLE jimscanner_review_aspects ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role) 만 접근.

-- ────────────────────────────────────────────────────────────
-- 집계 뷰: 카테고리 × aspect 약점 축
--   neg_ratio  = 부정 / 전체 (0~1)
--   last_30d   = 최근 30일 내 캡처가 1건이라도 있으면 true (신선도 플래그)
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_category_aspect_weakness AS
SELECT
  category_top,
  aspect,
  COUNT(*) FILTER (WHERE sentiment = 'neg')                            AS neg_count,
  COUNT(*)                                                              AS total_count,
  ROUND(
    COUNT(*) FILTER (WHERE sentiment = 'neg')::numeric
      / NULLIF(COUNT(*), 0),
    4
  )                                                                     AS neg_ratio,
  bool_or(captured_at >= now() - interval '30 days')                    AS last_30d,
  MAX(captured_at)                                                      AS last_captured_at
FROM jimscanner_review_aspects
GROUP BY category_top, aspect;

GRANT SELECT ON v_category_aspect_weakness TO service_role;
