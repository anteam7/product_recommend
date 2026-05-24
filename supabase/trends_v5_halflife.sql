-- ────────────────────────────────────────────────────────────
-- PR-5: 키워드 반감기(τ½) × 위탁 회수 윈도우 (2026-05-25)
-- ────────────────────────────────────────────────────────────
-- jimscanner_trends_keywords 시계열에 지수감쇠(volume ~ V0·exp(-t/τ))를
-- 선형회귀(log-linearization) 로 적합 → 반감기 τ½ 산출
--
-- ln(volume) = ln(V0) - t/τ  →  slope = -1/τ
-- τ_half_days = ln(2) · τ = -ln(2) / slope
--
-- 분류 (decay_class):
--   - 'noise'        : r2 < 0.4 또는 표본 < 4
--   - 'spike'        : τ½ < 7d   (단발 TV 스파이크)
--   - 'mid'          : 7d ≤ τ½ < 30d (중기 트렌드)
--   - 'long'         : τ½ ≥ 30d  (장기 정착 트렌드)
--
-- 호출: /api/cron/classify-trends-llm 직후 일1회 갱신 (뷰이므로 즉시 반영)
-- ────────────────────────────────────────────────────────────

-- 1) 키워드별 피크 + 회귀 적합 뷰
--
-- 입력: jimscanner_trends_keywords (keyword, source, volume_relative, collected_at, category_top)
-- 윈도우: 최근 90일 (피크 이후 시계열만 회귀에 사용)
-- 출력: keyword, peak_at, peak_volume, tau_half_days, r2, decay_class, sample_n, ci95_low, ci95_high

CREATE OR REPLACE VIEW jimscanner_trends_halflife AS
WITH
-- 최근 90일치 raw 시계열 (volume>0 만)
raw_series AS (
  SELECT
    keyword,
    MAX(category_top) AS category_top,
    MAX(source) AS source,
    collected_at,
    AVG(volume_relative)::numeric AS volume
  FROM jimscanner_trends_keywords
  WHERE collected_at >= now() - interval '90 days'
    AND volume_relative IS NOT NULL
    AND volume_relative > 0
  GROUP BY keyword, collected_at
),
-- 키워드별 피크 시점/값
peaks AS (
  SELECT DISTINCT ON (keyword)
    keyword,
    collected_at AS peak_at,
    volume AS peak_volume
  FROM raw_series
  ORDER BY keyword, volume DESC, collected_at ASC
),
-- 피크 이후 시계열 (회귀 입력)
post_peak AS (
  SELECT
    r.keyword,
    r.category_top,
    p.peak_at,
    p.peak_volume,
    EXTRACT(EPOCH FROM (r.collected_at - p.peak_at)) / 86400.0 AS t_days,
    LN(r.volume) AS ln_v
  FROM raw_series r
  JOIN peaks p ON p.keyword = r.keyword
  WHERE r.collected_at >= p.peak_at
),
-- 키워드별 회귀
fit AS (
  SELECT
    keyword,
    MAX(category_top) AS category_top,
    MAX(peak_at) AS peak_at,
    MAX(peak_volume) AS peak_volume,
    COUNT(*)::int AS sample_n,
    regr_slope(ln_v, t_days) AS slope,
    regr_intercept(ln_v, t_days) AS intercept,
    regr_r2(ln_v, t_days) AS r2,
    -- 표준오차 계산을 위한 sufficient stats
    regr_sxx(ln_v, t_days) AS sxx,
    regr_syy(ln_v, t_days) AS syy
  FROM post_peak
  GROUP BY keyword
  HAVING COUNT(*) >= 3
)
SELECT
  keyword,
  category_top,
  peak_at,
  ROUND(peak_volume, 2) AS peak_volume,
  sample_n,
  CASE
    WHEN slope < 0 THEN ROUND((-LN(2.0) / slope)::numeric, 2)
    ELSE NULL
  END AS tau_half_days,
  ROUND(COALESCE(r2, 0)::numeric, 3) AS r2,
  -- 95% CI for tau_half (delta method 근사):
  -- SE(slope) = sqrt( (syy*(1-r2)) / ((n-2)*sxx) )
  -- d(τ½)/d(slope) = ln(2)/slope^2
  -- CI_τ½ = τ½ ± 1.96 · ln(2)/slope^2 · SE(slope)
  CASE
    WHEN slope < 0 AND sample_n > 2 AND sxx > 0 AND r2 IS NOT NULL AND r2 < 1
    THEN GREATEST(
      0,
      ROUND(
        (-LN(2.0) / slope
         - 1.96 * LN(2.0) / (slope * slope)
           * sqrt(GREATEST(syy * (1.0 - r2) / ((sample_n - 2) * sxx), 0)))::numeric,
        2)
    )
    ELSE NULL
  END AS ci95_low,
  CASE
    WHEN slope < 0 AND sample_n > 2 AND sxx > 0 AND r2 IS NOT NULL AND r2 < 1
    THEN ROUND(
      (-LN(2.0) / slope
       + 1.96 * LN(2.0) / (slope * slope)
         * sqrt(GREATEST(syy * (1.0 - r2) / ((sample_n - 2) * sxx), 0)))::numeric,
      2)
    ELSE NULL
  END AS ci95_high,
  CASE
    WHEN COALESCE(r2, 0) < 0.4 OR sample_n < 4 THEN 'noise'
    WHEN slope >= 0 THEN 'noise'  -- 감쇠가 아니라 상승/평탄 → 적합 불가
    WHEN (-LN(2.0) / slope) < 7 THEN 'spike'
    WHEN (-LN(2.0) / slope) < 30 THEN 'mid'
    ELSE 'long'
  END AS decay_class
