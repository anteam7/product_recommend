-- ────────────────────────────────────────────────────────────
-- ggsan 도매 재고 Burn-Rate Pre-Trend 분석 (2026-05-27)
-- ────────────────────────────────────────────────────────────
-- ggsan-stock-snapshot cron 이 매일 jimscanner_ggsan_products 의 active SKU 별
-- stock 상태를 캡처한 row 를 jimscanner_ggsan_stock_history 에 적재한다.
-- stock_qty 는 ggsan 이 실제 정수 재고를 노출하지 않으므로 boolean→정수 매핑:
--   in_stock  = 1
--   sold_out  = 0
--   unknown   = NULL (분석 제외)
-- 추후 ggsan 이 실수량을 노출하면 그대로 그 정수를 채워도 RPC 가 그대로 동작.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_ggsan_stock_history (
  id bigserial PRIMARY KEY,
  goods_no text NOT NULL REFERENCES jimscanner_ggsan_products(goods_no) ON DELETE CASCADE,
  stock_qty integer,             -- NULL = unknown
  stock_status text,             -- 'in_stock' | 'sold_out' | 'unknown'
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  snapshot_date date GENERATED ALWAYS AS ((snapshot_at AT TIME ZONE 'Asia/Seoul')::date) STORED
);

CREATE INDEX IF NOT EXISTS jimscanner_ggsan_stock_history_goods_at
  ON jimscanner_ggsan_stock_history(goods_no, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_ggsan_stock_history_date
  ON jimscanner_ggsan_stock_history(snapshot_date DESC);
-- 같은 SKU 같은 날짜 중복 방지 (idempotent snapshot)
CREATE UNIQUE INDEX IF NOT EXISTS jimscanner_ggsan_stock_history_uniq_day
  ON jimscanner_ggsan_stock_history(goods_no, snapshot_date);

ALTER TABLE jimscanner_ggsan_stock_history ENABLE ROW LEVEL SECURITY;
-- service-role 만 사용.


-- ────────────────────────────────────────────────────────────
-- RPC: SKU 별 burn_rate / 7d MA / DoS / 90d z-score 계산
-- ────────────────────────────────────────────────────────────
--   burn_rate(day d)  = (qty(d-1) - qty(d)) / NULLIF(qty(d-1), 0)
--     음수 → 재입고, 0 → 변동 없음, 양수 → 소진
--     boolean(0/1) 매핑에서는 1→0 일 때 burn_rate = 1.0 (= 완전 소진)
--   burn_ma7          = 최근 7 일 burn_rate 평균
--   dos_days          = qty(today) / NULLIF(burn_qty_avg_7d, 0)
--                       (잔여 재고 ÷ 일평균 소진수량). qty가 binary 면 의미는
--                       "다음 sold-out 까지 평균 며칠" 의 근사.
--   z90               = (burn_today - μ90) / σ90  ── 같은 SKU 90일 burn 분포 대비
-- 큐 분류 ───────────────────────────────────────────────────
--   bucket = 'hot'      : 발행 안 됨 + z90 > 2  → 즉시 발행
--   bucket = 'resupply' : 발행 중 + z90 > 2     → 선매입 알람
--   bucket = 'dead'     : 최근 7d burn_ma7 <= 0 + 90d 변동 거의 없음 → 손절
--   bucket = 'normal'   : 나머지
-- ────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS jimscanner_ggsan_stock_burn(integer, double precision);

CREATE OR REPLACE FUNCTION jimscanner_ggsan_stock_burn(
  days_window integer DEFAULT 90,
  z_threshold double precision DEFAULT 2.0
)
RETURNS TABLE (
  goods_no text,
  title text,
  cate_label text,
  price_krw integer,
  image_url text,
  detail_url text,
  is_imminent boolean,
  is_published boolean,
  stock_today integer,
  stock_yesterday integer,
  burn_today double precision,
  burn_ma7 double precision,
  burn_mean90 double precision,
  burn_std90 double precision,
  z90 double precision,
  dos_days double precision,
  snapshot_count integer,
  last_snapshot_at timestamptz,
  bucket text
)
LANGUAGE sql
STABLE
AS $$
WITH base AS (
  SELECT
    h.goods_no,
    h.snapshot_date,
    -- 같은 날 여러 snapshot 이 들어오면 마지막 값만 사용
    (array_agg(h.stock_qty ORDER BY h.snapshot_at DESC))[1] AS qty,
    max(h.snapshot_at) AS snapshot_at
  FROM jimscanner_ggsan_stock_history h
  WHERE h.snapshot_at >= now() - (days_window || ' days')::interval
    AND h.stock_qty IS NOT NULL
  GROUP BY h.goods_no, h.snapshot_date
),
with_lag AS (
  SELECT
    b.goods_no,
    b.snapshot_date,
    b.snapshot_at,
    b.qty,
    LAG(b.qty) OVER (PARTITION BY b.goods_no ORDER BY b.snapshot_date) AS qty_prev
  FROM base b
),
burn AS (
  SELECT
    w.goods_no,
    w.snapshot_date,
    w.snapshot_at,
    w.qty,
    w.qty_prev,
    CASE
      WHEN w.qty_prev IS NULL OR w.qty_prev = 0 THEN NULL
      ELSE (w.qty_prev::double precision - w.qty::double precision) / NULLIF(w.qty_prev::double precision, 0)
    END AS burn_rate,
    -- 일평균 소진수량 (DoS 계산용) — 음수는 0 으로 clamp
    GREATEST(0, COALESCE(w.qty_prev, 0) - COALESCE(w.qty, 0))::double precision AS burn_qty
  FROM with_lag w
),
agg AS (
  SELECT
    goods_no,
    count(*) FILTER (WHERE burn_rate IS NOT NULL) AS snapshot_count,
    max(snapshot_at) AS last_snapshot_at,
    avg(burn_rate) FILTER (WHERE burn_rate IS NOT NULL) AS burn_mean90,
    stddev_samp(burn_rate) FILTER (WHERE burn_rate IS NOT NULL) AS burn_std90,
    avg(burn_qty) FILTER (
      WHERE snapshot_date >= (now() AT TIME ZONE 'Asia/Seoul')::date - 6
    ) AS burn_qty_avg_7d,
    avg(burn_rate) FILTER (
      WHERE burn_rate IS NOT NULL
        AND snapshot_date >= (now() AT TIME ZONE 'Asia/Seoul')::date - 6
    ) AS burn_ma7
  FROM burn
  GROUP BY goods_no
),
today_row AS (
  SELECT DISTINCT ON (goods_no)
    goods_no,
    qty AS qty_today,
    qty_prev AS qty_yesterday,
    burn_rate AS burn_today
  FROM burn
  ORDER BY goods_no, snapshot_date DESC
),
published AS (
  -- jimscanner_coupang_listings 가 같은 source_goods_no 로 매핑된 SKU 만 "발행"
  SELECT DISTINCT source_goods_no AS goods_no
  FROM jimscanner_coupang_listings
  WHERE source_goods_no IS NOT NULL
)
SELECT
  p.goods_no,
  p.title,
  p.cate_label,
  p.price_krw,
  p.image_url,
  p.detail_url,
  p.is_imminent,
  (pub.goods_no IS NOT NULL) AS is_published,
  t.qty_today AS stock_today,
  t.qty_yesterday AS stock_yesterday,
  t.burn_today,
  a.burn_ma7,
  a.burn_mean90,
  a.burn_std90,
  CASE
    WHEN a.burn_std90 IS NULL OR a.burn_std90 = 0 THEN NULL
    ELSE (t.burn_today - a.burn_mean90) / a.burn_std90
  END AS z90,
  CASE
    WHEN a.burn_qty_avg_7d IS NULL OR a.burn_qty_avg_7d = 0 THEN NULL
    ELSE t.qty_today::double precision / a.burn_qty_avg_7d
  END AS dos_days,
  COALESCE(a.snapshot_count, 0)::integer AS snapshot_count,
  a.last_snapshot_at,
  CASE
    WHEN a.burn_std90 IS NOT NULL AND a.burn_std90 > 0
         AND ((t.burn_today - a.burn_mean90) / a.burn_std90) > z_threshold
         AND pub.goods_no IS NULL
      THEN 'hot'
    WHEN a.burn_std90 IS NOT NULL AND a.burn_std90 > 0
         AND ((t.burn_today - a.burn_mean90) / a.burn_std90) > z_threshold
         AND pub.goods_no IS NOT NULL
      THEN 'resupply'
    WHEN COALESCE(a.burn_ma7, 0) <= 0
         AND COALESCE(a.snapshot_count, 0) >= 14
         AND COALESCE(a.burn_mean90, 0) <= 0.001
      THEN 'dead'
    ELSE 'normal'
  END AS bucket
FROM jimscanner_ggsan_products p
JOIN agg a ON a.goods_no = p.goods_no
JOIN today_row t ON t.goods_no = p.goods_no
LEFT JOIN published pub ON pub.goods_no = p.goods_no
WHERE p.status = 'active'
ORDER BY
  CASE WHEN a.burn_std90 IS NOT NULL AND a.burn_std90 > 0
       THEN (t.burn_today - a.burn_mean90) / a.burn_std90 ELSE 0 END DESC NULLS LAST
$$;

GRANT EXECUTE ON FUNCTION jimscanner_ggsan_stock_burn(integer, double precision) TO anon, authenticated, service_role;
