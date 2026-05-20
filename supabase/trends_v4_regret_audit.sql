-- ────────────────────────────────────────────────────────────
-- PR-4.X: Rejected Pin 사후 후회 감사 (False-Negative Audit)
-- ────────────────────────────────────────────────────────────
-- 거절(reject)/통과(pass) 의사결정 이력을 보존하고, 30/60/90일 후
-- 사후 신호(naver_tvtime 재편성, ggsan 재입고/가격, SERP/뉴스/블로그 인입)를
-- 재평가하여 regret_score 를 계산. 거절 결정의 false-negative 비율을 추적.
-- ────────────────────────────────────────────────────────────

-- 1) 의사결정 이력 — 핀 결정(거절/통과) 의 단일 source of truth
-- 기존 jimscanner_trends_pins 가 pin=ACCEPT 만 보존하므로, REJECT/PASS 도
-- 명시적으로 적재한다. target_type=keyword|product 로 두 단위 모두 수용.
CREATE TABLE IF NOT EXISTS jimscanner_trends_pin_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type text NOT NULL CHECK (target_type IN ('keyword','product')),
  target_key text NOT NULL,             -- keyword 문자열 or product id
  source text,                          -- keyword 의 경우 'naver_shopping_insight' 등
  decision text NOT NULL CHECK (decision IN ('accept','reject','pass')),
  reason text,                          -- 자유서술 또는 코드값 (irrelevant / overcrowded / low_margin / off_topic 등)
  reason_code text,                     -- 분류용 (NULL 가능, dashboard 집계 시 NULL → 'unspecified')
  decided_by text,                      -- email
  decided_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_type, target_key, decided_at)
);
CREATE INDEX IF NOT EXISTS jimscanner_trends_pin_decisions_target
  ON jimscanner_trends_pin_decisions(target_type, target_key, decided_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_pin_decisions_decision_at
  ON jimscanner_trends_pin_decisions(decision, decided_at DESC);

ALTER TABLE jimscanner_trends_pin_decisions ENABLE ROW LEVEL SECURITY;

-- 2) 사후 감사 결과 — 거절 건당 1+ 행. 30/60/90 일 시점에 별도 row.
-- regret_score 0~100. signals JSON 에 개별 시그널 값 보존.
CREATE TABLE IF NOT EXISTS jimscanner_trends_regret_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id uuid REFERENCES jimscanner_trends_pin_decisions(id) ON DELETE CASCADE,
  -- decision_id 가 없을 수도 있다 (proxy 거절: keywords.pinned=false + classified).
  -- 그 경우 target_type/target_key 로만 식별.
  target_type text NOT NULL,
  target_key text NOT NULL,
  audited_at timestamptz NOT NULL DEFAULT now(),
  age_days int NOT NULL,                -- decided_at 으로부터 며칠 후 감사인지 (30/60/90 권장)
  regret_score numeric NOT NULL,        -- 0~100
  signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- {
  --   "tvtime_reappearance": int,         // 거절 이후 TV 노출 횟수
  --   "ggsan_restock": bool,              // 재입고 여부
  --   "ggsan_price_drop_pct": number,     // 가격 인하 %
  --   "serp_competitor_growth": number,   // SERP 경쟁자 진입 증가
  --   "news_velocity": number,            // 뉴스 인입 속도 (건/일)
  --   "blog_velocity": number             // 블로그 인입 속도 (건/일)
  -- }
  notes text
);
CREATE INDEX IF NOT EXISTS jimscanner_trends_regret_audits_target
  ON jimscanner_trends_regret_audits(target_type, target_key, audited_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_regret_audits_score
  ON jimscanner_trends_regret_audits(regret_score DESC, audited_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_regret_audits_decision
  ON jimscanner_trends_regret_audits(decision_id, audited_at DESC);

ALTER TABLE jimscanner_trends_regret_audits ENABLE ROW LEVEL SECURITY;

-- 3) 편의 뷰 — keyword 단위 거절 proxy (decision 레코드가 없을 때 대체)
-- keywords.pinned=false + classified_intent IS NOT NULL 인 가장 최근 row
CREATE OR REPLACE VIEW jimscanner_trends_keyword_reject_proxy AS
SELECT DISTINCT ON (keyword, source)
  keyword,
  source,
  classified_intent,
  classified_category,
  domain_score,
  collected_at AS decided_at
FROM jimscanner_trends_keywords
WHERE pinned = false
  AND classified_intent IS NOT NULL
ORDER BY keyword, source, collected_at DESC;
