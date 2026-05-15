-- ────────────────────────────────────────────────────────────
-- 현금 회수 시뮬레이터 — Payback Simulator (PR-Payback-1, 2026-05-16)
-- ────────────────────────────────────────────────────────────
-- 목적: 위탁 셀러가 "자본 N만원 → 며칠 만에 회수되나" 답하도록
--      product × capital × velocity 시나리오를 산출/캐시.
-- 사용처:
--   - /admin/trend-radar/products/[id] : 12개 시나리오 그리드
--   - /admin/trend-radar : 회수속도순 정렬
-- ────────────────────────────────────────────────────────────

-- 1) 시뮬레이션 결과 저장 (시나리오 단위, 캐시 또는 즐겨찾기용)
CREATE TABLE IF NOT EXISTS jimscanner_payback_sims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  capital_won numeric NOT NULL,        -- 투입 자본 (원)
  unit_cost numeric NOT NULL,          -- 도매가 단가 (원)
  sale_price numeric NOT NULL,         -- 추정 판매가 (원)
  daily_velocity numeric NOT NULL,     -- 추정 일판매수량 (개/일)
  margin_pct numeric NOT NULL,         -- 마진율 (%)

  -- 산출 결과
  payback_days numeric NOT NULL,       -- 원금 회수 일수 (NULL이면 회수 불가)
  roi_90d numeric NOT NULL,            -- 90일 누적 ROI (%)

  -- 입력 파라미터 (재현용)
  sim_params jsonb NOT NULL DEFAULT '{}'::jsonb,

  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_payback_sims_product
  ON jimscanner_payback_sims(product_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_payback_sims_payback
  ON jimscanner_payback_sims(payback_days ASC, computed_at DESC);

ALTER TABLE jimscanner_payback_sims ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role) 만.


