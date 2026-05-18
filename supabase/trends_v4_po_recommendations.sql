-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — Pin Newsvendor PO 추천 (2026-05-18)
-- ─────────────────────────────────────────────────────────────
-- 핀(jimscanner_trends_pins) 단위 초도 발주량 추천.
-- 입력 시너지:
--   #13 카테고리 KM 생존곡선 → 잔존 수요일수 (demand_p10/p50/p90)
--   #17 반품률 추정         → return_rate
--   #18 가격탄력성, #12 단위가 분위수 → price-demand 곡선
--   #31 트렌드 반감기       → 수요 감쇠
--   #14 공급사 신뢰성       → unit_cost / 실손율 보정
-- 출력: newsvendor 최적해 + bootstrap 으로 P10/P50/P90 권장 수량과 기대 마진.
-- 핀별 일배치 cron (scripts/run-crons.mjs)
-- 노출 정책: RLS enable + 정책 없음 → service-role 만 접근.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_pin_po_recommendations (
  -- 기존 핀 식별자(복합키) 그대로 매핑. pin_id 컬럼이 따로 없는 구조라서 (keyword, source) 를 PK 로 차용.
  pin_keyword text NOT NULL,
  pin_source  text NOT NULL,

  -- 수요 분포 (단위: 30일 기준 예상 판매 수량)
  demand_p10 numeric NOT NULL,
  demand_p50 numeric NOT NULL,
  demand_p90 numeric NOT NULL,

  -- 보조 입력
  return_rate numeric NOT NULL DEFAULT 0.10,    -- 반품/실손율 (0~1)
  unit_cost   numeric NOT NULL,                  -- 단가 (배송/관세 포함 KRW)
  price       numeric NOT NULL,                  -- 판매가 (KRW)

  -- 출력
  recommended_qty integer NOT NULL,
  expected_profit numeric NOT NULL,              -- 기대 마진 (KRW)

  -- 가정 분해 — 호버 위젯에 노출
  -- { critical_ratio, contribution_margin, demand_source, decay_halflife_days,
  --   km_survival_days, elasticity_curve, supplier_reliability, samples: number,
  --   bootstrap: [qty...], notes? }
  assumptions jsonb NOT NULL DEFAULT '{}'::jsonb,

  computed_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (pin_keyword, pin_source)
);

CREATE INDEX IF NOT EXISTS jimscanner_pin_po_recommendations_computed_at
  ON jimscanner_pin_po_recommendations(computed_at DESC);

ALTER TABLE jimscanner_pin_po_recommendations ENABLE ROW LEVEL SECURITY;
-- service-role 만. 정책 X.
