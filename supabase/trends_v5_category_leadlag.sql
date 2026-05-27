-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v5 — 카테고리 Lead-Lag 선행지표 보드 (2026-05-27)
-- ─────────────────────────────────────────────────────────────
-- 목적: jimscanner_trends_keywords 의 (category_top, day) 일별 수요 인덱스를
-- 만들고, 카테고리 쌍별 1~14일 lag cross-correlation 으로
-- "선행 카테고리 → 후행 카테고리" 인과를 추정.
--
-- 결과:
--   1) View: jimscanner_trends_category_daily — (category_top, day) 수요 인덱스
--   2) RPC : jimscanner_trends_category_leadlag — 카테고리 쌍별 best lag + r
--   3) RPC : jimscanner_trends_category_overlay — 두 카테고리 시계열 + 선행 상위 키워드
--
-- 모두 service_role 전용 (어드민 한정).
-- ─────────────────────────────────────────────────────────────


-- 1) (category_top, day) 일별 수요 인덱스 — 일반 view 로 유지 (refresh 부담 회피)
--    demand_index = AVG(volume_relative × 1/sqrt(max(rank,1)))
--    rank 가 있는 row 는 rank 가중을 더 받고, 없으면 volume_relative 만 반영.
CREATE OR REPLACE VIEW jimscanner_trends_category_daily AS
SELECT
  category_top,
  (collected_at AT TIME ZONE 'Asia/Seoul')::date AS day,
  AVG(
    COALESCE(volume_relative, 0)::numeric
    * (1.0 / sqrt(GREATEST(COALESCE(rank, 1), 1)))
  )::numeric AS demand_index,
  COUNT(*)::int AS sample_count
FROM jimscanner_trends_keywords
WHERE category_top IS NOT NULL
  AND category_top <> ''
  AND collected_at > now() - interval '90 days'
GROUP BY category_top, (collected_at AT TIME ZONE 'Asia/Seoul')::date;


