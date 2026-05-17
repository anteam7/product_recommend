-- ────────────────────────────────────────────────────────────
-- 트렌드 생존곡선 (Kaplan-Meier) — 2026-05-17
-- ────────────────────────────────────────────────────────────
-- 목적: jimscanner_trends_scores 시계열에서 product 단위로
--       '진입(final_score≥50) → 이탈(score<35)' 이벤트를 추출하고,
--       카테고리(category_top·category_mid)별 KM 추정치를 제공.
--
-- 정의:
--   - entered_at      : final_score >= 50 이 된 첫 computed_at
--   - exited_at       : entered_at 이후 첫 final_score < 35
--   - censored        : exited_at IS NULL (아직 살아있음 → last_seen_at 기준 right-censoring)
--   - duration_weeks  : ceil( (exit_or_last - enter) / 7 days )
--
-- 사용처: /admin/trend-radar/survival
-- ────────────────────────────────────────────────────────────

-- 1) 이벤트 뷰 — product 1행
CREATE OR REPLACE VIEW jimscanner_trends_survival_events AS
WITH per_product AS (
  SELECT
    p.id              AS product_id,
    p.canonical_name,
    p.category_top,
    p.category_mid,
    p.last_seen_at,
    -- 진입 시점: final_score >= 50 가 된 첫 score row
    (
      SELECT MIN(s.computed_at)
      FROM jimscanner_trends_scores s
      WHERE s.product_id = p.id
        AND s.final_score >= 50
    ) AS entered_at
  FROM jimscanner_trends_products p
),
with_exit AS (
  SELECT
    pp.*,
    -- 이탈 시점: entered_at 이후 첫 final_score < 35
    (
      SELECT MIN(s.computed_at)
      FROM jimscanner_trends_scores s
      WHERE s.product_id = pp.product_id
        AND s.computed_at > pp.entered_at
        AND s.final_score < 35
    ) AS exited_at
  FROM per_product pp
  WHERE pp.entered_at IS NOT NULL
)
SELECT
  product_id,
  canonical_name,
  category_top,
  category_mid,
  entered_at,
  exited_at,
  last_seen_at,
  (exited_at IS NULL) AS censored,
  -- 관찰 기간 (주). 최소 1주.
  GREATEST(
    1,
    CEIL(
      EXTRACT(EPOCH FROM (COALESCE(exited_at, last_seen_at) - entered_at)) / (7 * 86400)
    )::int
  ) AS duration_weeks
FROM with_exit;

COMMENT ON VIEW jimscanner_trends_survival_events IS
  'Kaplan-Meier 입력: product별 진입(≥50)→이탈(<35) 이벤트. censored=true 는 우측 절단.';


