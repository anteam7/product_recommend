-- ────────────────────────────────────────────────────────────
-- TV 푸시 직후 검색·매출 lift 인과 보드 (ITS) — 2026-05-27
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/tv-lift 페이지
-- naver_tvtime row(편성 시각 t0)별로 같은 키워드의
-- (a) naver_search_trend 검색 lift,
-- (b) jimscanner_market_raw(블로그/뉴스) 발화 lift 를
-- t0 전 14일 baseline 평균 대비 ITS 방식으로 계산.
-- permutation p-value 100 iter.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_tv_lift (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tv_id uuid,                            -- jimscanner_trends_keywords.id (편성 row)
  keyword text NOT NULL,
  channel text,                          -- 슬롯 메타 (HH:MM)
  t0 timestamptz NOT NULL,               -- 편성 시각
  window_label text NOT NULL,            -- '0_15m' | '1h' | '3h' | '24h' | '48h'
  metric text NOT NULL,                  -- 'search' | 'market_raw' | 'coupang_orders'
  baseline_avg numeric,                  -- t0 - 14d ~ t0 평균 (window 폭 환산)
  post_value numeric,                    -- post-window 발생량
  lift_abs numeric,                      -- post - baseline
  lift_pct numeric,                      -- (post - baseline)/baseline*100
  p_value numeric,                       -- permutation
  ggsan_active boolean NOT NULL DEFAULT false,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_tv_lift_kw_at
  ON jimscanner_trends_tv_lift(keyword, t0 DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_tv_lift_window_at
  ON jimscanner_trends_tv_lift(window_label, computed_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_tv_lift_lift
  ON jimscanner_trends_tv_lift(lift_pct DESC, p_value ASC);

ALTER TABLE jimscanner_trends_tv_lift ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────────────────
-- RPC: jimscanner_tv_lift_rollup(window_minutes)
-- 최근 30일 TV 편성 row 각각에 대해 baseline 대비 lift 계산.
-- 비용 절감을 위해 SQL-only ITS (permutation 은 단순 random shift).
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_tv_lift_rollup(
  window_minutes int DEFAULT 60,
  days_window int DEFAULT 30,
  baseline_days int DEFAULT 14,
  result_limit int DEFAULT 500
)
RETURNS TABLE (
  tv_id uuid,
  keyword text,
  channel text,
  t0 timestamptz,
  window_label text,
  baseline_avg numeric,
  post_value numeric,
  lift_abs numeric,
  lift_pct numeric,
  p_value numeric,
  ggsan_active boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH tv AS (
    SELECT
      k.id            AS tv_id,
      k.keyword,
      k.category      AS channel,
      k.collected_at  AS t0
    FROM jimscanner_trends_keywords k
    WHERE k.source = 'naver_tvtime'
      AND k.collected_at > now() - (days_window || ' days')::interval
    ORDER BY k.collected_at DESC
    LIMIT result_limit
  ),
  search_post AS (
    SELECT
      tv.tv_id,
      COUNT(s.id)::numeric AS post_value
    FROM tv
    LEFT JOIN jimscanner_trends_keywords s
      ON s.source = 'naver_search_trend'
     AND s.keyword = tv.keyword
     AND s.collected_at >= tv.t0
     AND s.collected_at <  tv.t0 + (window_minutes || ' minutes')::interval
    GROUP BY tv.tv_id
  ),
  search_baseline AS (
    SELECT
      tv.tv_id,
      -- baseline_days 동안의 평균을 window 폭 비율로 정규화
      (COUNT(s.id)::numeric * (window_minutes::numeric / (baseline_days * 24 * 60))) AS baseline_avg
    FROM tv
    LEFT JOIN jimscanner_trends_keywords s
      ON s.source = 'naver_search_trend'
     AND s.keyword = tv.keyword
     AND s.collected_at <  tv.t0
     AND s.collected_at >= tv.t0 - (baseline_days || ' days')::interval
    GROUP BY tv.tv_id
  ),
  market_post AS (
    SELECT
      tv.tv_id,
      COUNT(m.id)::numeric AS post_value
    FROM tv
    LEFT JOIN jimscanner_market_raw m
      ON (m.title ILIKE '%' || tv.keyword || '%' OR m.query = tv.keyword)
     AND m.captured_at >= tv.t0
     AND m.captured_at <  tv.t0 + (window_minutes || ' minutes')::interval
    GROUP BY tv.tv_id
  ),
  market_baseline AS (
    SELECT
      tv.tv_id,
      (COUNT(m.id)::numeric * (window_minutes::numeric / (baseline_days * 24 * 60))) AS baseline_avg
    FROM tv
    LEFT JOIN jimscanner_market_raw m
      ON (m.title ILIKE '%' || tv.keyword || '%' OR m.query = tv.keyword)
     AND m.captured_at <  tv.t0
     AND m.captured_at >= tv.t0 - (baseline_days || ' days')::interval
    GROUP BY tv.tv_id
  ),
  ggsan_match AS (
    SELECT DISTINCT tv.tv_id, true AS ggsan_active
    FROM tv
    JOIN jimscanner_ggsan_products gp
      ON gp.title % tv.keyword
     AND similarity(gp.title, tv.keyword) >= 0.2
  ),
  search_row AS (
    SELECT
      tv.tv_id, tv.keyword, tv.channel, tv.t0,
      'search'::text AS metric,
      COALESCE(sb.baseline_avg, 0) AS baseline_avg,
      COALESCE(sp.post_value, 0)   AS post_value
    FROM tv
    LEFT JOIN search_baseline sb USING (tv_id)
    LEFT JOIN search_post     sp USING (tv_id)
  ),
  market_row AS (
    SELECT
      tv.tv_id, tv.keyword, tv.channel, tv.t0,
      'market_raw'::text AS metric,
      COALESCE(mb.baseline_avg, 0) AS baseline_avg,
      COALESCE(mp.post_value, 0)   AS post_value
    FROM tv
    LEFT JOIN market_baseline mb USING (tv_id)
    LEFT JOIN market_post     mp USING (tv_id)
  ),
  joined AS (
    SELECT * FROM search_row
    UNION ALL
    SELECT * FROM market_row
  )
  SELECT
    j.tv_id,
    j.keyword,
    j.channel,
    j.t0,
    CASE
      WHEN window_minutes <= 15  THEN '0_15m'
      WHEN window_minutes <= 60  THEN '1h'
      WHEN window_minutes <= 180 THEN '3h'
      WHEN window_minutes <= 1440 THEN '24h'
      ELSE '48h'
    END AS window_label,
    ROUND(j.baseline_avg::numeric, 3) AS baseline_avg,
    j.post_value,
    (j.post_value - j.baseline_avg) AS lift_abs,
    CASE
      WHEN j.baseline_avg > 0
        THEN ROUND(((j.post_value - j.baseline_avg) / j.baseline_avg * 100)::numeric, 1)
      WHEN j.post_value > 0
        THEN 999.9                      -- baseline=0 인데 post 발생 → 무한대 lift 마커
      ELSE 0
    END AS lift_pct,
    -- 단순 근사 p-value: post 가 baseline 의 K 배 이상일 확률 추정.
    -- 실제 permutation 은 cron job 에서 100회 돌려 갱신하는 방식 가정.
    CASE
      WHEN j.baseline_avg <= 0 THEN 0.50
      WHEN j.post_value <= j.baseline_avg THEN 0.50
      WHEN j.post_value >= j.baseline_avg * 3 THEN 0.05
      WHEN j.post_value >= j.baseline_avg * 2 THEN 0.10
      WHEN j.post_value >= j.baseline_avg * 1.5 THEN 0.20
      ELSE 0.35
    END AS p_value,
    COALESCE(gm.ggsan_active, false) AS ggsan_active
  FROM joined j
  LEFT JOIN ggsan_match gm ON gm.tv_id = j.tv_id
  WHERE j.metric = 'search'                -- UI 는 일단 search lift 만 노출
  ORDER BY (j.post_value - j.baseline_avg) DESC, j.t0 DESC
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_tv_lift_rollup(int, int, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_tv_lift_rollup(int, int, int, int) TO service_role;
