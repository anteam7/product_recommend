-- ────────────────────────────────────────────────────────────
-- 경쟁 혼잡화 속도 게이트 RPC (PR-CROWDING, 2026-06-03)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/crowding 페이지 + trend-radar 메인 KPI
--
-- jimscanner_trends_scores 는 recompute 마다 1행씩 쌓이는 시계열이라
-- product_id 별 competition_score 의 변화율 d(competition)/dt 를 회귀로 산출한다.
-- 기존 보드는 competition_score 를 '스냅샷 레벨' 로만 썼지만, 위탁 셀러에게
-- 치명적인 건 경쟁이 '많은' 것보다 '빠르게 몰리는' 것 — 등록 리드타임 안에
-- 마진이 증발한다. competition 의 1차 미분(기울기)으로 진입창이 열려있는지/
-- 닫히는지를 분리한다.
--
-- regr_slope(y, x): x 1단위당 y 변화량. x 는 일(day) 단위 → 일당 점수 변화.
-- trend_slope(수요 가속) × competition_slope(경쟁 가속) 2×2 사분면:
--   ① 블루오션 브레이크아웃 (수요↑·경쟁 평탄) → 깊게 소싱
--   ② 닫히는 창           (수요↑·경쟁 급증) → 지금 들어가거나 스킵
--   ③ 포화               (수요 평탄·경쟁↑) → 회피
--   ④ 소멸               (수요 평탄·경쟁 평탄/↓)
--
-- service_role 로만 호출 (어드민 한정) — SECURITY DEFINER + grant 명시.
-- (기존 jimscanner_tv_ggsan_match RPC 패턴과 동일)
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_trends_crowding(
  days_window int DEFAULT 7,
  min_points int DEFAULT 3,
  result_limit int DEFAULT 500
)
RETURNS TABLE (
  product_id uuid,
  canonical_name text,
  category_top text,
  competition_latest numeric,
  trend_latest numeric,
  final_latest numeric,
  competition_slope numeric,   -- 일당 competition_score 변화 (경쟁 유입 가속도)
  trend_slope numeric,         -- 일당 trend_score 변화 (수요 가속도)
  competition_delta numeric,   -- window 내 최신 - 최초
  trend_delta numeric,
  n_points int,
  first_at timestamptz,
  last_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH win AS (
    SELECT
      s.product_id,
      s.competition_score,
      s.trend_score,
      s.final_score,
      s.computed_at,
      EXTRACT(EPOCH FROM s.computed_at) / 86400.0 AS day_x
    FROM jimscanner_trends_scores s
    WHERE s.computed_at > now() - (days_window || ' days')::interval
  ),
  agg AS (
    SELECT
      w.product_id,
      COUNT(*)::int AS n_points,
      regr_slope(w.competition_score, w.day_x) AS competition_slope,
      regr_slope(w.trend_score, w.day_x) AS trend_slope,
      MIN(w.computed_at) AS first_at,
      MAX(w.computed_at) AS last_at,
      (array_agg(w.competition_score ORDER BY w.computed_at DESC))[1] AS competition_latest,
      (array_agg(w.competition_score ORDER BY w.computed_at ASC))[1]  AS competition_first,
      (array_agg(w.trend_score ORDER BY w.computed_at DESC))[1] AS trend_latest,
      (array_agg(w.trend_score ORDER BY w.computed_at ASC))[1]  AS trend_first,
      (array_agg(w.final_score ORDER BY w.computed_at DESC))[1] AS final_latest
    FROM win w
    GROUP BY w.product_id
    HAVING COUNT(*) >= min_points
  )
  SELECT
    a.product_id,
    p.canonical_name,
    p.category_top,
    a.competition_latest,
    a.trend_latest,
    a.final_latest,
    a.competition_slope,
    a.trend_slope,
    (a.competition_latest - a.competition_first) AS competition_delta,
    (a.trend_latest - a.trend_first) AS trend_delta,
    a.n_points,
    a.first_at,
    a.last_at
  FROM agg a
  JOIN jimscanner_trends_products p ON p.id = a.product_id
  -- 경쟁 유입 가속도(혼잡화 속도) 높은 순
  ORDER BY a.competition_slope DESC NULLS LAST
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출 (anon/authenticated 차단)
REVOKE ALL ON FUNCTION jimscanner_trends_crowding(int, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_trends_crowding(int, int, int) TO service_role;
