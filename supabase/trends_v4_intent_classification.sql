-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 키워드 거래성 의도 게이트 (Intent-Routing 핀)
-- ─────────────────────────────────────────────────────────────
-- 기존 classify-trends-llm 가 카테고리만 분류하던 걸,
--   transactional / comparison / informational / navigational
-- 4-class + 확률벡터로 확장.
--
-- 동일 LLM 호출에 의도 필드를 함께 받으므로 추가 비용 ≈ 0.
-- ─────────────────────────────────────────────────────────────

-- 1) jimscanner_trends_intent — product 별 의도 분류 결과
CREATE TABLE IF NOT EXISTS jimscanner_trends_intent (
  product_id uuid PRIMARY KEY REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  -- top-1 의도 클래스
  intent_class text NOT NULL CHECK (intent_class IN (
    'transactional', 'comparison', 'informational', 'navigational'
  )),

  -- 4-class 확률 벡터 (합 ≈ 1.0)
  -- 예: {"transactional":0.62,"comparison":0.18,"informational":0.15,"navigational":0.05}
  intent_probs jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- 핀 자동승급 게이트:
  -- transactional >= 0.6 OR comparison >= 0.55 → 핀 큐로 라우팅
  -- informational-only → 후순위 큐
  is_pin_eligible boolean NOT NULL DEFAULT false,

  model text NOT NULL DEFAULT 'claude-code-cli',
  classified_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_intent_class
  ON jimscanner_trends_intent(intent_class);

CREATE INDEX IF NOT EXISTS jimscanner_trends_intent_pin_eligible
  ON jimscanner_trends_intent(is_pin_eligible, classified_at DESC)
  WHERE is_pin_eligible = true;

ALTER TABLE jimscanner_trends_intent ENABLE ROW LEVEL SECURITY;
-- 서비스 롤 전용 (어드민 한정) — 정책 정의 없음.
