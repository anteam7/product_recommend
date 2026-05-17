-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 유사 과거 케이스 검색 RPC
-- jimscanner_find_analogs(target_id, window_days, k) — 2026-05-17
-- ─────────────────────────────────────────────────────────────
-- 입력 product 의 최근 window_days 일 final_score 시계열을
-- 다른 모든 canonical 상품의 "전체 누적" final_score 시계열에서
-- 같은 길이의 슬라이딩 윈도우로 가장 닮은 구간을 찾아 top-k.
--
-- 유사도: 1 - normalized L1 distance.
--   sim = 1 - SUM(|a_i - b_i|) / (window_days * 100)
--   → 0~1 (1 = 완벽 일치)
--
-- 시간 정렬:
--   target / candidate 모두 "최근 window_days 일을 N 개 슬롯으로 buckets",
--   day-bucket 별 평균 final_score 로 비교.
--
-- 결과:
--   { product_id, canonical_name, category_top, sim,
--     outcome_label, peak_final, days_to_peak, post_peak_drawdown_pct,
--     last_seen_at }
--
-- D5: SECURITY DEFINER + service-role 만 호출.
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_find_analogs(
  target_id uuid,
  window_days int DEFAULT 14,
  k int DEFAULT 5
)
RETURNS TABLE (
  product_id uuid,
  canonical_name text,
  category_top text,
  sim real,
  outcome_label text,
  peak_final numeric,
  days_to_peak int,
  post_peak_drawdown_pct numeric,
  history_days int,
  last_seen_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  target_avg numeric[];
  cutoff timestamptz := now() - (window_days || ' days')::interval;
BEGIN
  -- 1) target 시계열 — day-bucket 평균 final_score 배열
  SELECT array_agg(avg_score ORDER BY d) INTO target_avg
  FROM (
    SELECT
      date_trunc('day', s.computed_at) AS d,
      AVG(s.final_score)::numeric AS avg_score
    FROM jimscanner_trends_scores s
    WHERE s.product_id = target_id
      AND s.computed_at >= cutoff
    GROUP BY 1
  ) t;

  IF target_avg IS NULL OR array_length(target_avg, 1) IS NULL OR array_length(target_avg, 1) < 2 THEN
    RETURN; -- 충분한 데이터 없음
  END IF;

  RETURN QUERY
  WITH cand AS (
    -- 다른 모든 상품의 day-bucket 평균 (전체 누적, 길이 무관)
    SELECT
      s.product_id,
      array_agg(s.avg_score ORDER BY s.d) AS avg_arr
    FROM (
      SELECT
        s2.product_id,
        date_trunc('day', s2.computed_at) AS d,
        AVG(s2.final_score)::numeric AS avg_score
      FROM jimscanner_trends_scores s2
      WHERE s2.product_id <> target_id
      GROUP BY 1, 2
    ) s
    GROUP BY s.product_id
    HAVING COUNT(*) >= array_length(target_avg, 1)
  ),
  scored AS (
    -- 후보 시계열에서 길이가 target 과 같은 모든 슬라이딩 윈도우의 최고 유사도
    SELECT
      c.product_id,
      MAX(
        1.0 - (
          (
            SELECT SUM(ABS(c.avg_arr[i + s_off - 1] - target_avg[i]))
            FROM generate_series(1, array_length(target_avg, 1)) AS i
          )
          / (array_length(target_avg, 1) * 100.0)
        )
      )::real AS sim
    FROM cand c
    CROSS JOIN LATERAL generate_series(1, array_length(c.avg_arr, 1) - array_length(target_avg, 1) + 1) AS s_off
    GROUP BY c.product_id
  )
  SELECT
    sc.product_id,
    p.canonical_name,
    p.category_top,
    sc.sim,
    COALESCE(ao.outcome_label, 'unknown') AS outcome_label,
    COALESCE(ao.peak_final, 0)::numeric AS peak_final,
    COALESCE(ao.days_to_peak, 0)::int AS days_to_peak,
    COALESCE(ao.post_peak_drawdown_pct, 0)::numeric AS post_peak_drawdown_pct,
    COALESCE(ao.history_days, 0)::int AS history_days,
    p.last_seen_at
  FROM scored sc
  JOIN jimscanner_trends_products p ON p.id = sc.product_id
  LEFT JOIN jimscanner_trends_analog_outcomes ao ON ao.product_id = sc.product_id
  WHERE sc.sim IS NOT NULL
  ORDER BY sc.sim DESC NULLS LAST
  LIMIT k;
END;
$$;

REVOKE ALL ON FUNCTION jimscanner_find_analogs(uuid, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_find_analogs(uuid, int, int) TO service_role;
