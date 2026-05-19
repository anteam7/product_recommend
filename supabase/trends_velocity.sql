-- ────────────────────────────────────────────────────────────
-- 수요 가속도(2차 미분) 위상 사분면 — 2026-05-19
-- ────────────────────────────────────────────────────────────
-- 키워드별로 volume_relative 시계열에 대해
--   - velocity   = 현재 window 평균 − 직전 window 평균   (1차 미분, dv/dt)
--   - acceleration = (current − prev) − (prev − prev-prev) (2차 미분, d²v/dt²)
-- 을 계산해 (velocity, acceleration) 4사분면으로 분류한다.
--
-- 사분면 의미:
--   ① v≥0, a≥0  '초기등판'  (즉시 진입)
--   ② v≥0, a<0  '정점임박'  (진입 보류, 기존 핀 회수 타이밍)
--   ③ v<0, a<0  '퇴조'      (손절)
--   ④ v<0, a≥0  '반등'      (관찰)
--
-- 사용처: /admin/trend-radar/velocity
-- ────────────────────────────────────────────────────────────

-- 1) 일별 volume_relative 평균 view (재사용)
CREATE OR REPLACE VIEW jimscanner_trends_velocity_v AS
SELECT
  keyword,
  source,
  category_top,
  date_trunc('day', collected_at)::date AS day,
  AVG(volume_relative)::numeric AS volume
FROM jimscanner_trends_keywords
WHERE volume_relative IS NOT NULL
GROUP BY keyword, source, category_top, date_trunc('day', collected_at)::date;

-- 2) 위상 사분면 RPC
CREATE OR REPLACE FUNCTION jimscanner_trends_velocity_quadrant(
  window_days int DEFAULT 7,
  min_days int DEFAULT 3,
  source_filter text DEFAULT NULL,
  result_limit int DEFAULT 500
)
RETURNS TABLE (
  keyword text,
  source text,
  category_top text,
  volume numeric,
  velocity numeric,
  acceleration numeric,
  quadrant smallint,
  quadrant_label text,
  day_count int,
  spark numeric[]
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  WITH daily AS (
    SELECT keyword, source, category_top, day, volume
    FROM jimscanner_trends_velocity_v
    WHERE day > (now()::date - (window_days * 4))
      AND (source_filter IS NULL OR source = source_filter)
  ),
  windowed AS (
    SELECT
      keyword, source, category_top,
      AVG(CASE
        WHEN day > (now()::date - window_days) THEN volume
      END) AS v_cur,
      AVG(CASE
        WHEN day > (now()::date - (window_days * 2))
         AND day <= (now()::date - window_days) THEN volume
      END) AS v_prev,
      AVG(CASE
        WHEN day > (now()::date - (window_days * 3))
         AND day <= (now()::date - (window_days * 2)) THEN volume
      END) AS v_pp,
      COUNT(DISTINCT day)::int AS day_count,
      ARRAY_AGG(volume ORDER BY day) AS spark
    FROM daily
    GROUP BY keyword, source, category_top
  ),
  computed AS (
    SELECT
      keyword, source, category_top,
      COALESCE(v_cur, 0)::numeric AS volume,
      (COALESCE(v_cur, 0) - COALESCE(v_prev, 0))::numeric AS velocity,
      ((COALESCE(v_cur, 0) - COALESCE(v_prev, 0))
        - (COALESCE(v_prev, 0) - COALESCE(v_pp, 0)))::numeric AS acceleration,
      day_count,
      spark
    FROM windowed
    WHERE day_count >= min_days
  )
  SELECT
    keyword, source, category_top, volume, velocity, acceleration,
    (CASE
      WHEN velocity >= 0 AND acceleration >= 0 THEN 1
      WHEN velocity >= 0 AND acceleration <  0 THEN 2
      WHEN velocity <  0 AND acceleration <  0 THEN 3
      ELSE 4
    END)::smallint AS quadrant,
    (CASE
      WHEN velocity >= 0 AND acceleration >= 0 THEN '초기등판'
      WHEN velocity >= 0 AND acceleration <  0 THEN '정점임박'
      WHEN velocity <  0 AND acceleration <  0 THEN '퇴조'
      ELSE '반등'
    END) AS quadrant_label,
    day_count,
    spark
  FROM computed
  ORDER BY volume DESC NULLS LAST
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_trends_velocity_quadrant(int, int, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_trends_velocity_quadrant(int, int, text, int) TO service_role;
