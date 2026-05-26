-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 핀 에이징 코호트 (Improvement Scout, 2026-05-27)
-- ─────────────────────────────────────────────────────────────
-- 목적: jimscanner_trends_products 에 핀 메타를 추가하고,
--       핀 시점 vs 최신 final_score 델타를 코호트(0-7d / 7-30d / 30d+)
--       단위로 반환하는 RPC 를 정의.
-- 사용처: /admin/trend-radar/pin-aging 페이지.
-- ─────────────────────────────────────────────────────────────

-- 1) products 에 핀 메타 컬럼 추가
ALTER TABLE jimscanner_trends_products
  ADD COLUMN IF NOT EXISTS pinned       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pinned_at    timestamptz,
  ADD COLUMN IF NOT EXISTS pin_action   text,        -- 'revive' | 'hold' | 'drop' | NULL
  ADD COLUMN IF NOT EXISTS pin_action_at timestamptz,
  ADD COLUMN IF NOT EXISTS pin_hold_until timestamptz,
  ADD COLUMN IF NOT EXISTS pin_reason   text;

CREATE INDEX IF NOT EXISTS jimscanner_trends_products_pinned
  ON jimscanner_trends_products(pinned, pinned_at DESC)
  WHERE pinned;


-- 2) RPC: 핀 에이징 코호트 조회
--    각 핀 상품에 대해 (a) 핀 시점 가장 가까운 score row 의 final_score
--                       (b) 최신 final_score 의 차이를 계산.
--    bucket = 0-7d / 7-30d / 30d+
--    recommended_action = revive(상승≥10) / hold(±10 이내) / drop(하락≥10)
DROP FUNCTION IF EXISTS jimscanner_pin_aging_cohort();

CREATE OR REPLACE FUNCTION jimscanner_pin_aging_cohort()
RETURNS TABLE (
  product_id uuid,
  canonical_name text,
  category_top text,
  brand text,
  pinned_at timestamptz,
  age_days int,
  bucket text,
  score_then numeric,
  score_now numeric,
  delta_total numeric,
  delta_components jsonb,
  recommended_action text,
  current_action text,
  hold_until timestamptz
)
LANGUAGE sql
STABLE
AS $$
  WITH pinned AS (
    SELECT
      p.id,
      p.canonical_name,
      p.category_top,
      p.brand,
      p.pinned_at,
      p.pin_action,
      p.pin_hold_until
    FROM jimscanner_trends_products p
    WHERE p.pinned = true
      AND p.pinned_at IS NOT NULL
  ),
  score_then AS (
    SELECT DISTINCT ON (s.product_id)
      s.product_id,
      s.final_score,
      s.trend_score,
      s.commerce_score,
      s.supplier_score,
      s.competition_score,
      s.computed_at
    FROM jimscanner_trends_scores s
    JOIN pinned pn ON pn.id = s.product_id
    WHERE s.computed_at <= pn.pinned_at + interval '24 hours'
    ORDER BY s.product_id, ABS(EXTRACT(EPOCH FROM (s.computed_at - pn.pinned_at)))
  ),
  score_now AS (
    SELECT DISTINCT ON (s.product_id)
      s.product_id,
      s.final_score,
      s.trend_score,
      s.commerce_score,
      s.supplier_score,
      s.competition_score,
      s.computed_at
    FROM jimscanner_trends_scores s
    JOIN pinned pn ON pn.id = s.product_id
    ORDER BY s.product_id, s.computed_at DESC
  )
  SELECT
    pn.id AS product_id,
    pn.canonical_name,
    pn.category_top,
    pn.brand,
    pn.pinned_at,
    GREATEST(0, EXTRACT(DAY FROM (now() - pn.pinned_at))::int) AS age_days,
    CASE
      WHEN now() - pn.pinned_at < interval '7 days'  THEN '0-7d'
      WHEN now() - pn.pinned_at < interval '30 days' THEN '7-30d'
      ELSE '30d+'
    END AS bucket,
    st.final_score AS score_then,
    sn.final_score AS score_now,
    COALESCE(sn.final_score, 0) - COALESCE(st.final_score, 0) AS delta_total,
    jsonb_build_object(
      'trend',       COALESCE(sn.trend_score, 0)       - COALESCE(st.trend_score, 0),
      'commerce',    COALESCE(sn.commerce_score, 0)    - COALESCE(st.commerce_score, 0),
      'supplier',    COALESCE(sn.supplier_score, 0)    - COALESCE(st.supplier_score, 0),
      'competition', COALESCE(sn.competition_score, 0) - COALESCE(st.competition_score, 0)
    ) AS delta_components,
    CASE
      WHEN st.final_score IS NULL OR sn.final_score IS NULL THEN 'hold'
      WHEN sn.final_score - st.final_score >=  10 THEN 'revive'
      WHEN sn.final_score - st.final_score <= -10 THEN 'drop'
      ELSE 'hold'
    END AS recommended_action,
    pn.pin_action AS current_action,
    pn.pin_hold_until AS hold_until
  FROM pinned pn
  LEFT JOIN score_then st ON st.product_id = pn.id
  LEFT JOIN score_now  sn ON sn.product_id = pn.id
  ORDER BY pn.pinned_at DESC;
$$;

COMMENT ON FUNCTION jimscanner_pin_aging_cohort() IS
  '핀된 jimscanner_trends_products 에 대해 핀시점/최신 final_score 델타와 추천 액션을 코호트(0-7d/7-30d/30d+) 단위로 반환.';
