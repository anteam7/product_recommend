-- ─────────────────────────────────────────────────────────────
-- 발굴 의사결정 캡처 + 후회 캘리브레이션 (PR-DECISIONS-1, 2026-06-02)
-- ─────────────────────────────────────────────────────────────
-- 추천 페이지(trend-radar/recommend)가 read-only V0 라 운영자가 후보에
-- 행동(채택/보류/반려)해도 기록이 남지 않았다. 본 테이블이 의사결정을
-- 캡처하고, 결정 시점의 점수 스냅샷을 보존해 사후 변화(놓친 위너/헛다리)를
-- 회고할 수 있게 한다.
--
-- 노출 정책: RLS enable + 정책 정의 X = service-role(어드민)만 접근.
--   (기존 jimscanner_trends_* 패턴과 동일)
-- 관련 UI: /admin/trend-radar/recommend (캡처), /admin/trend-radar/retro (회고)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 대상: ggsan 카탈로그 기준(goods_no) 또는 v4 canonical product(product_id).
  -- recommend 페이지는 ggsan 기반이므로 주로 goods_no 사용.
  product_id uuid REFERENCES jimscanner_trends_products(id) ON DELETE SET NULL,
  goods_no   text,                       -- jimscanner_ggsan_products.goods_no (FK 강제 X — 카탈로그 휘발 가능)

  decision text NOT NULL CHECK (decision IN ('reviewed','adopted','sourced','deferred','rejected')),
  reason_code text,                      -- 'too_competitive' | 'low_margin' | 'thin_demand' | 'good_fit' | 'imminent' | 'risky_supplier' | 'other'
  note text,                             -- 운영자 사유 1줄

  -- 결정 시점 점수 스냅샷 (final_score 및 컴포넌트). 사후 비교의 기준선.
  -- 예: {"final_score": 42.1, "tv_score": 1.2, "search_score": 0.8, "price_krw": 15500, "is_imminent": true, "ggsan_status": "active"}
  score_at_decision jsonb NOT NULL DEFAULT '{}'::jsonb,

  decided_by text,                       -- 어드민 이메일
  decided_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_decisions_goods_at
  ON jimscanner_trends_decisions(goods_no, decided_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_decisions_product_at
  ON jimscanner_trends_decisions(product_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_decisions_decision_at
  ON jimscanner_trends_decisions(decision, decided_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_decisions_reason
  ON jimscanner_trends_decisions(reason_code, decision);

ALTER TABLE jimscanner_trends_decisions ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role) 만.