-- 2) 카테고리별 KM 곡선 RPC
--    카테고리 그룹키 (category_top 또는 category_top||category_mid) 별로
--    각 주차의 at-risk, events, S(t), 95% CI (log-log) 반환.
CREATE OR REPLACE FUNCTION jimscanner_category_km_curve(
  group_by_mid boolean DEFAULT false,   -- false=top, true=top+mid
  min_n int DEFAULT 5,                  -- 카테고리당 최소 표본수
  max_week int DEFAULT 26               -- 곡선 컷오프 (주)
)
RETURNS TABLE (
  category_key text,
  category_top text,
  category_mid text,
  n_total int,
  n_events int,
  week int,
  at_risk int,
  events int,
  censored int,
  survival numeric,
  survival_lower numeric,
  survival_upper numeric,
  median_week numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH events AS (
    SELECT
      CASE
        WHEN group_by_mid AND e.category_mid IS NOT NULL
          THEN e.category_top || ' / ' || e.category_mid
        ELSE e.category_top
      END AS category_key,
      e.category_top,
      e.category_mid,
      e.duration_weeks,
      e.censored
    FROM jimscanner_trends_survival_events e
    WHERE e.entered_at IS NOT NULL
  ),
  cat_stats AS (
    SELECT
      ev.category_key,
      MIN(ev.category_top) AS category_top,
      MIN(ev.category_mid) AS category_mid,
      COUNT(*)::int AS n_total,
      SUM(CASE WHEN NOT ev.censored THEN 1 ELSE 0 END)::int AS n_events
    FROM events ev
    GROUP BY ev.category_key
    HAVING COUNT(*) >= min_n
  ),
  -- weeks 1..max_week per category
  cat_weeks AS (
    SELECT cs.category_key, w.week
    FROM cat_stats cs
    CROSS JOIN generate_series(1, max_week) AS w(week)
  ),
  -- per (cat, week) tally
  weekly AS (
    SELECT
      cw.category_key,
      cw.week,
      -- at risk at start of week w = those with duration_weeks >= w
      (SELECT COUNT(*)
         FROM events ev2
        WHERE ev2.category_key = cw.category_key
          AND ev2.duration_weeks >= cw.week)::int AS at_risk,
      -- events at this exact week (uncensored exit)
      (SELECT COUNT(*)
         FROM events ev3
        WHERE ev3.category_key = cw.category_key
          AND ev3.duration_weeks = cw.week
          AND NOT ev3.censored)::int AS events,
      -- censors at this exact week
      (SELECT COUNT(*)
         FROM events ev4
        WHERE ev4.category_key = cw.category_key
          AND ev4.duration_weeks = cw.week
          AND ev4.censored)::int AS censored
    FROM cat_weeks cw
  ),
  -- KM step: hazard = events / at_risk; survival = cumulative product
  km AS (
    SELECT
      w.category_key,
      w.week,
      w.at_risk,
      w.events,
      w.censored,
      CASE WHEN w.at_risk > 0 THEN w.events::numeric / w.at_risk ELSE 0 END AS hazard,
      -- variance term for Greenwood: events / (at_risk * (at_risk - events))
      CASE
        WHEN w.at_risk > 0 AND (w.at_risk - w.events) > 0
          THEN w.events::numeric / (w.at_risk::numeric * (w.at_risk - w.events))
        ELSE 0
      END AS var_term
    FROM weekly w
  ),
  km_cum AS (
    SELECT
      k.category_key,
      k.week,
      k.at_risk,
      k.events,
      k.censored,
      -- S(t) = product over weeks<=t of (1 - hazard)
      EXP(SUM(LN(GREATEST(1 - k.hazard, 1e-9)))
            OVER (PARTITION BY k.category_key ORDER BY k.week
                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
      )::numeric AS survival,
      -- Greenwood cumulative variance term
      SUM(k.var_term)
        OVER (PARTITION BY k.category_key ORDER BY k.week
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_var
    FROM km k
  ),
  km_ci AS (
    SELECT
      kc.*,
      -- 95% CI on S(t) — simple plain-scale Greenwood: S +/- 1.96 * S * sqrt(cum_var)
      GREATEST(0,
        kc.survival - 1.96 * kc.survival * SQRT(GREATEST(kc.cum_var, 0))
      )::numeric AS survival_lower,
      LEAST(1,
        kc.survival + 1.96 * kc.survival * SQRT(GREATEST(kc.cum_var, 0))
      )::numeric AS survival_upper
    FROM km_cum kc
  ),
  -- median = first week where S(t) <= 0.5
  medians AS (
    SELECT
      kc.category_key,
      MIN(kc.week) FILTER (WHERE kc.survival <= 0.5) AS median_week
    FROM km_cum kc
    GROUP BY kc.category_key
  )
  SELECT
    cs.category_key,
    cs.category_top,
    cs.category_mid,
    cs.n_total,
    cs.n_events,
    kc.week,
    kc.at_risk,
    kc.events,
    kc.censored,
    ROUND(kc.survival::numeric, 4) AS survival,
    ROUND(kc.survival_lower::numeric, 4) AS survival_lower,
    ROUND(kc.survival_upper::numeric, 4) AS survival_upper,
    m.median_week::numeric
  FROM cat_stats cs
  JOIN km_ci kc ON kc.category_key = cs.category_key
  LEFT JOIN medians m ON m.category_key = cs.category_key
  ORDER BY cs.n_total DESC, cs.category_key, kc.week;
END;
$$;

COMMENT ON FUNCTION jimscanner_category_km_curve IS
  'Kaplan-Meier 카테고리별 생존곡선. group_by_mid=true 면 category_top/mid 까지 분할.';


-- 3) 개별 핀의 잔존 생존확률 lookup RPC
--    현재 핀이 진입한지 N주 됐을 때, 동일 카테고리에서 추가 m주 생존할 확률 = S(N+m)/S(N).
CREATE OR REPLACE FUNCTION jimscanner_product_km_lookup(
  p_product_id uuid
)
RETURNS TABLE (
  product_id uuid,
  category_top text,
  category_mid text,
  entered_at timestamptz,
  current_age_weeks int,
  median_remaining_weeks numeric,
  survival_now numeric,
  -- 향후 +1, +2, +4, +8 주 조건부 생존확률
  p_plus_1w numeric,
  p_plus_2w numeric,
  p_plus_4w numeric,
  p_plus_8w numeric,
  recommended_take_profit_week numeric,
  recommended_stop_loss_week numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_top text;
  v_mid text;
  v_entered timestamptz;
  v_age int;
BEGIN
  SELECT e.category_top, e.category_mid, e.entered_at,
         GREATEST(1, CEIL(EXTRACT(EPOCH FROM (now() - e.entered_at)) / (7 * 86400))::int)
  INTO v_top, v_mid, v_entered, v_age
  FROM jimscanner_trends_survival_events e
  WHERE e.product_id = p_product_id;

  IF v_entered IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH km AS (
    SELECT week, survival, median_week
    FROM jimscanner_category_km_curve(false, 3, 52)
    WHERE category_top = v_top
  ),
  sn AS (SELECT survival AS s_now, median_week FROM km WHERE week = v_age LIMIT 1),
  s1 AS (SELECT survival AS s FROM km WHERE week = v_age + 1 LIMIT 1),
  s2 AS (SELECT survival AS s FROM km WHERE week = v_age + 2 LIMIT 1),
  s4 AS (SELECT survival AS s FROM km WHERE week = v_age + 4 LIMIT 1),
  s8 AS (SELECT survival AS s FROM km WHERE week = v_age + 8 LIMIT 1),
  -- take profit: 잔존확률 0.5 하회 직전 주차 (조건부)
  tp AS (
    SELECT MIN(km.week) - v_age AS w
    FROM km, sn
    WHERE sn.s_now > 0 AND (km.survival / sn.s_now) <= 0.5 AND km.week >= v_age
  ),
  -- stop loss: 잔존확률 0.25 하회 (강한 손절)
  sl AS (
    SELECT MIN(km.week) - v_age AS w
    FROM km, sn
    WHERE sn.s_now > 0 AND (km.survival / sn.s_now) <= 0.25 AND km.week >= v_age
  )
  SELECT
    p_product_id,
    v_top,
    v_mid,
    v_entered,
    v_age,
    sn.median_week,
    sn.s_now,
    CASE WHEN sn.s_now > 0 THEN ROUND((s1.s / sn.s_now)::numeric, 4) END,
    CASE WHEN sn.s_now > 0 THEN ROUND((s2.s / sn.s_now)::numeric, 4) END,
    CASE WHEN sn.s_now > 0 THEN ROUND((s4.s / sn.s_now)::numeric, 4) END,
    CASE WHEN sn.s_now > 0 THEN ROUND((s8.s / sn.s_now)::numeric, 4) END,
    tp.w::numeric,
    sl.w::numeric
  FROM sn
  LEFT JOIN s1 ON true
  LEFT JOIN s2 ON true
  LEFT JOIN s4 ON true
  LEFT JOIN s8 ON true
  LEFT JOIN tp ON true
  LEFT JOIN sl ON true;
END;
$$;

COMMENT ON FUNCTION jimscanner_product_km_lookup IS
  '개별 핀의 진입 주차 기준 잔존 생존확률 lookup. take_profit/stop_loss 권장 주차 포함.';
