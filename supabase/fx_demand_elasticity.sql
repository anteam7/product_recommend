-- ────────────────────────────────────────────────────────────
-- FX 충격 → 카테고리 수요 Elasticity 보드 (2026-05-27)
-- ────────────────────────────────────────────────────────────
-- 목적: 환율 변동률(USD/JPY/CNY) ↔ 카테고리 수요(volume_relative) ↔
--       자사 GSC 클릭 시계열을 lag 0~14d 로 결합해
--       (1) 통화별 elasticity 계수 β_USD/β_JPY/β_CNY
--       (2) FX shock → 다음 14d 카테고리 수요 예측
--       (3) 환율 ↑ · 직구 둔화 → 국내 위탁 대체수요 ↑ 카테고리 탐지
--       에 활용.
-- 사용처: /admin/trend-radar/fx-elasticity
-- 의존: jimscanner_exchange_rate_logs, jimscanner_trends_keywords, jimscanner_gsc_queries
-- ────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────
-- 1) 일별 환율 (통화 × date) — exchange_rate_logs 의 최종값
-- ─────────────────────────────────────────
CREATE OR REPLACE VIEW jimscanner_fx_daily AS
WITH last_per_day AS (
  SELECT
    currency,
    (created_at AT TIME ZONE 'Asia/Seoul')::date AS d,
    rate_krw,
    ROW_NUMBER() OVER (
      PARTITION BY currency, (created_at AT TIME ZONE 'Asia/Seoul')::date
      ORDER BY created_at DESC
    ) AS rn
  FROM jimscanner_exchange_rate_logs
  WHERE status = 'success'
)
SELECT currency, d AS date, rate_krw
FROM last_per_day
WHERE rn = 1;

-- ─────────────────────────────────────────
-- 2) 일별 환율 변동률 (전일 대비 %) — lag 결합용
-- ─────────────────────────────────────────
CREATE OR REPLACE VIEW jimscanner_fx_daily_pct AS
SELECT
  currency,
  date,
  rate_krw,
  rate_krw - LAG(rate_krw) OVER (PARTITION BY currency ORDER BY date)
    AS rate_diff,
  CASE
    WHEN LAG(rate_krw) OVER (PARTITION BY currency ORDER BY date) IS NULL
      OR LAG(rate_krw) OVER (PARTITION BY currency ORDER BY date) = 0 THEN NULL
    ELSE
      (rate_krw - LAG(rate_krw) OVER (PARTITION BY currency ORDER BY date))
      / LAG(rate_krw) OVER (PARTITION BY currency ORDER BY date)
  END AS pct_change
FROM jimscanner_fx_daily;

-- ─────────────────────────────────────────
-- 3) 카테고리 × 일별 수요 지수 (trends_keywords 평균 volume_relative)
-- ─────────────────────────────────────────
CREATE OR REPLACE VIEW jimscanner_category_demand_daily AS
SELECT
  COALESCE(category_top, '미분류') AS category_top,
  (collected_at AT TIME ZONE 'Asia/Seoul')::date AS date,
  AVG(volume_relative)::numeric AS demand_index,
  COUNT(*)::int AS sample_count
FROM jimscanner_trends_keywords
WHERE volume_relative IS NOT NULL
  AND category_top IS NOT NULL
GROUP BY category_top, (collected_at AT TIME ZONE 'Asia/Seoul')::date;

-- ─────────────────────────────────────────
-- 4) 자사 GSC 일별 전체 클릭 (직구 수요 프록시)
-- ─────────────────────────────────────────
CREATE OR REPLACE VIEW jimscanner_gsc_daily_total AS
SELECT
  date,
  SUM(clicks)::int AS total_clicks,
  SUM(impressions)::int AS total_impressions
FROM jimscanner_gsc_queries
GROUP BY date;

