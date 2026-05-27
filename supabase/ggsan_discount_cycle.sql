-- ────────────────────────────────────────────────────────────
-- ggsan 공급사 할인 사이클 학습 view (2026-05-27)
-- ────────────────────────────────────────────────────────────
-- jimscanner_ggsan_price_history 의 SKU별 가격 시계열에서
-- 반복되는 할인 이벤트를 탐지하고 다음 할인 저점을 예측한다.
--
-- 알고리즘 (pure SQL, 외부 패키지 없음):
--   1) base_price = 최근 120일 가격의 p85 (정상가 대용)
--   2) low 지점   = base_price 대비 3% 이상 낮은 관측치
--   3) 연속 low   = 36시간 이상 끊긴 low 군집을 별도 이벤트로 묶음
--   4) period     = 이벤트 시작 시각의 lag 평균 (일)
--   5) confidence = (샘플 수 / 6) * (1 - stddev/mean) 로 0~1 normalize
--   6) days_to_next = period - (now - last_low_at)
--
-- 적용:
--   psql "$PG_URL" -f supabase/ggsan_discount_cycle.sql
-- ────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS jimscanner_ggsan_discount_cycle CASCADE;

CREATE OR REPLACE VIEW jimscanner_ggsan_discount_cycle AS
WITH series AS (
  SELECT
    goods_no,
    price_krw,
    observed_at
  FROM jimscanner_ggsan_price_history
  WHERE observed_at > now() - interval '120 days'
    AND price_krw IS NOT NULL
    AND price_krw > 0
),
base AS (
  SELECT
    goods_no,
    percentile_cont(0.85) WITHIN GROUP (ORDER BY price_krw)::numeric AS base_price,
    count(*) AS sample_count
  FROM series
  GROUP BY goods_no
  HAVING count(*) >= 7
),
lows AS (
  SELECT
    s.goods_no,
    s.observed_at,
    s.price_krw,
    b.base_price,
    ((b.base_price - s.price_krw)::numeric / NULLIF(b.base_price, 0))::numeric AS depth
  FROM series s
  JOIN base b USING (goods_no)
  WHERE b.base_price > 0
    AND s.price_krw <= b.base_price * 0.97
),
events_ordered AS (
  SELECT
    goods_no,
    observed_at,
    depth,
    price_krw,
    base_price,
    LAG(observed_at) OVER (PARTITION BY goods_no ORDER BY observed_at) AS prev_low_at
  FROM lows
),
events_grouped AS (
  SELECT
    goods_no,
    observed_at,
    depth,
    price_krw,
    base_price,
    SUM(
      CASE
        WHEN prev_low_at IS NULL THEN 1
        WHEN observed_at - prev_low_at > interval '36 hours' THEN 1
        ELSE 0
      END
    ) OVER (PARTITION BY goods_no ORDER BY observed_at ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS event_id
  FROM events_ordered
),
events AS (
  SELECT
    goods_no,
    event_id,
    min(observed_at) AS event_start,
    max(depth) AS event_depth,
    min(price_krw) AS event_low_price,
    max(base_price) AS base_price
  FROM events_grouped
  GROUP BY goods_no, event_id
),
event_gaps AS (
  SELECT
    goods_no,
    event_start,
    event_depth,
    event_low_price,
    base_price,
    (extract(epoch FROM event_start - LAG(event_start) OVER (PARTITION BY goods_no ORDER BY event_start)) / 86400.0)::numeric AS gap_days
  FROM events
),
agg AS (
  SELECT
    goods_no,
    max(base_price) AS base_price,
    avg(event_depth) AS discount_depth_avg,
    avg(gap_days) AS period_days_raw,
    stddev_samp(gap_days) AS period_stddev,
    count(*) FILTER (WHERE gap_days IS NOT NULL) AS gap_samples,
    count(*) AS total_events,
    max(event_start) AS last_low_at,
    min(event_low_price) AS deepest_low_price
  FROM event_gaps
  GROUP BY goods_no
)
SELECT
  a.goods_no,
  p.title,
  p.cate_cd,
  p.cate_label,
  p.brand,
  p.image_url,
  p.detail_url,
  p.price_krw AS current_price,
  round(a.base_price)::integer AS base_price,
  round((a.discount_depth_avg * 100)::numeric, 1) AS discount_depth_avg,
  round(a.period_days_raw::numeric, 1) AS period_days,
  a.total_events::integer AS total_events,
  a.last_low_at,
  CASE
    WHEN a.period_days_raw IS NULL THEN NULL
    ELSE round(
      (a.period_days_raw - extract(epoch FROM now() - a.last_low_at) / 86400.0)::numeric
    )::integer
  END AS days_to_next_predicted_low,
  CASE
    WHEN a.gap_samples < 2 OR a.period_days_raw IS NULL THEN 0.0
    WHEN a.period_stddev IS NULL THEN 0.5
    ELSE GREATEST(0.0::numeric, LEAST(1.0::numeric,
      (LEAST(a.gap_samples::numeric, 6.0) / 6.0) *
      (1.0 - LEAST(1.0::numeric, a.period_stddev / NULLIF(a.period_days_raw, 0)))
    ))::numeric(4,2)
  END AS confidence,
  round(((a.base_price - p.price_krw)::numeric / NULLIF(a.base_price, 0) * 100)::numeric, 1) AS current_discount_pct
FROM agg a
JOIN jimscanner_ggsan_products p ON p.goods_no = a.goods_no
WHERE a.total_events >= 2;

COMMENT ON VIEW jimscanner_ggsan_discount_cycle IS
  '공급사 할인 사이클 학습 — 핀 발행/광고/매입 타이밍을 예측 저점에 정렬하기 위한 보드. 2026-05-27.';

GRANT SELECT ON jimscanner_ggsan_discount_cycle TO service_role;
