-- ────────────────────────────────────────────────────────────
-- STL 시즌성·트렌드 분해 RPC + 캐시 (2026-05-26)
-- ────────────────────────────────────────────────────────────
-- jimscanner_trends_keywords 의 키워드별 시계열을
-- trend / weekly-seasonal(period=7) / residual 3개 성분으로 분해.
--
-- 출력 산물:
--   1) jimscanner_keyword_stl_decompose(keyword, window_days) RPC
--      → 일별 (observed, trend, seasonal, residual, z_residual) 시계열
--   2) jimscanner_keyword_stl_summary(window_days, min_points) RPC
--      → 키워드별 (seasonal_strength, trend_strength, trend_slope,
--                  last_residual_z, residual_spike) 요약
--   3) jimscanner_trends_stl_cache 테이블
--      → 일별 캐시 (어드민 보드 재방문 시 빠른 로드)
-- ────────────────────────────────────────────────────────────

-- 1) 캐시 테이블
CREATE TABLE IF NOT EXISTS jimscanner_trends_stl_cache (
  keyword text NOT NULL,
  computed_for date NOT NULL DEFAULT current_date,
  window_days int NOT NULL DEFAULT 90,
  n_points int NOT NULL DEFAULT 0,
  seasonal_strength numeric,    -- 0~1, var(seasonal)/var(seasonal+residual)
  trend_strength numeric,       -- 0~1, var(trend)/var(trend+residual) 근사
  trend_slope numeric,          -- 마지막 14일 trend 기울기 (per day)
  last_observed numeric,
  last_trend numeric,
  last_seasonal numeric,
  last_residual numeric,
  residual_std numeric,
  last_residual_z numeric,      -- 마지막 잔차의 z-score
  residual_spike boolean NOT NULL DEFAULT false,
  series jsonb,                 -- 시계열 전체 [{d, obs, trend, seasonal, residual}]
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (keyword, computed_for)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_stl_cache_residual_spike
  ON jimscanner_trends_stl_cache(computed_for DESC, last_residual_z DESC)
  WHERE residual_spike;

CREATE INDEX IF NOT EXISTS jimscanner_trends_stl_cache_seasonal
  ON jimscanner_trends_stl_cache(computed_for DESC, seasonal_strength DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_stl_cache_trend
  ON jimscanner_trends_stl_cache(computed_for DESC, trend_slope DESC);

ALTER TABLE jimscanner_trends_stl_cache ENABLE ROW LEVEL SECURITY;

-- 2) 단일 키워드 STL 분해 RPC (window_days 일간)
-- 수식:
--   trend_t   = centered moving average (window=7)
--   detrended = observed - trend
--   seasonal  = 요일별 평균 detrended (mean-centered)
--   residual  = observed - trend - seasonal
CREATE OR REPLACE FUNCTION jimscanner_keyword_stl_decompose(
  p_keyword text,
  window_days int DEFAULT 90
)
RETURNS TABLE (
  d date,
  observed numeric,
  trend numeric,
  seasonal numeric,
  residual numeric,
  z_residual numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH daily AS (
    SELECT
      (collected_at AT TIME ZONE 'Asia/Seoul')::date AS d,
      AVG(COALESCE(volume_relative, 0))::numeric AS observed
    FROM jimscanner_trends_keywords
    WHERE keyword = p_keyword
      AND collected_at >= now() - make_interval(days => window_days)
    GROUP BY 1
  ),
  trended AS (
    SELECT
      d,
      observed,
      AVG(observed) OVER (
        ORDER BY d
        ROWS BETWEEN 3 PRECEDING AND 3 FOLLOWING
      )::numeric AS trend
    FROM daily
  ),
  detrended AS (
    SELECT
      d,
      observed,
      trend,
      (observed - trend)::numeric AS detrended,
      EXTRACT(DOW FROM d)::int AS dow
    FROM trended
  ),
  seasonal_raw AS (
    SELECT dow, AVG(detrended) AS s_raw
    FROM detrended
    WHERE detrended IS NOT NULL
    GROUP BY dow
  ),
  seasonal_centered AS (
    -- 시즌 성분은 평균 0 으로 중심화
    SELECT
      dow,
      (s_raw - (SELECT AVG(s_raw) FROM seasonal_raw))::numeric AS seasonal
    FROM seasonal_raw
  ),
  full AS (
    SELECT
      d.d,
      d.observed,
      d.trend,
      COALESCE(s.seasonal, 0)::numeric AS seasonal,
      (d.observed - d.trend - COALESCE(s.seasonal, 0))::numeric AS residual
    FROM detrended d
    LEFT JOIN seasonal_centered s ON s.dow = d.dow
  ),
  rstats AS (
    SELECT STDDEV_POP(residual) AS rstd FROM full WHERE residual IS NOT NULL
  )
  SELECT
    f.d,
    f.observed,
    f.trend,
    f.seasonal,
    f.residual,
    CASE
      WHEN (SELECT rstd FROM rstats) IS NULL OR (SELECT rstd FROM rstats) = 0 THEN 0
      ELSE (f.residual / NULLIF((SELECT rstd FROM rstats), 0))::numeric
    END AS z_residual
  FROM full f
  ORDER BY f.d;
$$;

-- 3) 키워드별 요약 RPC — 모든 키워드 일괄 처리
-- 보드에서 한 번 호출로 핀 큐 / 알림 / 모멘텀 3 탭을 모두 채울 수 있도록.
CREATE OR REPLACE FUNCTION jimscanner_keyword_stl_summary(
  window_days int DEFAULT 90,
  min_points int DEFAULT 14,
  result_limit int DEFAULT 500
)
RETURNS TABLE (
  keyword text,
  source text,
  category_top text,
  n_points int,
  seasonal_strength numeric,
  trend_strength numeric,
  trend_slope numeric,
  last_observed numeric,
  last_trend numeric,
  last_seasonal numeric,
  last_residual numeric,
  residual_std numeric,
  last_residual_z numeric,
  residual_spike boolean
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN QUERY
  WITH daily AS (
    SELECT
      k.keyword,
      (k.collected_at AT TIME ZONE 'Asia/Seoul')::date AS d,
      AVG(COALESCE(k.volume_relative, 0))::numeric AS observed
    FROM jimscanner_trends_keywords k
    WHERE k.collected_at >= now() - make_interval(days => window_days)
    GROUP BY 1, 2
  ),
  meta AS (
    SELECT DISTINCT ON (k.keyword)
      k.keyword,
      k.source,
      k.category_top
    FROM jimscanner_trends_keywords k
    WHERE k.collected_at >= now() - make_interval(days => window_days)
    ORDER BY k.keyword, k.collected_at DESC
  ),
  trended AS (
    SELECT
      d.keyword,
      d.d,
      d.observed,
      AVG(d.observed) OVER (
        PARTITION BY d.keyword
        ORDER BY d.d
        ROWS BETWEEN 3 PRECEDING AND 3 FOLLOWING
      )::numeric AS trend
    FROM daily d
  ),
  detrended AS (
    SELECT
      t.keyword,
      t.d,
      t.observed,
      t.trend,
      (t.observed - t.trend)::numeric AS detrended,
      EXTRACT(DOW FROM t.d)::int AS dow
    FROM trended t
  ),
  seasonal_raw AS (
    SELECT keyword, dow, AVG(detrended) AS s_raw
    FROM detrended
    WHERE detrended IS NOT NULL
    GROUP BY keyword, dow
  ),
  seasonal_means AS (
    SELECT keyword, AVG(s_raw) AS s_mean
    FROM seasonal_raw
    GROUP BY keyword
  ),
  seasonal_centered AS (
    SELECT
      sr.keyword,
      sr.dow,
      (sr.s_raw - sm.s_mean)::numeric AS seasonal
    FROM seasonal_raw sr
    JOIN seasonal_means sm ON sm.keyword = sr.keyword
  ),
  decomposed AS (
    SELECT
      d.keyword,
      d.d,
      d.observed,
      d.trend,
      COALESCE(sc.seasonal, 0)::numeric AS seasonal,
      (d.observed - d.trend - COALESCE(sc.seasonal, 0))::numeric AS residual
    FROM detrended d
    LEFT JOIN seasonal_centered sc
      ON sc.keyword = d.keyword AND sc.dow = d.dow
  ),
  agg AS (
    SELECT
      x.keyword,
      COUNT(*)::int AS n_points,
      VAR_POP(x.seasonal) AS var_seasonal,
      VAR_POP(x.residual) AS var_residual,
      VAR_POP(x.trend)    AS var_trend,
      STDDEV_POP(x.residual) AS std_residual
    FROM decomposed x
    WHERE x.observed IS NOT NULL
    GROUP BY x.keyword
  ),
  tail AS (
    -- 마지막 시점값
    SELECT DISTINCT ON (x.keyword)
      x.keyword,
      x.observed AS last_observed,
      x.trend AS last_trend,
      x.seasonal AS last_seasonal,
      x.residual AS last_residual
    FROM decomposed x
    ORDER BY x.keyword, x.d DESC
  ),
  slope AS (
    -- 최근 14일 trend 기울기 (REGR_SLOPE)
    SELECT
      x.keyword,
      REGR_SLOPE(x.trend, EXTRACT(EPOCH FROM x.d) / 86400.0)::numeric AS trend_slope
    FROM decomposed x
    WHERE x.d >= current_date - 14
      AND x.trend IS NOT NULL
    GROUP BY x.keyword
  )
  SELECT
    a.keyword,
    m.source,
    m.category_top,
    a.n_points,
    CASE
      WHEN COALESCE(a.var_seasonal, 0) + COALESCE(a.var_residual, 0) = 0 THEN 0
      ELSE GREATEST(0, LEAST(1,
        COALESCE(a.var_seasonal, 0) /
        NULLIF(COALESCE(a.var_seasonal, 0) + COALESCE(a.var_residual, 0), 0)
      ))::numeric
    END AS seasonal_strength,
    CASE
      WHEN COALESCE(a.var_trend, 0) + COALESCE(a.var_residual, 0) = 0 THEN 0
      ELSE GREATEST(0, LEAST(1,
        COALESCE(a.var_trend, 0) /
        NULLIF(COALESCE(a.var_trend, 0) + COALESCE(a.var_residual, 0), 0)
      ))::numeric
    END AS trend_strength,
    COALESCE(s.trend_slope, 0)::numeric AS trend_slope,
    t.last_observed,
    t.last_trend,
    t.last_seasonal,
    t.last_residual,
    a.std_residual::numeric AS residual_std,
    CASE
      WHEN a.std_residual IS NULL OR a.std_residual = 0 THEN 0
      ELSE (t.last_residual / NULLIF(a.std_residual, 0))::numeric
    END AS last_residual_z,
    CASE
      WHEN a.std_residual IS NULL OR a.std_residual = 0 THEN false
      ELSE ABS(t.last_residual / NULLIF(a.std_residual, 0)) >= 2.0
    END AS residual_spike
  FROM agg a
  JOIN tail t ON t.keyword = a.keyword
  JOIN meta m ON m.keyword = a.keyword
  LEFT JOIN slope s ON s.keyword = a.keyword
  WHERE a.n_points >= min_points
  ORDER BY ABS(
    CASE
      WHEN a.std_residual IS NULL OR a.std_residual = 0 THEN 0
      ELSE t.last_residual / NULLIF(a.std_residual, 0)
    END
  ) DESC
  LIMIT result_limit;
END;
$$;

-- 4) 캐시 리프레시 헬퍼 — cron 에서 KST 07:00 호출 권장
-- 단순히 summary 결과를 upsert 한다.
CREATE OR REPLACE FUNCTION jimscanner_refresh_stl_cache(
  window_days int DEFAULT 90,
  min_points int DEFAULT 14
)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  v_count int;
BEGIN
  WITH s AS (
    SELECT * FROM jimscanner_keyword_stl_summary(window_days, min_points, 2000)
  ),
  upserted AS (
    INSERT INTO jimscanner_trends_stl_cache (
      keyword, computed_for, window_days, n_points,
      seasonal_strength, trend_strength, trend_slope,
      last_observed, last_trend, last_seasonal, last_residual,
      residual_std, last_residual_z, residual_spike, computed_at
    )
    SELECT
      s.keyword, current_date, window_days, s.n_points,
      s.seasonal_strength, s.trend_strength, s.trend_slope,
      s.last_observed, s.last_trend, s.last_seasonal, s.last_residual,
      s.residual_std, s.last_residual_z, s.residual_spike, now()
    FROM s
    ON CONFLICT (keyword, computed_for) DO UPDATE SET
      window_days = EXCLUDED.window_days,
      n_points = EXCLUDED.n_points,
      seasonal_strength = EXCLUDED.seasonal_strength,
      trend_strength = EXCLUDED.trend_strength,
      trend_slope = EXCLUDED.trend_slope,
      last_observed = EXCLUDED.last_observed,
      last_trend = EXCLUDED.last_trend,
      last_seasonal = EXCLUDED.last_seasonal,
      last_residual = EXCLUDED.last_residual,
      residual_std = EXCLUDED.residual_std,
      last_residual_z = EXCLUDED.last_residual_z,
      residual_spike = EXCLUDED.residual_spike,
      computed_at = now()
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM upserted;
  RETURN v_count;
END;
$$;
