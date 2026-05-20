-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — SERP Stockout Pressure Index (2026-05-20)
-- ─────────────────────────────────────────────────────────────
-- 네이버 쇼핑 SERP 를 키워드 단위로 스냅샷.
-- 카드 중 '품절/일시품절/예약판매/재입고알림' 비율을 OOS-Pressure 로 계량화.
-- 다른 신호 (HHI, BE-CPC, 재입고) 와 직교한 '공급 부족' 진입 신호.
--
-- 어드민 service-role 만 접근 (RLS enable + policy 없음).
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_serp_stockout_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- canonical product 와 매핑(있을 때) — 없으면 키워드만 가지고 추적.
  product_id uuid REFERENCES jimscanner_trends_products(id) ON DELETE SET NULL,
  keyword text NOT NULL,

  -- 측정값
  total_cards int NOT NULL CHECK (total_cards >= 0),
  oos_count int NOT NULL DEFAULT 0 CHECK (oos_count >= 0),       -- 품절·일시품절
  presale_count int NOT NULL DEFAULT 0 CHECK (presale_count >= 0),
  restock_alert_count int NOT NULL DEFAULT 0 CHECK (restock_alert_count >= 0),

  -- raw payload (디버깅 + 향후 재계산)
  -- 예: {"sample_titles": [...], "fetch_url": "..."}
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_serp_stockout_keyword_at
  ON jimscanner_serp_stockout_snapshots(keyword, captured_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_serp_stockout_product_at
  ON jimscanner_serp_stockout_snapshots(product_id, captured_at DESC)
  WHERE product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS jimscanner_serp_stockout_captured_at
  ON jimscanner_serp_stockout_snapshots(captured_at DESC);

ALTER TABLE jimscanner_serp_stockout_snapshots ENABLE ROW LEVEL SECURITY;
-- service-role only.


-- ─────────────────────────────────────────────────────────────
-- RPC: jimscanner_stockout_pressure_trend(days_window)
-- 키워드별 일자 단위 OOS pressure 시계열 + 추세 플래그.
--
-- pressure_index = (oos_count + presale_count + restock_alert_count) / NULLIF(total_cards, 0)
-- 7일 평균 vs 직전 7일 평균을 비교해 trending_up 플래그.
--
-- 반환: (keyword, day, total_cards, oos, presale, restock, pressure,
--        days_observed, avg_pressure_recent, avg_pressure_prior, trending_up,
--        peak_pressure, latest_captured_at)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_stockout_pressure_trend(days_window int DEFAULT 14)
RETURNS TABLE (
  keyword text,
  day date,
  total_cards int,
  oos int,
  presale int,
  restock int,
  pressure numeric,
  days_observed int,
  avg_pressure_recent numeric,
  avg_pressure_prior numeric,
  trending_up boolean,
  peak_pressure numeric,
  latest_captured_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  WITH bounds AS (
    SELECT
      GREATEST(days_window, 1) AS window_days,
      (now() AT TIME ZONE 'Asia/Seoul')::date AS today_kst
  ),
  daily AS (
    -- 같은 키워드/같은 일자에 여러 스냅샷이 있으면 합산
    SELECT
      s.keyword,
      ((s.captured_at AT TIME ZONE 'Asia/Seoul')::date) AS day,
      SUM(s.total_cards)::int AS total_cards,
      SUM(s.oos_count)::int AS oos,
      SUM(s.presale_count)::int AS presale,
      SUM(s.restock_alert_count)::int AS restock,
      MAX(s.captured_at) AS latest_captured_at
    FROM jimscanner_serp_stockout_snapshots s, bounds b
    WHERE s.captured_at >= (now() - (b.window_days * 2 || ' days')::interval)
    GROUP BY 1, 2
  ),
  daily_pressure AS (
    SELECT
      d.*,
      CASE
        WHEN d.total_cards > 0 THEN
          ROUND((d.oos + d.presale + d.restock)::numeric / d.total_cards, 4)
        ELSE 0
      END AS pressure
    FROM daily d
  ),
  windowed AS (
    SELECT
      dp.*,
      (SELECT window_days FROM bounds) AS window_days,
      (SELECT today_kst FROM bounds) AS today_kst
    FROM daily_pressure dp
  ),
  agg AS (
    SELECT
      w.keyword,
      COUNT(*) FILTER (WHERE w.day > w.today_kst - w.window_days)::int AS days_observed,
      AVG(w.pressure) FILTER (WHERE w.day > w.today_kst - w.window_days) AS avg_pressure_recent,
      AVG(w.pressure) FILTER (
        WHERE w.day <= w.today_kst - w.window_days
          AND w.day > w.today_kst - (w.window_days * 2)
      ) AS avg_pressure_prior,
      MAX(w.pressure) AS peak_pressure,
      MAX(w.latest_captured_at) AS latest_captured_at
    FROM windowed w
    GROUP BY w.keyword
  )
  SELECT
    w.keyword,
    w.day,
    w.total_cards,
    w.oos,
    w.presale,
    w.restock,
    w.pressure,
    a.days_observed,
    ROUND(COALESCE(a.avg_pressure_recent, 0), 4) AS avg_pressure_recent,
    ROUND(COALESCE(a.avg_pressure_prior, 0), 4) AS avg_pressure_prior,
    (COALESCE(a.avg_pressure_recent, 0) >= 0.4
      AND COALESCE(a.avg_pressure_recent, 0) >
          COALESCE(a.avg_pressure_prior, 0) * 1.15) AS trending_up,
    ROUND(COALESCE(a.peak_pressure, 0), 4) AS peak_pressure,
    a.latest_captured_at
  FROM windowed w
  JOIN agg a ON a.keyword = w.keyword
  WHERE w.day > w.today_kst - (w.window_days * 2)
  ORDER BY a.avg_pressure_recent DESC NULLS LAST, w.keyword, w.day DESC;
$$;
