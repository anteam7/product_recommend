-- ────────────────────────────────────────────────────────────
-- 품절 보정 수요 복원 (Censored-Demand Correction) — 2026-05-28
-- ────────────────────────────────────────────────────────────
-- 도매(ggsan) 또는 자기 SKU 가 품절·PENDING·차단 상태였던 구간 동안에는
-- 검색·핀 전환 수요가 인위적으로 억눌려 score 가 과소평가된다.
-- 이 마이그레이션은 (1) 품절 구간을 추출하는 뷰와
-- (2) 보정계수(censored_correction_factor) 적재 후 read 용 헬퍼 뷰 를 만든다.
--
-- 이 보정계수는 scripts/recompute-censored-scores.mjs 가 매일 야간 cron 으로
-- jimscanner_trends_scores.score_components.censored_correction_factor 에
-- 적재한다 (테이블 스키마 변경 없음).
-- ────────────────────────────────────────────────────────────


-- 1) ggsan 품절 구간 뷰
--    jimscanner_ggsan_price_history 에서 consecutive status 변화를 run-length 압축.
--    status IN ('sold_out','removed') 인 run 만 노출.
--
--    한 row = 한 goods_no 의 연속된 품절 구간 한 개.
--    started_at: 해당 run 의 첫 관측
--    ended_at:   해당 run 의 마지막 관측 (재고 복원 직전 또는 현재 진행 중)
--    is_ongoing: run 의 마지막 row 가 가장 최신 관측치인가 (아직 끝나지 않음)
CREATE OR REPLACE VIEW jimscanner_stockout_intervals AS
WITH ordered AS (
  SELECT
    goods_no,
    status,
    observed_at,
    LAG(status) OVER (PARTITION BY goods_no ORDER BY observed_at) AS prev_status,
    MAX(observed_at) OVER (PARTITION BY goods_no) AS latest_observed_at
  FROM jimscanner_ggsan_price_history
),
runs AS (
  SELECT
    goods_no,
    status,
    observed_at,
    latest_observed_at,
    SUM(CASE WHEN status IS DISTINCT FROM prev_status THEN 1 ELSE 0 END)
      OVER (PARTITION BY goods_no ORDER BY observed_at) AS run_id
  FROM ordered
)
SELECT
  goods_no,
  run_id,
  MIN(status) AS status,
  MIN(observed_at) AS started_at,
  MAX(observed_at) AS ended_at,
  EXTRACT(EPOCH FROM (MAX(observed_at) - MIN(observed_at))) / 86400.0 AS duration_days,
  (MAX(observed_at) = MIN(latest_observed_at)) AS is_ongoing
FROM runs
WHERE status IN ('sold_out', 'removed')
GROUP BY goods_no, run_id;

COMMENT ON VIEW jimscanner_stockout_intervals IS
  'ggsan 도매몰 SKU 별 품절·삭제 연속 구간. censored-demand 보정의 기본 인풋.';


-- 2) 30일 누적 품절 비율 뷰
--    각 goods_no 가 최근 30일 중 며칠 동안 품절이었는지.
--    censored fraction = stockout_days / 30
CREATE OR REPLACE VIEW jimscanner_ggsan_stockout_30d AS
WITH window_bounds AS (
  SELECT
    now() - interval '30 days' AS w_start,
    now() AS w_end
),
clamped AS (
  SELECT
    s.goods_no,
    GREATEST(s.started_at, wb.w_start) AS eff_start,
    LEAST(s.ended_at, wb.w_end) AS eff_end
  FROM jimscanner_stockout_intervals s
  CROSS JOIN window_bounds wb
  WHERE s.ended_at >= wb.w_start
    AND s.started_at <= wb.w_end
)
SELECT
  goods_no,
  COALESCE(
    SUM(EXTRACT(EPOCH FROM (eff_end - eff_start)) / 86400.0),
    0
  ) AS stockout_days,
  LEAST(
    COALESCE(
      SUM(EXTRACT(EPOCH FROM (eff_end - eff_start)) / 86400.0),
      0
    ) / 30.0,
    1.0
  ) AS censored_fraction
FROM clamped
GROUP BY goods_no;

COMMENT ON VIEW jimscanner_ggsan_stockout_30d IS
  '최근 30일 ggsan 품절 비율. recompute-censored-scores.mjs 의 보정계수 산정 인풋.';


-- 3) 보정계수 lookup 뷰 (UI 용)
--    score_components.censored_correction_factor 를 평탄화하여 product_id 별로 노출.
--    Kaplan-Meier 스타일: corrected_score = raw_score * factor
CREATE OR REPLACE VIEW jimscanner_censored_corrections AS
WITH latest_scores AS (
  SELECT DISTINCT ON (product_id)
    product_id,
    final_score,
    score_components,
    computed_at
  FROM jimscanner_trends_scores
  ORDER BY product_id, computed_at DESC
)
SELECT
  ls.product_id,
  ls.final_score AS raw_final_score,
  COALESCE(
    (ls.score_components -> 'censored_correction_factor' ->> 'factor')::numeric,
    1.0
  ) AS correction_factor,
  COALESCE(
    (ls.score_components -> 'censored_correction_factor' ->> 'censored_fraction')::numeric,
    0.0
  ) AS censored_fraction,
  ls.score_components -> 'censored_correction_factor' ->> 'method' AS method,
  ls.score_components -> 'censored_correction_factor' ->> 'goods_no' AS goods_no,
  (ls.score_components -> 'censored_correction_factor' ->> 'updated_at')::timestamptz AS updated_at,
  ls.final_score * COALESCE(
    (ls.score_components -> 'censored_correction_factor' ->> 'factor')::numeric,
    1.0
  ) AS corrected_final_score,
  ls.computed_at
FROM latest_scores ls;

COMMENT ON VIEW jimscanner_censored_corrections IS
  '품절 보정 score lookup. UI(/admin/trend-radar/censored-demand) 에서 사용.';
