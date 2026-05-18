-- ─────────────────────────────────────────────────────────────
-- Source × Category Lead-Time Matrix — 선행 시그널 신뢰도
-- 2026-05-19 (improvement: Source × Category Lead-Time Matrix)
-- ─────────────────────────────────────────────────────────────
-- jimscanner_trends_keywords 시계열에서 각 (source, category_top) 격자가
-- 카테고리 전체 합산 정점("컨센서스 트렌드")을 며칠 선행하는지 학습.
-- 결과: 운영자가 source-별 카테고리 신뢰도를 한 눈에 보고 'act now' vs 'noise' 판단.
--
-- 사용처:
--   - /admin/trend-radar/leadtime (히트맵)
--   - "Today's Early Movers" 패널 (지난 24h, lead 점수 ≥ 임계치 소스 한정)
--   - scripts/learn-source-leadtime.mjs (일 1회 cron — 단순 로깅)
--
-- RLS: service_role 만 접근 (기존 jimscanner_trends_* 패턴).
-- ─────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────
-- RPC 1) jimscanner_source_leadtime(window_days)
-- 반환: (source, category_top, lead_days, predictive_strength, sample_n)
--
-- 알고리즘 (cross-correlation 의 가벼운 근사):
--   1) (source, category_top, day) 별 키워드 count 시계열 집계
--   2) (category_top, day) 별 전체 sum = 컨센서스 시계열
--   3) source-카테고리 시계열에서 spike 일자 (cnt ≥ mu + sigma) 추출
--   4) 컨센서스에서 peak 일자 (total ≥ mu + sigma) 추출
--   5) 각 source spike 가 이후 0~7일 안에 발생한 가장 가까운 컨센서스 peak
--      까지의 거리(lead_days)를 측정
--   6) predictive_strength = (peak 가 7일 안에 발생한 spike 비율)
--   7) sample_n < 2 인 셀은 제외 — 통계적으로 의미 없음
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_source_leadtime(window_days int DEFAULT 30)
RETURNS TABLE (
  source text,
  category_top text,
  lead_days numeric,
  predictive_strength numeric,
  sample_n int
)
LANGUAGE sql
STABLE
AS $$
  WITH daily AS (
    SELECT
      k.source,
      COALESCE(NULLIF(k.category_top, ''), k.classified_category) AS category_top,
      (k.collected_at AT TIME ZONE 'Asia/Seoul')::date AS d,
      COUNT(*)::numeric AS cnt
    FROM jimscanner_trends_keywords k
    WHERE k.collected_at >= now() - (window_days || ' days')::interval
      AND COALESCE(NULLIF(k.category_top, ''), k.classified_category) IS NOT NULL
      AND k.source IS NOT NULL
    GROUP BY 1, 2, 3
  ),
  consensus AS (
    SELECT category_top, d, SUM(cnt) AS total
    FROM daily
    GROUP BY 1, 2
  ),
  src_stats AS (
    SELECT source, category_top,
           AVG(cnt) AS mu,
           COALESCE(STDDEV_SAMP(cnt), 0) AS sigma
    FROM daily
    GROUP BY 1, 2
  ),
  src_spikes AS (
    SELECT d.source, d.category_top, d.d AS spike_day
    FROM daily d
    JOIN src_stats s USING (source, category_top)
    WHERE d.cnt > 0
      AND d.cnt >= s.mu + s.sigma
  ),
  con_stats AS (
    SELECT category_top,
           AVG(total) AS mu,
           COALESCE(STDDEV_SAMP(total), 0) AS sigma
    FROM consensus
    GROUP BY 1
  ),
  con_peaks AS (
    SELECT c.category_top, c.d AS peak_day, c.total
    FROM consensus c
    JOIN con_stats s USING (category_top)
    WHERE c.total >= s.mu + s.sigma
  ),
  matched AS (
    SELECT
      ss.source,
      ss.category_top,
      ss.spike_day,
      (
        SELECT MIN(cp.peak_day - ss.spike_day)
        FROM con_peaks cp
        WHERE cp.category_top = ss.category_top
          AND cp.peak_day BETWEEN ss.spike_day AND ss.spike_day + 7
      ) AS lead_to_peak,
      EXISTS (
        SELECT 1 FROM con_peaks cp
        WHERE cp.category_top = ss.category_top
          AND cp.peak_day BETWEEN ss.spike_day AND ss.spike_day + 7
      ) AS had_peak
    FROM src_spikes ss
  )
  SELECT
    m.source,
    m.category_top,
    ROUND(AVG(m.lead_to_peak) FILTER (WHERE m.lead_to_peak IS NOT NULL)::numeric, 2) AS lead_days,
    ROUND(
      (SUM(CASE WHEN m.had_peak THEN 1 ELSE 0 END)::numeric
        / GREATEST(COUNT(*), 1))::numeric,
      3
    ) AS predictive_strength,
    COUNT(*)::int AS sample_n
  FROM matched m
  GROUP BY 1, 2
  HAVING COUNT(*) >= 2
  ORDER BY predictive_strength DESC, sample_n DESC;
$$;

REVOKE ALL ON FUNCTION jimscanner_source_leadtime(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_source_leadtime(int) TO service_role;

-- ─────────────────────────────────────────
-- RPC 2) jimscanner_early_movers(hours_window, min_strength, min_sample_n)
-- 지난 N시간 동안 lead-time 신뢰도가 높은 source 에서 '새로 등장한' 키워드만 반환.
-- '새로 등장' = 키워드의 가장 빠른 collected_at 이 hours_window 안에 있음.
--
-- 반환: (keyword, source, category_top, predictive_strength, lead_days, first_seen)
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_early_movers(
  hours_window int DEFAULT 24,
  min_strength numeric DEFAULT 0.4,
  min_sample_n int DEFAULT 3,
  window_days int DEFAULT 30
)
RETURNS TABLE (
  keyword text,
  source text,
  category_top text,
  predictive_strength numeric,
  lead_days numeric,
  first_seen timestamptz
)
LANGUAGE sql
STABLE
AS $$
  WITH lt AS (
    SELECT * FROM jimscanner_source_leadtime(window_days)
    WHERE predictive_strength >= min_strength
      AND sample_n >= min_sample_n
  ),
  kw_first AS (
    SELECT
      k.keyword,
      k.source,
      COALESCE(NULLIF(k.category_top, ''), k.classified_category) AS category_top,
      MIN(k.collected_at) AS first_seen
    FROM jimscanner_trends_keywords k
    WHERE k.source IS NOT NULL
      AND k.keyword IS NOT NULL
      AND COALESCE(NULLIF(k.category_top, ''), k.classified_category) IS NOT NULL
    GROUP BY 1, 2, 3
  )
  SELECT
    f.keyword,
    f.source,
    f.category_top,
    lt.predictive_strength,
    lt.lead_days,
    f.first_seen
  FROM kw_first f
  JOIN lt ON lt.source = f.source AND lt.category_top = f.category_top
  WHERE f.first_seen >= now() - (hours_window || ' hours')::interval
  ORDER BY lt.predictive_strength DESC, f.first_seen DESC
  LIMIT 200;
$$;

REVOKE ALL ON FUNCTION jimscanner_early_movers(int, numeric, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_early_movers(int, numeric, int, int) TO service_role;