-- ─────────────────────────────────────────
-- 5) Materialized View — 통합 패널 (date × category × currency)
--    환율 변동률 + lag 카테고리 수요 + GSC 클릭
-- ─────────────────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS jimscanner_fx_demand_panel;
CREATE MATERIALIZED VIEW jimscanner_fx_demand_panel AS
WITH dates AS (
  SELECT DISTINCT date FROM jimscanner_fx_daily_pct WHERE pct_change IS NOT NULL
),
fx AS (
  SELECT date, currency, rate_krw, pct_change
  FROM jimscanner_fx_daily_pct
  WHERE pct_change IS NOT NULL
),
cd AS (
  SELECT date, category_top, demand_index
  FROM jimscanner_category_demand_daily
),
gsc AS (
  SELECT date, total_clicks FROM jimscanner_gsc_daily_total
)
SELECT
  fx.date AS fx_date,
  fx.currency,
  fx.rate_krw,
  fx.pct_change AS fx_pct_change,
  cd.category_top,
  cd.date AS demand_date,
  (cd.date - fx.date) AS lag_days,
  cd.demand_index,
  gsc.total_clicks AS gsc_clicks_on_fx_date
FROM fx
LEFT JOIN cd ON cd.date BETWEEN fx.date AND fx.date + INTERVAL '14 days'
LEFT JOIN gsc ON gsc.date = fx.date
WHERE cd.category_top IS NOT NULL;

CREATE INDEX IF NOT EXISTS jimscanner_fx_demand_panel_cur_cat
  ON jimscanner_fx_demand_panel (currency, category_top, lag_days);
CREATE INDEX IF NOT EXISTS jimscanner_fx_demand_panel_date
  ON jimscanner_fx_demand_panel (fx_date);

