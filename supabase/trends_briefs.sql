-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 — Go/No-Go 의사결정 브리프 (2026-06-05)
-- ─────────────────────────────────────────────────────────────
-- 발굴 후보를 LLM 으로 트리아지해서 '평결(go/watch/pass) + 근거 + 블로커 + 다음 액션'
-- 구조화 브리프를 캐시. products/[id] 상단 카드 + opportunity 'Go 후보 피드' 가 읽음.
--
-- 입력: 이미 적재된 4점수·score_components·aliases(증거 발화)·supplier 행을 한 프롬프트로 묶어
--       scripts/trends-generate-briefs.mjs 크론이 생성 (claude CLI 인프라 재사용).
-- 노출 정책: 기존 jimscanner_trends_* 와 동일 — RLS enable, 정책 정의 X = service-role 만 접근.
-- 관련: docs/trend-radar-v4-execution-plan.md
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  verdict text NOT NULL CHECK (verdict IN ('go', 'watch', 'pass')),
  confidence numeric NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),

  top_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,   -- ["근거1", "근거2", "근거3"]
  biggest_blocker text,                              -- 가장 큰 진입 장애 (없으면 NULL)
  recommended_action text,                           -- 운영자 다음 액션 1문장
  suggested_price_band text,                         -- 권장 판매가 밴드 (예: "19,000~24,000원")

  -- 생성 근거 스냅샷 (final_score 등 — 사후 추적·재랭킹 학습용)
  basis jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- 운영자 환류 (채택/기각 → 능동학습 재랭킹 루프)
  operator_decision text CHECK (operator_decision IN ('adopted', 'rejected')),
  operator_note text,
  operator_decided_at timestamptz,

  model text,                                        -- 'claude-code-cli' 등
  generated_at timestamptz NOT NULL DEFAULT now()
);

-- product_id 별 최신 brief 조회용
CREATE INDEX IF NOT EXISTS jimscanner_trends_briefs_product_at
  ON jimscanner_trends_briefs(product_id, generated_at DESC);

-- 'Go 후보 피드' 조회용 (최신 verdict 우선)
CREATE INDEX IF NOT EXISTS jimscanner_trends_briefs_verdict_at
  ON jimscanner_trends_briefs(verdict, generated_at DESC);

ALTER TABLE jimscanner_trends_briefs ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.
