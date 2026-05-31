-- ─────────────────────────────────────────────────────────────
-- 수요 공출현 네트워크 — 텍스트 동시언급 기반 번들·인접상품 발굴 (2026-05-31)
-- ─────────────────────────────────────────────────────────────
-- jimscanner_market_raw / jimscanner_trends_raw 의 텍스트(title/description/payload)를
-- 문서 단위로 스캔하고, jimscanner_trends_aliases 사전으로 각 문서에 등장한 product 를 추출.
-- 같은 문서에 함께 등장한 product 쌍의 동시언급을 집계 (PMI 로 우연 동반 보정).
--
-- 적재 주체: src/app/api/cron/build-cooccurrence/route.ts (service-role)
-- 노출 정책: RLS enable + 정책 정의 X = service-role 만 접근 (기존 trends_* 패턴 동일)
-- product_a < product_b (uuid text 정렬) 로 무방향 쌍 1행만 유지.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_cooccurrence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  product_a uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  product_b uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  doc_count      int NOT NULL DEFAULT 0,     -- 두 상품이 함께 등장한 문서 수
  source_breadth int NOT NULL DEFAULT 0,     -- 함께 등장한 서로 다른 source 수 (다채널일수록 신뢰↑)
  pmi            numeric NOT NULL DEFAULT 0,  -- Pointwise Mutual Information (우연 동반 보정, log2)

  last_seen   timestamptz NOT NULL DEFAULT now(),
  computed_at timestamptz NOT NULL DEFAULT now(),

  CHECK (product_a < product_b),
  UNIQUE (product_a, product_b)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_cooccurrence_a
  ON jimscanner_trends_cooccurrence(product_a, doc_count DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_cooccurrence_b
  ON jimscanner_trends_cooccurrence(product_b, doc_count DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_cooccurrence_strength
  ON jimscanner_trends_cooccurrence(doc_count DESC, pmi DESC);

ALTER TABLE jimscanner_trends_cooccurrence ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.
