-- ────────────────────────────────────────────────────────────
-- Charm Price Cliff anchor RPC (2026-05-25)
-- ────────────────────────────────────────────────────────────
-- 한국 소비자 가격절벽(₩9,900/₩19,900/₩29,900/₩49,900/₩99,900)에
-- 위탁 SKU 가 안착 가능한지 — ggsan 도매가 + 누적 비용 위에서
-- anchor 별 잔여 마진 헤드룸(₩, %)을 계산.
--
-- 호출 예시:
--   SELECT * FROM jimscanner_charm_price_anchor(
--     '1000004787',
--     '[9900,19900,29900,49900,99900]'::jsonb
--   );
--
-- 비용 모델 (v0, 위탁 + 네이버 스마트스토어 가정):
--   net = cliff × (1 - platform_fee 5.85% - pg_fee 3% - vat 10%)
--         - shipping_borne ₩3,000 - 도매가
--   headroom_pct = net / cliff × 100
--   status:
--     'safe'       — headroom_pct >= 20
--     'thin'       — 5 <= headroom_pct < 20
--     'underwater' — headroom_pct < 5
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_charm_price_anchor(
  p_goods_no text,
  p_cliffs jsonb DEFAULT '[9900,19900,29900,49900,99900]'::jsonb,
  p_platform_fee_pct numeric DEFAULT 5.85,
  p_pg_fee_pct numeric DEFAULT 3.0,
  p_vat_pct numeric DEFAULT 10.0,
  p_shipping_borne_krw integer DEFAULT 3000
)
RETURNS TABLE (
  goods_no text,
  wholesale_krw integer,
  cliff_anchor integer,
  net_margin_krw numeric,
  headroom_pct numeric,
  anchor_status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH gp AS (
    SELECT g.goods_no, g.price_krw AS wholesale_krw
    FROM jimscanner_ggsan_products g
    WHERE g.goods_no = p_goods_no
  ),
  cliffs AS (
    SELECT (jsonb_array_elements_text(p_cliffs))::int AS cliff_anchor
  ),
  cost_factor AS (
    SELECT (1.0 - (p_platform_fee_pct + p_pg_fee_pct + p_vat_pct) / 100.0) AS keep_ratio
  )
  SELECT
    gp.goods_no,
    gp.wholesale_krw,
    c.cliff_anchor,
    ROUND(c.cliff_anchor * cf.keep_ratio - p_shipping_borne_krw - COALESCE(gp.wholesale_krw, 0), 0) AS net_margin_krw,
    CASE
      WHEN c.cliff_anchor = 0 THEN 0
      ELSE ROUND(
        (c.cliff_anchor * cf.keep_ratio - p_shipping_borne_krw - COALESCE(gp.wholesale_krw, 0))
        / c.cliff_anchor * 100.0, 2
      )
    END AS headroom_pct,
    CASE
      WHEN gp.wholesale_krw IS NULL THEN 'unknown'
      WHEN (c.cliff_anchor * cf.keep_ratio - p_shipping_borne_krw - COALESCE(gp.wholesale_krw, 0))
           / c.cliff_anchor * 100.0 >= 20 THEN 'safe'
      WHEN (c.cliff_anchor * cf.keep_ratio - p_shipping_borne_krw - COALESCE(gp.wholesale_krw, 0))
           / c.cliff_anchor * 100.0 >= 5  THEN 'thin'
      ELSE 'underwater'
    END AS anchor_status
  FROM gp
  CROSS JOIN cliffs c
  CROSS JOIN cost_factor cf
  ORDER BY c.cliff_anchor;
$$;

REVOKE ALL ON FUNCTION jimscanner_charm_price_anchor(text, jsonb, numeric, numeric, numeric, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_charm_price_anchor(text, jsonb, numeric, numeric, numeric, integer) TO service_role;

COMMENT ON FUNCTION jimscanner_charm_price_anchor(text, jsonb, numeric, numeric, numeric, integer) IS
  'Charm price cliff anchor headroom for a ggsan SKU. Used by /admin/trend-radar/recommend cliff column.';
