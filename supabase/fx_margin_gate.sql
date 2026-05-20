-- ────────────────────────────────────────────────────────────
-- FX 민감 마진 절벽 게이트 (2026-05-21)
-- ────────────────────────────────────────────────────────────
-- 환율 변동성을 외생 입력으로 다뤄, 핀 단위로 ±N×σ 시 마진 절벽 % 산출.
-- 입력:
--   1) jimscanner_exchange_rate_history (30일 매매기준율)
--   2) jimscanner_exchange_rates (현재 환율)
--   3) jimscanner_ggsan_products (핀 후보 도매가, KRW)
-- 출력:
--   - jimscanner_fx_margin_snapshot 뷰: 통화별 30d σ·avg·current
--   - jimscanner_fx_margin_gate RPC: 핀 단위 worst/best case 마진 시나리오
-- ────────────────────────────────────────────────────────────

-- 1) 통화별 30일 변동성 스냅샷
CREATE OR REPLACE VIEW jimscanner_fx_margin_snapshot AS
WITH stats AS (
  SELECT
    currency,
    AVG(rate_krw)::numeric(12, 4) AS avg_30d,
    COALESCE(STDDEV_POP(rate_krw), 0)::numeric(12, 4) AS sigma_30d,
    MIN(rate_krw)::numeric(12, 4) AS min_30d,
    MAX(rate_krw)::numeric(12, 4) AS max_30d,
    COUNT(*)::int AS n_days
  FROM jimscanner_exchange_rate_history
  WHERE rate_date >= (CURRENT_DATE - INTERVAL '30 days')
  GROUP BY currency
)
SELECT
  s.currency,
  s.avg_30d,
  s.sigma_30d,
  s.min_30d,
  s.max_30d,
  s.n_days,
  e.rate_krw AS current_rate,
  CASE
    WHEN s.sigma_30d > 0 THEN ((s.avg_30d - e.rate_krw) / s.sigma_30d)::real
    ELSE 0::real
  END AS fx_favor_score,
  CASE
    WHEN s.avg_30d > 0 THEN ((s.sigma_30d / s.avg_30d) * 100)::numeric(8, 4)
    ELSE 0::numeric(8, 4)
  END AS cv_pct
FROM stats s
LEFT JOIN jimscanner_exchange_rates e ON e.currency = s.currency;

GRANT SELECT ON jimscanner_fx_margin_snapshot TO service_role;

-- 2) 핀×통화 마진 게이트 RPC
--    가정:
--      - 핀 도매가는 KRW 로 표기되지만 실제 원가는 source_currency 기준
--      - 현재 마진율 = margin_pct (예: 0.30 = 30%)
--      - 환율이 ±sigma_mult × σ 만큼 변동 시 supplier_cost 가 비례 변동
--      - 새 마진율 = 1 - (1 - margin_pct) × (new_rate / current_rate)
--    fx_badge:
--      green  → fx_favor_score ≥ +0.5 (현재가 평균보다 σ/2 이상 낮음 → 진입 우호)
--      yellow → -0.5 < score < +0.5  (중립)
--      red    → fx_favor_score ≤ -0.5 (현재가 평균보다 σ/2 이상 높음 → 진입 보류)
CREATE OR REPLACE FUNCTION jimscanner_fx_margin_gate(
  margin_pct numeric DEFAULT 0.30,
  sigma_mult numeric DEFAULT 2.0,
  source_currency text DEFAULT 'CNY',
  cate_filter text DEFAULT NULL,
  result_limit int DEFAULT 200
)
RETURNS TABLE (
  goods_no text,
  title text,
  cate_cd text,
  cate_label text,
  price_krw int,
  is_imminent boolean,
  image_url text,
  detail_url text,
  source_currency text,
  current_rate numeric,
  avg_30d numeric,
  sigma_30d numeric,
  cv_pct numeric,
  worst_case_rate numeric,
  best_case_rate numeric,
  margin_under_worst numeric,
  margin_under_best numeric,
  margin_cliff_pct numeric,
  fx_favor_score real,
  fx_badge text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH snap AS (
    SELECT * FROM jimscanner_fx_margin_snapshot WHERE currency = source_currency
  )
  SELECT
    gp.goods_no,
    gp.title,
    gp.cate_cd,
    gp.cate_label,
    gp.price_krw,
    gp.is_imminent,
    gp.image_url,
    gp.detail_url,
    source_currency,
    snap.current_rate,
    snap.avg_30d,
    snap.sigma_30d,
    snap.cv_pct,
    (snap.current_rate + sigma_mult * snap.sigma_30d)::numeric(12, 4) AS worst_case_rate,
    GREATEST(snap.current_rate - sigma_mult * snap.sigma_30d, 0.0001)::numeric(12, 4) AS best_case_rate,
    (1.0 - (1.0 - margin_pct) * ((snap.current_rate + sigma_mult * snap.sigma_30d) / NULLIF(snap.current_rate, 0)))::numeric(8, 6) AS margin_under_worst,
    (1.0 - (1.0 - margin_pct) * (GREATEST(snap.current_rate - sigma_mult * snap.sigma_30d, 0.0001) / NULLIF(snap.current_rate, 0)))::numeric(8, 6) AS margin_under_best,
    (margin_pct - (1.0 - (1.0 - margin_pct) * ((snap.current_rate + sigma_mult * snap.sigma_30d) / NULLIF(snap.current_rate, 0))))::numeric(8, 6) AS margin_cliff_pct,
    snap.fx_favor_score,
    CASE
      WHEN snap.sigma_30d IS NULL OR snap.sigma_30d = 0 THEN 'gray'
      WHEN snap.fx_favor_score >= 0.5 THEN 'green'
      WHEN snap.fx_favor_score <= -0.5 THEN 'red'
      ELSE 'yellow'
    END AS fx_badge
  FROM jimscanner_ggsan_products gp
  CROSS JOIN snap
  WHERE gp.price_krw IS NOT NULL
    AND gp.status = 'active'
    AND (cate_filter IS NULL OR gp.cate_cd = cate_filter)
  ORDER BY
    -- 절벽이 큰 (마진이 가장 많이 깎이는) 핀이 위
    (margin_pct - (1.0 - (1.0 - margin_pct) * ((snap.current_rate + sigma_mult * snap.sigma_30d) / NULLIF(snap.current_rate, 0)))) DESC NULLS LAST
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_fx_margin_gate(numeric, numeric, text, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_fx_margin_gate(numeric, numeric, text, text, int) TO service_role;