-- 2) 카테고리 쌍별 best lag + Pearson r
--    lead → lag 방향으로 1..max_lag 일 shift 한 시계열의 corr 계산,
--    각 쌍별 r 최대인 lag 만 반환.
--    또한 선행 카테고리의 최근 3일 2차 미분(가속도) 함께 제공.
CREATE OR REPLACE FUNCTION jimscanner_trends_category_leadlag(
  window_days int DEFAULT 45,
  min_overlap int DEFAULT 10,
  max_lag int DEFAULT 14
)
RETURNS TABLE (
  lead_category text,
  lag_category text,
  best_lag int,
  best_r numeric,
  n_overlap int,
  lead_accel numeric,
  lead_latest numeric,
  lag_latest numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH series AS (
    SELECT category_top, day, demand_index
    FROM jimscanner_trends_category_daily
    WHERE day > (current_date - window_days)
  ),
  cats AS (
    SELECT category_top
    FROM series
    GROUP BY category_top
    HAVING COUNT(*) >= min_overlap
  ),
  pairs AS (
    SELECT a.category_top AS lead_cat, b.category_top AS lag_cat
    FROM cats a CROSS JOIN cats b
    WHERE a.category_top <> b.category_top
  ),
  lag_corrs AS (
    SELECT
      p.lead_cat,
      p.lag_cat,
      g.lag_n,
      CORR(sl.demand_index, sg.demand_index)::numeric AS r,
      COUNT(*)::int AS n
    FROM pairs p
    CROSS JOIN generate_series(1, max_lag) AS g(lag_n)
    JOIN series sl ON sl.category_top = p.lead_cat
    JOIN series sg
      ON sg.category_top = p.lag_cat
     AND sg.day = sl.day + g.lag_n
    GROUP BY p.lead_cat, p.lag_cat, g.lag_n
    HAVING COUNT(*) >= min_overlap
  ),
  ranked AS (
    SELECT
      lead_cat, lag_cat, lag_n, r, n,
      ROW_NUMBER() OVER (
        PARTITION BY lead_cat, lag_cat
        ORDER BY r DESC NULLS LAST
      ) AS rk
    FROM lag_corrs
  ),
  best AS (
    SELECT lead_cat, lag_cat, lag_n AS best_lag, r AS best_r, n AS n_overlap
    FROM ranked WHERE rk = 1
  )
  SELECT
    b.lead_cat,
    b.lag_cat,
    b.best_lag,
    b.best_r,
    b.n_overlap,
    -- 최근 3일 2차 미분 (가속도) 대용: f(t) - 2*f(t-2) + f(t-4)
    (
      COALESCE((SELECT demand_index FROM series WHERE category_top = b.lead_cat AND day = current_date - 1), 0)
      - 2 * COALESCE((SELECT demand_index FROM series WHERE category_top = b.lead_cat AND day = current_date - 3), 0)
      + COALESCE((SELECT demand_index FROM series WHERE category_top = b.lead_cat AND day = current_date - 5), 0)
    )::numeric AS lead_accel,
    COALESCE((
      SELECT demand_index FROM series
      WHERE category_top = b.lead_cat
      ORDER BY day DESC LIMIT 1
    ), 0)::numeric AS lead_latest,
    COALESCE((
      SELECT demand_index FROM series
      WHERE category_top = b.lag_cat
      ORDER BY day DESC LIMIT 1
    ), 0)::numeric AS lag_latest
  FROM best b
  ORDER BY b.best_r DESC NULLS LAST;
$$;

REVOKE ALL ON FUNCTION jimscanner_trends_category_leadlag(int, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_trends_category_leadlag(int, int, int) TO service_role;


-- 3) 두 카테고리 시계열 오버레이 + 선행 카테고리 최근 급등 키워드 Top10
--    UI 셀 클릭 시 호출.
CREATE OR REPLACE FUNCTION jimscanner_trends_category_overlay(
  lead_cat text,
  lag_cat text,
  window_days int DEFAULT 45
)
RETURNS TABLE (
  series_kind text,         -- 'lead_series' | 'lag_series' | 'lead_top_keyword'
  day date,
  category text,
  keyword text,
  value numeric,
  extra jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  -- 선행 카테고리 시계열
  SELECT
    'lead_series'::text AS series_kind,
    day,
    category_top AS category,
    NULL::text AS keyword,
    demand_index AS value,
    NULL::jsonb AS extra
  FROM jimscanner_trends_category_daily
  WHERE category_top = lead_cat
    AND day > (current_date - window_days)

  UNION ALL

  -- 후행 카테고리 시계열
  SELECT
    'lag_series'::text,
    day,
    category_top,
    NULL::text,
    demand_index,
    NULL::jsonb
  FROM jimscanner_trends_category_daily
  WHERE category_top = lag_cat
    AND day > (current_date - window_days)

  UNION ALL

  -- 선행 카테고리에서 최근 3일 급등 중인 상위 키워드 Top10
  -- (volume_relative 최근 3일 평균 - 이전 7일 평균) DESC
  SELECT
    'lead_top_keyword'::text,
    NULL::date,
    lead_cat,
    kw.keyword,
    kw.delta,
    jsonb_build_object('recent3', kw.recent3, 'prev7', kw.prev7, 'last_rank', kw.last_rank)
  FROM (
    SELECT
      keyword,
      AVG(CASE WHEN collected_at > now() - interval '3 days'
               THEN volume_relative END)::numeric AS recent3,
      AVG(CASE WHEN collected_at <= now() - interval '3 days'
                AND collected_at > now() - interval '10 days'
               THEN volume_relative END)::numeric AS prev7,
      (
        COALESCE(AVG(CASE WHEN collected_at > now() - interval '3 days'
                     THEN volume_relative END), 0)
        - COALESCE(AVG(CASE WHEN collected_at <= now() - interval '3 days'
                          AND collected_at > now() - interval '10 days'
                     THEN volume_relative END), 0)
      )::numeric AS delta,
      MIN(rank) FILTER (WHERE collected_at > now() - interval '3 days') AS last_rank
    FROM jimscanner_trends_keywords
    WHERE category_top = lead_cat
      AND collected_at > now() - interval '10 days'
    GROUP BY keyword
    HAVING COUNT(*) >= 2
    ORDER BY (
      COALESCE(AVG(CASE WHEN collected_at > now() - interval '3 days'
                   THEN volume_relative END), 0)
      - COALESCE(AVG(CASE WHEN collected_at <= now() - interval '3 days'
                        AND collected_at > now() - interval '10 days'
                   THEN volume_relative END), 0)
    ) DESC NULLS LAST
    LIMIT 10
  ) kw
  WHERE kw.delta IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION jimscanner_trends_category_overlay(text, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_trends_category_overlay(text, text, int) TO service_role;
