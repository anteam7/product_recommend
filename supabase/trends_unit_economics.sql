-- ─────────────────────────────────────────────────────────────
-- 단위경제성 게이트 — 기대 단위순이익(₩) 환산 뷰 (2026-06-01)
-- ─────────────────────────────────────────────────────────────
-- 발굴 후보를 추상점수(0~100)가 아닌 실제 '원(₩) 단위 기대 순이익'으로 환산.
--   net = 추정판매가 − 랜디드원가 − 배송 − 판매수수료 − 부가세
-- 상수 출처: scripts/coupang-recompute-margins.mjs (메모리 coupang_pricing_model)
--   FEE_RATE = 0.106 (기타영양제 73137 판매수수료, 결제비 포함)
--   SHIP     = 3000  (출고 배송비)
--   VAT      = 판매가 / 11
--
-- 입력:
--   landed_cost          = product 별 최저 supplier.price_krw (한국 도착 추정가)
--   estimated_sell_price = commerce 신호 관찰 판매가 (score_components.commerce.sell_price_krw)
--                          없으면 랜디드원가 × 2.2 휴리스틱
--
-- 노출 정책: 기반 테이블이 모두 RLS enable + 정책 X (service-role 전용)이므로
--   뷰도 동일하게 service-role 만 접근 (security_invoker).
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW jimscanner_trends_unit_economics
WITH (security_invoker = true)
AS
WITH latest_score AS (
  SELECT DISTINCT ON (product_id)
    product_id,
    score_components,
    final_score,
    computed_at
  FROM jimscanner_trends_scores
  ORDER BY product_id, computed_at DESC
),
best_supplier AS (
  SELECT DISTINCT ON (product_id)
    product_id,
    price_krw            AS landed_cost,
    supplier_source,
    raw_payload
  FROM jimscanner_trends_supplier
  WHERE price_krw IS NOT NULL AND price_krw > 0
  ORDER BY product_id, price_krw ASC
),
base AS (
  SELECT
    p.id            AS product_id,
    p.canonical_name,
    p.category_top,
    bs.landed_cost,
    bs.supplier_source,
    ls.final_score,
    -- 관찰 판매가 우선, 없으면 랜디드원가 휴리스틱
    COALESCE(
      NULLIF((ls.score_components -> 'commerce' ->> 'sell_price_krw')::numeric, 0),
      NULLIF((ls.score_components -> 'commerce' ->> 'observed_price_krw')::numeric, 0),
      NULLIF((bs.raw_payload ->> 'observed_sell_price_krw')::numeric, 0),
      round(bs.landed_cost * 2.2)
    ) AS estimated_sell_price,
    CASE
      WHEN COALESCE(
        (ls.score_components -> 'commerce' ->> 'sell_price_krw')::numeric,
        (ls.score_components -> 'commerce' ->> 'observed_price_krw')::numeric,
        (bs.raw_payload ->> 'observed_sell_price_krw')::numeric
      ) IS NOT NULL THEN 'observed'
      ELSE 'heuristic'
    END AS sell_price_source
  FROM jimscanner_trends_products p
  JOIN best_supplier bs ON bs.product_id = p.id
  LEFT JOIN latest_score ls ON ls.product_id = p.id
),
calc AS (
  SELECT
    *,
    round(estimated_sell_price * 0.106)                                  AS fee_krw,
    round(estimated_sell_price / 11.0)                                   AS vat_krw,
    3000                                                                  AS ship_krw,
    round(estimated_sell_price - landed_cost - 3000
          - round(estimated_sell_price * 0.106)
          - round(estimated_sell_price / 11.0))                          AS expected_net_unit
  FROM base
)
SELECT
  product_id,
  canonical_name,
  category_top,
  final_score,
  supplier_source,
  sell_price_source,
  landed_cost,
  estimated_sell_price,
  fee_krw,
  vat_krw,
  ship_krw,
  expected_net_unit,
  round((expected_net_unit::numeric / NULLIF(estimated_sell_price, 0)) * 100, 2) AS net_margin_pct,
  CASE
    WHEN expected_net_unit < 0 THEN 'loss'
    WHEN expected_net_unit < 2000
      OR (expected_net_unit::numeric / NULLIF(estimated_sell_price, 0)) * 100 < 15 THEN 'thin'
    ELSE 'pass'
  END AS gate_status
FROM calc;

COMMENT ON VIEW jimscanner_trends_unit_economics IS
  '발굴 후보 단위순이익 환산 게이트. net = 판매가-랜디드원가-배송-수수료(0.106)-부가세(/11). 출처: coupang-recompute-margins.mjs';
