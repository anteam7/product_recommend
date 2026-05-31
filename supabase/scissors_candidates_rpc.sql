-- ────────────────────────────────────────────────────────────
-- 수요-공급 가위 차트 RPC (PR-SCISSORS-1, 2026-05-31)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/scissors
-- 목적: 도매가(jimscanner_ggsan_price_history)는 내려가는데
--       수요(jimscanner_trends_scores.final_score)는 오르는 '가위' 후보 발굴.
--       두 시계열의 최근 N일 회귀 기울기를 구해 scissors_score 산출.
--
-- 핵심 매핑:
--   trends_products(canonical_name) ↔ ggsan_products(title) 는 직접 FK 없음.
--   recommend RPC 와 동일하게 pg_trgm similarity 로 best-match goods_no 연결.
--   가격 이력이 없는 후보(매칭 실패 또는 history 부재)는 has_sourcing=false
--   → UI 에서 '소싱 미연결' 로 분리.
--
-- scissors_score 정의:
--   demand_slope_pct  = (final_score 회귀기울기 / 평균 final_score) * 100   [%/day]
--   price_slope_pct   = (price_krw 회귀기울기   / 평균 price)        * 100   [%/day]
--   raw               = demand_slope_pct − price_slope_pct
--                       (수요↑·도매가↓ 일수록 큼 = 골든 진입 시그널)
--   margin_headroom 가중 = (0.5 + LEAST(current_demand,100)/200)
--                       (현재 수요가 높을수록 가위가 더 가치있다는 가중)
--   scissors_score    = raw * margin_headroom
-- ────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION jimscanner_scissors_candidates(
  days_window int DEFAULT 14,
  min_sim float DEFAULT 0.20,
  result_limit int DEFAULT 100
)
RETURNS TABLE (
  product_id uuid,
  canonical_name text,
  category_top text,
  goods_no text,
  ggsan_title text,
  detail_url text,
  sim real,
  current_price int,
  price_first int,
  current_demand real,
  demand_first real,
  demand_slope real,        -- final_score units / day
  price_slope real,         -- KRW / day
  demand_change_pct real,
  price_change_pct real,
  scissors_score real,
  has_sourcing boolean,
  demand_points int,
  price_points int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  -- 1) 수요 시계열 (product_id 별 최근 N일 final_score)
  demand_series AS (
    SELECT
      s.product_id,
      extract(epoch FROM s.computed_at) / 86400.0 AS day_x,
      s.final_score::numeric AS y,
      s.computed_at
    FROM jimscanner_trends_scores s
    WHERE s.computed_at > now() - (days_window || ' days')::interval
  ),
  demand_agg AS (
    SELECT
      product_id,
      regr_slope(y, day_x) AS slope,
      avg(y) AS avg_y,
      count(*)::int AS n,
      (array_agg(y ORDER BY computed_at DESC))[1] AS last_y,
      (array_agg(y ORDER BY computed_at ASC))[1] AS first_y
    FROM demand_series
    GROUP BY product_id
    HAVING count(*) >= 2
  ),

  -- 2) trends_product ↔ ggsan goods 매핑 (trigram best-match, recommend RPC 와 동일 패턴)
  prod_match AS (
    SELECT
      p.id AS product_id,
      p.canonical_name,
      p.category_top,
      gp.goods_no,
      gp.title AS ggsan_title,
      gp.detail_url,
      gp.price_krw AS catalog_price,
      gp.sim
    FROM jimscanner_trends_products p
    LEFT JOIN LATERAL (
      SELECT g.goods_no, g.title, g.detail_url, g.price_krw,
             similarity(p.canonical_name, g.title) AS sim
      FROM jimscanner_ggsan_products g
      WHERE g.title % p.canonical_name
        AND similarity(p.canonical_name, g.title) >= min_sim
      ORDER BY similarity(p.canonical_name, g.title) DESC
      LIMIT 1
    ) gp ON true
  ),

  -- 3) 도매가 시계열 (goods_no 별 최근 N일)
  price_series AS (
    SELECT
      ph.goods_no,
      extract(epoch FROM ph.observed_at) / 86400.0 AS day_x,
      ph.price_krw::numeric AS y,
      ph.observed_at
    FROM jimscanner_ggsan_price_history ph
    WHERE ph.observed_at > now() - (days_window || ' days')::interval
      AND ph.price_krw IS NOT NULL
  ),
  price_agg AS (
    SELECT
      goods_no,
      regr_slope(y, day_x) AS slope,
      avg(y) AS avg_y,
      count(*)::int AS n,
      (array_agg(y ORDER BY observed_at DESC))[1] AS last_y,
      (array_agg(y ORDER BY observed_at ASC))[1] AS first_y
    FROM price_series
    GROUP BY goods_no
    HAVING count(*) >= 2
  )

  SELECT
    da.product_id,
    pm.canonical_name,
    pm.category_top,
    pm.goods_no,
    pm.ggsan_title,
    pm.detail_url,
    COALESCE(pm.sim, 0)::real AS sim,
    COALESCE(pa.last_y, pm.catalog_price)::int AS current_price,
    pa.first_y::int AS price_first,
    da.last_y::real AS current_demand,
    da.first_y::real AS demand_first,
    da.slope::real AS demand_slope,
    pa.slope::real AS price_slope,
    (CASE WHEN da.first_y > 0 THEN (da.last_y - da.first_y) / da.first_y * 100 ELSE 0 END)::real AS demand_change_pct,
    (CASE WHEN pa.first_y > 0 THEN (pa.last_y - pa.first_y) / pa.first_y * 100 ELSE NULL END)::real AS price_change_pct,
    (
      (
        (CASE WHEN da.avg_y > 0 THEN da.slope / da.avg_y * 100 ELSE 0 END)
        - COALESCE(CASE WHEN pa.avg_y > 0 THEN pa.slope / pa.avg_y * 100 ELSE 0 END, 0)
      )
      * (0.5 + LEAST(da.last_y, 100) / 200.0)
    )::real AS scissors_score,
    (pm.goods_no IS NOT NULL AND pa.goods_no IS NOT NULL) AS has_sourcing,
    da.n AS demand_points,
    COALESCE(pa.n, 0) AS price_points
  FROM demand_agg da
  JOIN prod_match pm ON pm.product_id = da.product_id
  LEFT JOIN price_agg pa ON pa.goods_no = pm.goods_no
  ORDER BY scissors_score DESC NULLS LAST
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출
REVOKE ALL ON FUNCTION jimscanner_scissors_candidates(int, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_scissors_candidates(int, float, int) TO service_role;
