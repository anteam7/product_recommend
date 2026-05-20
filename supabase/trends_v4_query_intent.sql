-- ────────────────────────────────────────────────────────────
-- PR-4.6: 쿼리 마이크로인텐트 분해 (2026-05-20)
-- ────────────────────────────────────────────────────────────
-- 각 canonical product 의 alias / 같은 카테고리 텍스트(82cook_talk·naver_blog·naver_news)를
-- 5종 마이크로 인텐트로 분류 후 share 누적.
--
-- 5 buckets:
--   price       : 가격탐색 ("싸게", "할인", "최저가", "가격")
--   compare     : 비교선택 ("비교", "추천", "vs", "어떤")
--   howto       : 사용법/품질 ("사용법", "후기", "효과", "품질", "어떻게")
--   trouble     : 트러블슈팅 ("부작용", "고장", "문제", "환불")
--   buy_source  : 구매처/정품 ("어디서", "직구", "정품", "구매처", "공식")
--
-- 같은 final_score 라도 buy_source share ≥ 30% 인 product 는 핀 우선순위 큐로 자동 push.
-- cron: scripts/classify-query-intent.mjs — 6시간마다
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_query_intent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  intent_bucket text NOT NULL CHECK (intent_bucket IN ('price','compare','howto','trouble','buy_source')),
  share numeric NOT NULL DEFAULT 0,        -- 0.0 ~ 1.0
  query_count int NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, intent_bucket, computed_at)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_query_intent_product
  ON jimscanner_trends_query_intent(product_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_query_intent_bucket
  ON jimscanner_trends_query_intent(intent_bucket, share DESC, computed_at DESC);

ALTER TABLE jimscanner_trends_query_intent ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.


-- VIEW: 각 product 의 최신 intent breakdown
CREATE OR REPLACE VIEW jimscanner_trends_query_intent_latest AS
SELECT DISTINCT ON (product_id, intent_bucket)
  product_id,
  intent_bucket,
  share,
  query_count,
  computed_at
FROM jimscanner_trends_query_intent
ORDER BY product_id, intent_bucket, computed_at DESC;


-- '구매처' 인텐트 우세 product 자동 핀 큐 (share ≥ 0.30)
CREATE OR REPLACE VIEW jimscanner_trends_buy_source_queue AS
SELECT
  qi.product_id,
  p.canonical_name,
  p.category_top,
  qi.share AS buy_source_share,
  qi.query_count,
  qi.computed_at
FROM jimscanner_trends_query_intent_latest qi
JOIN jimscanner_trends_products p ON p.id = qi.product_id
WHERE qi.intent_bucket = 'buy_source'
  AND qi.share >= 0.30
ORDER BY qi.share DESC, qi.query_count DESC;
