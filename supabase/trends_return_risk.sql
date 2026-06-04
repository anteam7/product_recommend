-- ─────────────────────────────────────────────────────────────
-- 반품·교환 보정 실효마진 게이트 (PR — 2026-06-04)
-- ─────────────────────────────────────────────────────────────
-- 목적: commerce_score·순마진은 '판매 성사' 기준일 뿐, 위탁 셀러가
--   실제로 떠안는 반품·교환 비용(왕복배송비 + 재포장 손실 + 불량 폐기)을
--   반영하지 못한다. product 별 반품 리스크 사전치 + 버즈 시그널을 합쳐
--   순마진을 할인한 effective_margin_ratio 를 적재한다.
--
-- 채우는 주체: scripts/recompute-return-risk.mjs (로컬, service-role)
-- 노출 정책: RLS enable + 정책 미정의 = service-role 만 접근
--   (기존 jimscanner_trends_* 패턴과 동일)
-- 관련 문서: docs/trend-radar-v4-execution-plan.md
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_return_risk (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  -- category_top 기반 한국 이커머스 반품률 사전치 (0~1).
  --   의류/신발 0.20~0.30, 식품/건강 0.03~0.05, 디지털 0.08 등.
  category_return_prior numeric NOT NULL DEFAULT 0 CHECK (category_return_prior >= 0 AND category_return_prior <= 1),

  -- raw/market 본문에서 product 별칭과 동반 출현하는 반품 토큰
  --   ('사이즈 안맞'·'불량'·'반품'·'교환'·'환불'·'AS') 빈도 기반 가산치 (0~1).
  buzz_return_signal numeric NOT NULL DEFAULT 0 CHECK (buzz_return_signal >= 0 AND buzz_return_signal <= 1),

  -- 사이즈/색상 변형 페널티 (0~1). 의류·신발처럼 변형이 많을수록 오배송·교환 ↑.
  size_variant_penalty numeric NOT NULL DEFAULT 0 CHECK (size_variant_penalty >= 0 AND size_variant_penalty <= 1),

  -- 합산 추정 반품률 (prior + buzz + size, 0~1 클램프).
  estimated_return_rate numeric NOT NULL DEFAULT 0 CHECK (estimated_return_rate >= 0 AND estimated_return_rate <= 1),

  -- 반품 1건당 추정 손실(원): 왕복배송비(SHIP*2) + 재포장·폐기 손실.
  loss_per_return_krw numeric NOT NULL DEFAULT 0,

  -- 표면 순마진(반품 미반영) — 비교용 캐시.
  surface_margin_ratio numeric,

  -- 반품 보정 후 실효마진율 (음수 가능 — 마진이 무너지는 후보).
  effective_margin_ratio numeric,

  -- 디버깅·UI breakdown 용 ({tokens_found, alias_count, supplier_price, ...}).
  components jsonb NOT NULL DEFAULT '{}'::jsonb,

  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_return_risk_product_at
  ON jimscanner_trends_return_risk(product_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_return_risk_effective_recent
  ON jimscanner_trends_return_risk(effective_margin_ratio ASC, computed_at DESC);

ALTER TABLE jimscanner_trends_return_risk ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.