-- ─────────────────────────────────────────
-- 6) RPC — 통화 × 카테고리 elasticity 계수
--    단순 회귀 β = cov(fx_pct, demand) / var(fx_pct)  (lag 별)
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_fx_elasticity(
  days_window int DEFAULT 90,
  min_samples int DEFAULT 8
)
RETURNS TABLE (
  currency text,
  category_top text,
  lag_days int,
  beta numeric,       -- elasticity 계수
  correlation numeric,-- pearson r
  sample_count int,
  avg_demand numeric,
  avg_fx_pct numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH panel AS (
    SELECT *
    FROM jimscanner_fx_demand_panel
    WHERE fx_date >= (CURRENT_DATE - (days_window || ' days')::interval)::date
      AND lag_days BETWEEN 0 AND 14
      AND demand_index IS NOT NULL
  ),
  agg AS (
    SELECT
      currency,
      category_top,
      lag_days,
      COUNT(*)::int AS n,
      AVG(fx_pct_change)::numeric AS avg_fx,
      AVG(demand_index)::numeric AS avg_dem,
      CASE
        WHEN VAR_POP(fx_pct_change) IS NULL OR VAR_POP(fx_pct_change) = 0 THEN NULL
        ELSE COVAR_POP(demand_index, fx_pct_change) / VAR_POP(fx_pct_change)
      END AS beta,
      CORR(demand_index, fx_pct_change) AS corr
    FROM panel
    GROUP BY currency, category_top, lag_days
  )
  SELECT
    currency,
    category_top,
    lag_days,
    beta::numeric AS beta,
    corr::numeric AS correlation,
    n AS sample_count,
    avg_dem AS avg_demand,
    avg_fx AS avg_fx_pct
  FROM agg
  WHERE n >= min_samples;
$$;

REVOKE ALL ON FUNCTION jimscanner_fx_elasticity(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_fx_elasticity(int, int) TO service_role;

-- ─────────────────────────────────────────
-- 7) RPC — 최근 N일 환율 충격 요약 (통화별)
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_fx_recent_shock(days_back int DEFAULT 7)
RETURNS TABLE (
  currency text,
  start_rate numeric,
  end_rate numeric,
  pct_change numeric,
  trend text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH bounds AS (
    SELECT
      currency,
      (ARRAY_AGG(rate_krw ORDER BY date ASC))[1] AS start_rate,
      (ARRAY_AGG(rate_krw ORDER BY date DESC))[1] AS end_rate
    FROM jimscanner_fx_daily
    WHERE date >= (CURRENT_DATE - (days_back || ' days')::interval)::date
    GROUP BY currency
  )
  SELECT
    currency,
    start_rate::numeric,
    end_rate::numeric,
    CASE WHEN start_rate IS NULL OR start_rate = 0 THEN NULL
         ELSE ((end_rate - start_rate) / start_rate)::numeric
    END AS pct_change,
    CASE
      WHEN end_rate > start_rate * 1.005 THEN 'up'
      WHEN end_rate < start_rate * 0.995 THEN 'down'
      ELSE 'flat'
    END AS trend
  FROM bounds;
$$;

REVOKE ALL ON FUNCTION jimscanner_fx_recent_shock(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_fx_recent_shock(int) TO service_role;

-- ─────────────────────────────────────────
-- 8) RPC — 환율 ↑ + 직구(GSC) 둔화 시 국내 위탁 대체수요로 의심되는 카테고리
--    조건: USD 충격 시 lag>=3 elasticity 가 양수 + 동기간 GSC 클릭은 음의 상관
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_fx_substitution_candidates(
  days_window int DEFAULT 90,
  target_currency text DEFAULT 'USD',
  min_samples int DEFAULT 8
)
RETURNS TABLE (
  category_top text,
  best_lag int,
  beta_demand numeric,         -- FX→카테고리 수요 elasticity
  beta_gsc numeric,            -- FX→GSC 자사 클릭 elasticity (음수면 직구 둔화)
  substitution_score numeric   -- beta_demand × (-beta_gsc) — 클수록 위탁 대체 후보
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH cat_beta AS (
    SELECT category_top, lag_days, beta, sample_count
    FROM jimscanner_fx_elasticity(days_window, min_samples)
    WHERE currency = target_currency
      AND lag_days BETWEEN 3 AND 14
      AND beta IS NOT NULL
  ),
  best AS (
    SELECT DISTINCT ON (category_top)
      category_top,
      lag_days AS best_lag,
      beta AS beta_demand
    FROM cat_beta
    ORDER BY category_top, beta DESC NULLS LAST
  ),
  gsc_panel AS (
    SELECT
      fx.date AS fx_date,
      fx.pct_change AS fx_pct,
      gsc.total_clicks
    FROM jimscanner_fx_daily_pct fx
    LEFT JOIN jimscanner_gsc_daily_total gsc ON gsc.date = fx.date + INTERVAL '3 days'
    WHERE fx.currency = target_currency
      AND fx.pct_change IS NOT NULL
      AND fx.date >= (CURRENT_DATE - (days_window || ' days')::interval)::date
  ),
  gsc_beta_calc AS (
    SELECT
      CASE
        WHEN VAR_POP(fx_pct) IS NULL OR VAR_POP(fx_pct) = 0 THEN NULL
        ELSE COVAR_POP(total_clicks::numeric, fx_pct) / VAR_POP(fx_pct)
      END AS beta_gsc
    FROM gsc_panel
    WHERE total_clicks IS NOT NULL
  )
  SELECT
    b.category_top,
    b.best_lag,
    b.beta_demand,
    (SELECT beta_gsc FROM gsc_beta_calc) AS beta_gsc,
    (b.beta_demand * COALESCE(-1 * (SELECT beta_gsc FROM gsc_beta_calc), 0))::numeric
      AS substitution_score
  FROM best b
  WHERE b.beta_demand > 0
  ORDER BY substitution_score DESC NULLS LAST;
$$;

REVOKE ALL ON FUNCTION jimscanner_fx_substitution_candidates(int, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_fx_substitution_candidates(int, text, int) TO service_role;