-- 2) RPC: 단일 product 시뮬레이션
--    입력: product_id, capital_won, velocity_override (NULL이면 commerce_score 기반 추정)
--    출력: 시나리오 단일 row (computed)
--
-- velocity 추정 모델 (V0):
--   commerce_score (0~100) → 일판매수량 (0.3 ~ 8 개/일)
--   velocity = max(0.3, commerce_score / 12.5)
--
-- sale_price 추정 모델 (V0):
--   margin_pct = 30 (default) — 추후 marketplace SERP 데이터로 교체
--   sale_price = unit_cost × (1 + margin_pct/100)
CREATE OR REPLACE FUNCTION jimscanner_simulate_payback(
  p_product_id uuid,
  p_capital_won numeric DEFAULT 1000000,
  p_velocity_override numeric DEFAULT NULL,
  p_margin_pct numeric DEFAULT 30
)
RETURNS TABLE (
  product_id uuid,
  capital_won numeric,
  unit_cost numeric,
  sale_price numeric,
  daily_velocity numeric,
  margin_pct numeric,
  units_purchasable int,
  daily_profit numeric,
  payback_days numeric,
  roi_90d numeric,
  warning text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_unit_cost numeric;
  v_commerce numeric;
  v_velocity numeric;
  v_sale_price numeric;
  v_units int;
  v_daily_profit numeric;
  v_payback numeric;
  v_roi numeric;
  v_warning text := NULL;
BEGIN
  -- 도매가: 가장 최근 ggsan 또는 supplier 가격
  SELECT COALESCE(
    (SELECT price_krw FROM jimscanner_trends_supplier
       WHERE product_id = p_product_id AND price_krw IS NOT NULL
       ORDER BY collected_at DESC LIMIT 1),
    (SELECT g.price_krw FROM jimscanner_ggsan_products g
       JOIN jimscanner_trends_aliases a ON a.alias = g.title OR g.title ILIKE '%' || a.alias || '%'
       WHERE a.product_id = p_product_id AND g.price_krw IS NOT NULL
       ORDER BY g.last_seen_at DESC LIMIT 1)
  ) INTO v_unit_cost;

  IF v_unit_cost IS NULL OR v_unit_cost <= 0 THEN
    v_unit_cost := 10000;  -- 보수적 default
    v_warning := 'no_supplier_price';
  END IF;

  -- 최신 commerce_score → velocity 추정
  SELECT commerce_score INTO v_commerce
  FROM jimscanner_trends_scores
  WHERE product_id = p_product_id
  ORDER BY computed_at DESC LIMIT 1;

  v_velocity := COALESCE(p_velocity_override, GREATEST(0.3, COALESCE(v_commerce, 30) / 12.5));

  v_sale_price := v_unit_cost * (1 + p_margin_pct / 100.0);
  v_units := GREATEST(0, floor(p_capital_won / v_unit_cost)::int);
  v_daily_profit := v_velocity * (v_sale_price - v_unit_cost);

  IF v_daily_profit <= 0 THEN
    v_payback := 9999;
    v_warning := COALESCE(v_warning, 'negative_margin');
  ELSE
    v_payback := round(p_capital_won / v_daily_profit, 2);
  END IF;

  -- 90일 누적 ROI: 자본의 회전을 고려해 단순화 — 90일간 회수+재투자 가정 시 일일 ROI × 90
  IF p_capital_won > 0 THEN
    v_roi := round((v_daily_profit * 90 / p_capital_won) * 100, 2);
  ELSE
    v_roi := 0;
  END IF;

  IF v_payback > 120 AND v_warning IS NULL THEN
    v_warning := 'slow_payback';
  END IF;

  RETURN QUERY SELECT
    p_product_id,
    p_capital_won,
    v_unit_cost,
    v_sale_price,
    v_velocity,
    p_margin_pct,
    v_units,
    v_daily_profit,
    v_payback,
    v_roi,
    v_warning;
END;
$$;

-- 3) 보드용: 모든 상품의 payback 산출 (기본 자본 100만원 + 기본 velocity)
CREATE OR REPLACE FUNCTION jimscanner_payback_board(
  p_capital_won numeric DEFAULT 1000000,
  p_margin_pct numeric DEFAULT 30,
  p_result_limit int DEFAULT 200
)
RETURNS TABLE (
  product_id uuid,
  canonical_name text,
  category_top text,
  final_score numeric,
  unit_cost numeric,
  daily_velocity numeric,
  payback_days numeric,
  roi_90d numeric,
  warning text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH latest_scores AS (
    SELECT DISTINCT ON (s.product_id)
      s.product_id, s.commerce_score, s.final_score, s.computed_at
    FROM jimscanner_trends_scores s
    ORDER BY s.product_id, s.computed_at DESC
  ),
  base AS (
    SELECT
      p.id AS product_id,
      p.canonical_name,
      p.category_top,
      ls.final_score,
      ls.commerce_score,
      COALESCE(
        (SELECT price_krw FROM jimscanner_trends_supplier sup
           WHERE sup.product_id = p.id AND sup.price_krw IS NOT NULL
           ORDER BY sup.collected_at DESC LIMIT 1),
        10000
      ) AS unit_cost,
      GREATEST(0.3, COALESCE(ls.commerce_score, 30) / 12.5) AS daily_velocity
    FROM jimscanner_trends_products p
    LEFT JOIN latest_scores ls ON ls.product_id = p.id
  ),
  computed AS (
    SELECT
      product_id,
      canonical_name,
      category_top,
      final_score,
      unit_cost,
      daily_velocity,
      unit_cost * (p_margin_pct / 100.0) AS unit_margin,
      daily_velocity * (unit_cost * (p_margin_pct / 100.0)) AS daily_profit
    FROM base
  )
  SELECT
    product_id,
    canonical_name,
    category_top,
    final_score,
    unit_cost,
    daily_velocity,
    CASE WHEN daily_profit > 0
         THEN round(p_capital_won / daily_profit, 2)
         ELSE 9999 END AS payback_days,
    CASE WHEN p_capital_won > 0
         THEN round((daily_profit * 90 / p_capital_won) * 100, 2)
         ELSE 0 END AS roi_90d,
    CASE
      WHEN daily_profit <= 0 THEN 'negative_margin'
      WHEN p_capital_won / NULLIF(daily_profit, 0) > 120 THEN 'slow_payback'
      ELSE NULL
    END AS warning
  FROM computed
  ORDER BY payback_days ASC
  LIMIT p_result_limit;
$$;
