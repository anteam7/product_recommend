-- FX 익스포저 보드용 RPC
-- 수입소싱(CNY/USD 등) SKU 의 환율 민감도·마진 스트레스 산출.
-- 실행: Supabase Dashboard > SQL Editor > New Query > 붙여넣고 Run
--
-- 설계 메모
--  - supplier.price_original(도매가 원본) × 현재 jimscanner_exchange_rates 환율 = 현재 landed cost.
--    (수집 시점 price_krw 는 고정 환율이라 stale → 현재 환율로 재계산)
--  - 실현 변동성 σ: jimscanner_exchange_rate_logs 의 일별 로그수익률 ln(rate/previous_rate) 표준편차.
--  - 리드타임 동안의 현실적 FX 스윙 = max(최소버퍼, z·σ·sqrt(leadtime_days)).
--    수입은 발주~도착(MOQ·리드타임)까지 환노출이 유지되므로 horizon 을 리드타임으로 잡음.
--  - 마진 스트레스: 도매원가 기준 목표마진(p_target_margin)으로 산정한 판매가를 고정한 채
--    landed cost 가 스트레스 비율만큼 오를 때 마진이 얼마나 잠식되는지.
--    (판매가 magnitude 와 무관하게 닫힌형으로 계산됨)
--  - KRW(ggsan) 소싱은 환노출 면역 → is_fx_exposed = false, 회색 처리.

DROP FUNCTION IF EXISTS jimscanner_fx_margin_exposure(int, numeric, numeric, numeric, numeric, numeric);

CREATE OR REPLACE FUNCTION jimscanner_fx_margin_exposure(
  p_days int DEFAULT 30,            -- 변동성 산출 윈도우(일)
  p_z numeric DEFAULT 1.65,         -- 스트레스 z (편측 ~95%)
  p_min_stress numeric DEFAULT 0.03,-- 최소 현실 스윙(예: CNY +3%)
  p_target_margin numeric DEFAULT 0.25, -- 기준 판매가 산정용 목표마진
  p_fee numeric DEFAULT 0.106,      -- 쿠팡 수수료(부가세 포함, 기타영양제 기준)
  p_margin_floor numeric DEFAULT 0.10   -- 적색 플래그 임계 마진
)
RETURNS TABLE (
  product_id uuid,
  product_name text,
  supplier_id uuid,
  supplier_source text,
  currency text,
  price_original numeric,
  base_rate_krw numeric,
  base_landed_krw numeric,
  daily_vol_pct numeric,
  stress_pct numeric,
  stressed_landed_krw numeric,
  fx_sensitivity_krw_per_pct numeric,
  moq int,
  lead_time_days int,
  base_margin_pct numeric,
  stressed_margin_pct numeric,
  recommended_buffer_pct numeric,
  is_fx_exposed boolean,
  is_red_flag boolean
)
LANGUAGE sql
STABLE
AS $$
WITH vol AS (
  SELECT
    currency,
    stddev_samp(ln(rate_krw / previous_rate_krw)) AS sigma
  FROM jimscanner_exchange_rate_logs
  WHERE status = 'success'
    AND previous_rate_krw IS NOT NULL AND previous_rate_krw > 0
    AND rate_krw > 0
    AND created_at >= now() - make_interval(days => p_days)
  GROUP BY currency
),
latest_supplier AS (
  SELECT DISTINCT ON (s.product_id, s.supplier_source)
    s.id,
    s.product_id,
    s.supplier_source,
    upper(coalesce(s.price_currency, 'KRW')) AS currency,
    s.price_original,
    s.price_krw,
    s.moq,
    s.lead_time_days
  FROM jimscanner_trends_supplier s
  ORDER BY s.product_id, s.supplier_source, s.collected_at DESC
),
base AS (
  SELECT
    ls.product_id,
    p.canonical_name AS product_name,
    ls.id AS supplier_id,
    ls.supplier_source,
    ls.currency,
    ls.price_original,
    r.rate_krw AS base_rate_krw,
    (ls.currency = 'KRW') AS is_krw,
    CASE
      WHEN ls.currency = 'KRW' THEN coalesce(ls.price_krw, ls.price_original)
      ELSE ls.price_original * r.rate_krw
    END AS base_landed_krw,
    coalesce(v.sigma, 0) AS sigma,
    ls.moq,
    coalesce(ls.lead_time_days, 7) AS lead_time_days
  FROM latest_supplier ls
  JOIN jimscanner_trends_products p ON p.id = ls.product_id
  LEFT JOIN jimscanner_exchange_rates r ON r.currency = ls.currency
  LEFT JOIN vol v ON v.currency = ls.currency
),
stressed AS (
  SELECT
    b.*,
    CASE
      WHEN b.is_krw THEN 0
      ELSE GREATEST(p_min_stress, p_z * b.sigma * sqrt(GREATEST(b.lead_time_days, 1)))
    END AS stress
  FROM base b
)
SELECT
  s.product_id,
  s.product_name,
  s.supplier_id,
  s.supplier_source,
  s.currency,
  s.price_original,
  s.base_rate_krw,
  round(s.base_landed_krw, 2) AS base_landed_krw,
  round(s.sigma * 100, 4) AS daily_vol_pct,
  round(s.stress * 100, 4) AS stress_pct,
  round(s.base_landed_krw * (1 + s.stress), 2) AS stressed_landed_krw,
  -- +1% FX 당 landed cost 변화(원) — KRW 소싱은 0
  round(CASE WHEN s.is_krw THEN 0 ELSE s.base_landed_krw / 100 END, 2) AS fx_sensitivity_krw_per_pct,
  s.moq,
  s.lead_time_days,
  round(p_target_margin * 100, 2) AS base_margin_pct,
  -- 판매가 고정·landed 스트레스 시 마진(닫힌형)
  round(((1 - p_fee) - (1 + s.stress) * (1 - p_target_margin - p_fee)) * 100, 2) AS stressed_margin_pct,
  -- 기준마진 유지를 위해 도매원가에 얹어야 할 권장 FX 버퍼(%)
  round(s.stress * 100, 2) AS recommended_buffer_pct,
  (NOT s.is_krw) AS is_fx_exposed,
  (
    NOT s.is_krw
    AND ((1 - p_fee) - (1 + s.stress) * (1 - p_target_margin - p_fee)) < p_margin_floor
  ) AS is_red_flag
FROM stressed s
ORDER BY is_red_flag DESC, stress_pct DESC, base_landed_krw DESC;
$$;

GRANT EXECUTE ON FUNCTION jimscanner_fx_margin_exposure(int, numeric, numeric, numeric, numeric, numeric)
  TO anon, authenticated, service_role;
