-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v5 — 검색의도 분해 (2026-05-15)
-- ─────────────────────────────────────────────────────────────
-- 목표:
--   naver_search_trend / shopping_insight 가 잡는 검색량 raw 에
--   "왜 검색하는가" (정보탐색 vs 비교 vs 거래) 시그널을 분리.
--
--   각 canonical product 에 대해 Naver autosuggest/관련검색어로 suffix
--   를 하베스트해서 의도 사전에 매핑하고 분포를 시계열로 저장.
--
-- 의도 사전:
--   transactional  : 최저가·구매·할인·직구·쿠폰 (지금 살 사람)
--   comparison     : 추천·비교·순위
--   review         : 후기·리뷰·내돈내산
--   informational  : 효능·부작용·성분 (궁금증)
--
-- 신규: jimscanner_trends_intent_signals
-- 보강: jimscanner_trends_scores.purchase_intent_score
-- ─────────────────────────────────────────────────────────────

-- 1) 의도 시그널 (시계열, 매 수집 시 새 row)
CREATE TABLE IF NOT EXISTS jimscanner_trends_intent_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  intent_class text NOT NULL,           -- 'transactional' | 'comparison' | 'review' | 'informational' | 'unknown'
  co_keyword text NOT NULL,             -- 동반 등장한 suffix/관련검색어 (예: "오메가3 최저가")
  volume numeric,                       -- 상대 volume (autosuggest 순위 기반 또는 관련검색어 가중치)
  source text NOT NULL,                 -- 'naver_autosuggest' | 'naver_related' | 'manual'

  collected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_intent_signals_product_at
  ON jimscanner_trends_intent_signals(product_id, collected_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_intent_signals_class_at
  ON jimscanner_trends_intent_signals(intent_class, collected_at DESC);

ALTER TABLE jimscanner_trends_intent_signals ENABLE ROW LEVEL SECURITY;
-- service-role only (어드민 한정)

-- 2) scores 보강: purchase_intent_score
ALTER TABLE jimscanner_trends_scores
  ADD COLUMN IF NOT EXISTS purchase_intent_score numeric
  CHECK (purchase_intent_score IS NULL OR (purchase_intent_score >= 0 AND purchase_intent_score <= 100));

-- 3) 최신 의도 분포 뷰 (UI 편의)
CREATE OR REPLACE VIEW jimscanner_trends_intent_latest AS
WITH ranked AS (
  SELECT
    product_id,
    intent_class,
    co_keyword,
    volume,
    source,
    collected_at,
    ROW_NUMBER() OVER (
      PARTITION BY product_id, co_keyword
      ORDER BY collected_at DESC
    ) AS rn
  FROM jimscanner_trends_intent_signals
)
SELECT product_id, intent_class, co_keyword, volume, source, collected_at
FROM ranked
WHERE rn = 1;