FROM fit;

COMMENT ON VIEW jimscanner_trends_halflife IS
  '키워드 반감기 τ½ (지수감쇠 log-linear 회귀). decay_class ∈ {noise,spike,mid,long}.';


-- 2) ggsan 평균 재입고 주기 (price_history 의 status 변경 주기)
--
-- 'sold_out' → 'active' 전환을 재입고 이벤트로 간주.
-- 동일 goods_no 의 재입고 이벤트 간 평균 일수 → restock_cadence_days
--
-- 시그널이 적은 초기엔 NULL 다수.
CREATE OR REPLACE VIEW jimscanner_ggsan_restock_cadence AS
WITH transitions AS (
  SELECT
    goods_no,
    observed_at,
    status,
    LAG(status) OVER (PARTITION BY goods_no ORDER BY observed_at) AS prev_status,
    LAG(observed_at) OVER (PARTITION BY goods_no ORDER BY observed_at) AS prev_at
  FROM jimscanner_ggsan_price_history
),
restocks AS (
  SELECT
    goods_no,
    observed_at,
    EXTRACT(EPOCH FROM (observed_at - prev_at)) / 86400.0 AS gap_days
  FROM transitions
  WHERE prev_status = 'sold_out'
    AND status = 'active'
    AND prev_at IS NOT NULL
)
SELECT
  goods_no,
  COUNT(*)::int AS restock_events,
  ROUND(AVG(gap_days)::numeric, 2) AS restock_cadence_days,
  MAX(observed_at) AS last_restock_at
FROM restocks
GROUP BY goods_no;

COMMENT ON VIEW jimscanner_ggsan_restock_cadence IS
  'ggsan goods_no 별 평균 재입고 주기 (sold_out→active 전환 간격).';


-- 3) RPC: 최근 N일 내 피크한 키워드의 반감기 + 카테고리·통계
--
-- 입력: days (피크 시점 윈도우, 기본 30)
-- 출력: keyword, category_top, peak_at, peak_volume, tau_half_days, ci95_low,
--       ci95_high, r2, decay_class, sample_n

CREATE OR REPLACE FUNCTION jimscanner_keyword_halflife_recent(days int DEFAULT 30)
RETURNS TABLE (
  keyword text,
  category_top text,
  peak_at timestamptz,
  peak_volume numeric,
  tau_half_days numeric,
  ci95_low numeric,
  ci95_high numeric,
  r2 numeric,
  decay_class text,
  sample_n int
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    h.keyword,
    h.category_top,
    h.peak_at,
    h.peak_volume,
    h.tau_half_days,
    h.ci95_low,
    h.ci95_high,
    h.r2,
    h.decay_class,
    h.sample_n
  FROM jimscanner_trends_halflife h
  WHERE h.peak_at >= now() - make_interval(days => days)
  ORDER BY
    CASE h.decay_class
      WHEN 'long' THEN 1
      WHEN 'mid' THEN 2
      WHEN 'spike' THEN 3
      ELSE 4
    END,
    h.r2 DESC NULLS LAST,
    h.peak_volume DESC
  LIMIT 500;
$$;

COMMENT ON FUNCTION jimscanner_keyword_halflife_recent IS
  '최근 N일 피크 키워드의 반감기 + 95% CI + 분류. 어드민 /trend-radar/half-life 사용.';
