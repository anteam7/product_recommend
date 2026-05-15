-- 시간축 Reproducibility Index — 2026-05-16
-- 일회성 스파이크 vs 진성 트렌드 분리.
-- jimscanner_trends_scores 시계열(이미 computed_at 별 누적)로부터 product 별 4개 지표 derive:
--   (a) persistence_days       = 최근 30일간 Top-K 진입(final_score >= 50) 일수
--   (b) streak_days            = 가장 최근(어제/오늘) 부터 역방향 연속 등장 일수
--   (c) cv                     = stddev / mean (Coefficient of Variation) — 변동성
--   (d) direction_net          = 연속 day-over-day Δ 부호 합 (양수면 상승추세)
--
-- 인프라 추가 없음 — 기존 score 시계열만 보면 됨.

DROP VIEW IF EXISTS public.jimscanner_trends_persistence_v;

CREATE VIEW public.jimscanner_trends_persistence_v AS
WITH params AS (
  SELECT 30::int AS window_days, 50::numeric AS top_threshold
),
-- 각 product 의 day(KST) 별 대표 final_score (해당일 마지막 measurement)
daily AS (
  SELECT
    s.product_id,
    (date_trunc('day', (s.computed_at AT TIME ZONE 'Asia/Seoul')))::date AS day_kst,
    (ARRAY_AGG(s.final_score ORDER BY s.computed_at DESC))[1]  AS final_score,
    (ARRAY_AGG(s.trend_score ORDER BY s.computed_at DESC))[1]  AS trend_score,
    MAX(s.computed_at) AS last_at
  FROM public.jimscanner_trends_scores s
  WHERE s.computed_at >= (now() - interval '30 days')
  GROUP BY s.product_id, day_kst
),
-- product 별 day 시계열을 한 줄로 압축
agg AS (
  SELECT
    d.product_id,
    COUNT(*)::int                                                                  AS days_seen,
    COUNT(*) FILTER (WHERE d.final_score >= (SELECT top_threshold FROM params))::int AS persistence_days,
    AVG(d.final_score)::numeric                                                    AS mean_score,
    STDDEV_POP(d.final_score)::numeric                                             AS std_score,
    MAX(d.final_score)::numeric                                                    AS max_score,
    MIN(d.final_score)::numeric                                                    AS min_score,
    MAX(d.last_at)                                                                 AS last_at,
    ARRAY_AGG(d.day_kst     ORDER BY d.day_kst DESC)                               AS days_arr,
    ARRAY_AGG(d.final_score ORDER BY d.day_kst DESC)                               AS scores_arr
  FROM daily d
  GROUP BY d.product_id
),
-- streak = 최근 day(어제/오늘) 부터 역방향 연속된 day 의 개수.
-- trick: gaps-and-islands → days_arr[i] - (i-1) 이 같은 그룹이면 연속. 최근 그룹 사이즈가 streak.
streak AS (
  SELECT
    a.product_id,
    CASE
      WHEN array_length(a.days_arr, 1) IS NULL THEN 0
      WHEN a.days_arr[1] < ((now() AT TIME ZONE 'Asia/Seoul')::date - 1) THEN 0
      ELSE (
        SELECT COUNT(*)::int
        FROM generate_series(1, array_length(a.days_arr, 1)) AS i
        WHERE a.days_arr[i] - ((i - 1) || ' days')::interval = a.days_arr[1]::timestamp
      )
    END AS streak_days
  FROM agg a
),
-- direction_net = day-over-day Δ 의 부호 합. 양수면 우상향, 0 이면 sideways, 음수면 하락.
direction AS (
  SELECT
    a.product_id,
    CASE
      WHEN array_length(a.scores_arr, 1) IS NULL OR array_length(a.scores_arr, 1) < 2 THEN 0
      ELSE (
        SELECT SUM(SIGN(a.scores_arr[i] - a.scores_arr[i + 1]))::int
        FROM generate_series(1, array_length(a.scores_arr, 1) - 1) AS i
      )
    END AS direction_net
  FROM agg a
)
SELECT
  a.product_id,
  a.days_seen,
  a.persistence_days,
  COALESCE(s.streak_days, 0)::int                                       AS streak_days,
  a.mean_score,
  a.std_score,
  CASE WHEN a.mean_score IS NULL OR a.mean_score = 0
       THEN NULL ELSE (a.std_score / a.mean_score) END                  AS cv,
  a.max_score,
  a.min_score,
  COALESCE(d.direction_net, 0)::int                                     AS direction_net,
  a.last_at,
  -- 진성도 종합 점수 (0~100):
  --   40% persistence_days/30
  -- + 30% streak_days/14 (cap)
  -- + 20% stability (1 - cv, clipped to [0,1])
  -- + 10% rising bonus (direction_net > 0)
  ROUND((
      0.40 * LEAST(a.persistence_days::numeric / 30.0, 1.0)
    + 0.30 * LEAST(COALESCE(s.streak_days, 0)::numeric / 14.0, 1.0)
    + 0.20 * GREATEST(0.0, 1.0 - COALESCE(a.std_score / NULLIF(a.mean_score, 0), 1))
    + 0.10 * CASE WHEN COALESCE(d.direction_net, 0) > 0 THEN 1 ELSE 0 END
  ) * 100, 1)::numeric AS reproducibility_score
FROM agg a
LEFT JOIN streak    s ON s.product_id = a.product_id
LEFT JOIN direction d ON d.product_id = a.product_id;

COMMENT ON VIEW public.jimscanner_trends_persistence_v IS
  '시간축 Reproducibility Index — 최근 30일 final_score 시계열로부터 persistence/streak/cv/direction 도출.';

REVOKE ALL ON public.jimscanner_trends_persistence_v FROM anon, authenticated;
GRANT  SELECT ON public.jimscanner_trends_persistence_v TO service_role;
