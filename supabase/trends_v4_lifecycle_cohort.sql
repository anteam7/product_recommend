-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — SKU 코호트 생존곡선 (Lifecycle KM)
-- ─────────────────────────────────────────────────────────────
-- 목적: jimscanner_trends_scores 의 final_score 시계열을 product 단위로
--      풀어 first_seen_at 주차로 코호트 묶음 → Kaplan-Meier 스타일
--      생존함수 S(t) = P(final_score ≥ threshold | 첫등장 후 t주)
--
-- 사용처:
--   - /admin/trend-radar/lifecycle 페이지 (KM 곡선 + 활성 SKU 오버레이)
--   - 핀/오퍼튜니티 보드의 'cohort 기반 잔여수명' 컬럼
--
-- 노출 정책: service-role 만 (기존 v4 패턴과 동일)
-- ─────────────────────────────────────────────────────────────


-- 1) 코호트 진단 뷰: product 단위로 first_seen_week, age, current_score 부착
--    (운영 디버깅 및 어드민 보조 조회용 — RPC 와 별개)
CREATE OR REPLACE VIEW jimscanner_trends_lifecycle_cohort AS
SELECT
  p.id                AS product_id,
  p.canonical_name,
  p.category_top,
  p.category_mid,
  p.brand,
  p.first_seen_at,
  p.last_seen_at,
  date_trunc('week', p.first_seen_at)                                        AS cohort_week,
  (EXTRACT(EPOCH FROM (now() - p.first_seen_at)) / (7 * 86400.0))::numeric   AS age_weeks,
  (
    SELECT s.final_score FROM jimscanner_trends_scores s
    WHERE s.product_id = p.id ORDER BY s.computed_at DESC LIMIT 1
  ) AS current_final_score,
  (
    SELECT s.computed_at FROM jimscanner_trends_scores s
    WHERE s.product_id = p.id ORDER BY s.computed_at DESC LIMIT 1
  ) AS last_score_at
FROM jimscanner_trends_products p;


-- 2) RPC: Kaplan-Meier 곡선 데이터
--    event = final_score 가 threshold 아래로 처음 떨어진 시점.
--    censored = 아직 event 미발생 (마지막 관측 또는 now() 까지).
--    반환은 per-week (at_risk, events) → 클라이언트에서 S(t) = Π(1 - d/n) 누적.
CREATE OR REPLACE FUNCTION jimscanner_lifecycle_curve(
  p_category_top text DEFAULT NULL,
  p_category_mid text DEFAULT NULL,
  p_threshold   numeric DEFAULT 50.0
)
RETURNS TABLE (
  week_t        int,
  at_risk       int,
  events        int,
  cohort_size   int
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  WITH prods AS (
    SELECT p.id, p.first_seen_at
    FROM jimscanner_trends_products p
    WHERE (p_category_top IS NULL OR p.category_top = p_category_top)
      AND (p_category_mid IS NULL OR p.category_mid = p_category_mid)
  ),
  ev AS (
    SELECT
      pr.id AS product_id,
      pr.first_seen_at,
      MIN(CASE WHEN s.final_score < p_threshold THEN s.computed_at END) AS event_at,
      MAX(s.computed_at) AS last_at
    FROM prods pr
    LEFT JOIN jimscanner_trends_scores s ON s.product_id = pr.id
    GROUP BY pr.id, pr.first_seen_at
  ),
  survival AS (
    SELECT
      CASE
        WHEN event_at IS NOT NULL
          THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (event_at - first_seen_at)) / (7 * 86400.0))::int)
        ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (COALESCE(last_at, now()) - first_seen_at)) / (7 * 86400.0))::int)
      END AS week_observed,
      (event_at IS NOT NULL) AS had_event
    FROM ev
  ),
  horizon AS (
    SELECT
      GREATEST(COALESCE(MAX(week_observed), 0), 1) AS max_t,
      COUNT(*)::int AS total
    FROM survival
  ),
  ts AS (
    SELECT generate_series(0, (SELECT max_t FROM horizon)) AS t
  )
  SELECT
    t.t::int AS week_t,
    (SELECT COUNT(*)::int FROM survival sv WHERE sv.week_observed >= t.t) AS at_risk,
    (SELECT COUNT(*)::int FROM survival sv WHERE sv.week_observed = t.t AND sv.had_event) AS events,
    (SELECT total FROM horizon) AS cohort_size
  FROM ts t
  ORDER BY t.t;
END;
$$;


-- 3) RPC: 출구 큐 — 임계치 하향돌파 D-7 시점 SKU
--    조건: 최신 score 가 임계치 ± band 구간 안에 있고 직전 점수보다 하락 중.
--    (이미 떨어진 SKU 도 'recently_broken' 으로 함께 노출)
CREATE OR REPLACE FUNCTION jimscanner_lifecycle_exit_queue(
  p_category_top text DEFAULT NULL,
  p_threshold    numeric DEFAULT 50.0,
  p_band         numeric DEFAULT 10.0,
  p_limit        int     DEFAULT 50
)
RETURNS TABLE (
  product_id          uuid,
  canonical_name      text,
  category_top        text,
  category_mid        text,
  current_score       numeric,
  prev_score          numeric,
  score_delta         numeric,
  weeks_since_first   numeric,
  last_score_at       timestamptz,
  status              text
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  WITH ranked AS (
    SELECT
      s.product_id, s.final_score, s.computed_at,
      ROW_NUMBER() OVER (PARTITION BY s.product_id ORDER BY s.computed_at DESC) AS rn
    FROM jimscanner_trends_scores s
  ),
  agg AS (
    SELECT
      p.id            AS product_id,
      p.canonical_name,
      p.category_top,
      p.category_mid,
      p.first_seen_at,
      (SELECT final_score FROM ranked WHERE product_id = p.id AND rn = 1) AS cur,
      (SELECT final_score FROM ranked WHERE product_id = p.id AND rn = 2) AS prev,
      (SELECT computed_at FROM ranked WHERE product_id = p.id AND rn = 1) AS cur_at
    FROM jimscanner_trends_products p
    WHERE (p_category_top IS NULL OR p.category_top = p_category_top)
  )
  SELECT
    a.product_id,
    a.canonical_name,
    a.category_top,
    a.category_mid,
    a.cur                                                                    AS current_score,
    a.prev                                                                   AS prev_score,
    (a.cur - COALESCE(a.prev, a.cur))                                        AS score_delta,
    (EXTRACT(EPOCH FROM (now() - a.first_seen_at)) / (7 * 86400.0))::numeric AS weeks_since_first,
    a.cur_at                                                                 AS last_score_at,
    CASE
      WHEN a.cur < p_threshold THEN 'recently_broken'
      WHEN a.cur >= p_threshold AND a.cur <= p_threshold + p_band
           AND a.prev IS NOT NULL AND a.cur < a.prev THEN 'd7_warning'
      ELSE 'watch'
    END                                                                      AS status
  FROM agg a
  WHERE a.cur IS NOT NULL
    AND (
      a.cur < p_threshold
      OR (
        a.cur <= p_threshold + p_band
        AND a.prev IS NOT NULL
        AND a.cur < a.prev
      )
    )
  ORDER BY
    CASE WHEN a.cur < p_threshold THEN 0 ELSE 1 END,
    (a.cur - p_threshold) ASC,
    (a.cur - COALESCE(a.prev, a.cur)) ASC
  LIMIT p_limit;
END;
$$;
