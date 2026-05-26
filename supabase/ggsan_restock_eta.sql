-- ────────────────────────────────────────────────────────────
-- ggsan 품절→재입고 D-day 예측 (Restock ETA Predictor, 2026-05-26)
-- ────────────────────────────────────────────────────────────
-- jimscanner_ggsan_price_history 의 status 시퀀스(active→sold_out→active)에서
-- SKU별 sold_out spell 길이 분포를 학습해, 현재 품절 SKU의 다음 재입고 ETA를
-- 카테고리 평균 lag 베이지안 shrinkage 와 함께 예측한다.
--
-- 구성:
--   1) jimscanner_ggsan_restock_eta(goods_no)         — 단일 SKU 통계
--   2) jimscanner_ggsan_restock_eta_list(...)         — 현재 sold_out SKU 전체 리스트
--   3) jimscanner_ggsan_restock_watch                 — D-3 자동 핀 큐 (cron 푸시)
--
-- 사용:
--   - 어드민 페이지: /admin/trend-radar/ggsan/restock-eta
--   - cron: scripts/predict-restock-eta.mjs (D-3 SKU watch 큐 푸시)
-- ────────────────────────────────────────────────────────────

-- 1) 단일 SKU ETA RPC
CREATE OR REPLACE FUNCTION jimscanner_ggsan_restock_eta(
  p_goods_no text,
  prior_weight float DEFAULT 3.0
)
RETURNS TABLE (
  goods_no text,
  sample_size int,
  sku_median_days real,
  sku_iqr_low real,
  sku_iqr_high real,
  cate_median_days real,
  shrunk_median_days real,
  current_sold_out_start timestamptz,
  predicted_restock_at timestamptz,
  predicted_low timestamptz,
  predicted_high timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH events AS (
    SELECT
      goods_no,
      status,
      observed_at,
      LAG(status) OVER (PARTITION BY goods_no ORDER BY observed_at) AS prev_status
    FROM jimscanner_ggsan_price_history
    WHERE goods_no = p_goods_no
  ),
  transitions AS (
    SELECT * FROM events WHERE status IS DISTINCT FROM prev_status
  ),
  spells AS (
    SELECT
      goods_no,
      observed_at AS spell_start,
      LEAD(observed_at) OVER (PARTITION BY goods_no ORDER BY observed_at) AS spell_end
    FROM transitions
    WHERE status = 'sold_out'
  ),
  complete_spells AS (
    SELECT
      EXTRACT(EPOCH FROM (spell_end - spell_start)) / 86400.0 AS spell_days
    FROM spells
    WHERE spell_end IS NOT NULL
      AND EXTRACT(EPOCH FROM (spell_end - spell_start)) / 86400.0 BETWEEN 0.005 AND 180
  ),
  sku_stats AS (
    SELECT
      COUNT(*)::int AS sample_size,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY spell_days)::real AS median_days,
      PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY spell_days)::real AS p25_days,
      PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY spell_days)::real AS p75_days
    FROM complete_spells
  ),
  -- 카테고리 평균 (해당 SKU의 cate_cd 와 동일 카테고리의 모든 SKU spell)
  cate_events AS (
    SELECT
      ph.goods_no,
      ph.status,
      ph.observed_at,
      LAG(ph.status) OVER (PARTITION BY ph.goods_no ORDER BY ph.observed_at) AS prev_status
    FROM jimscanner_ggsan_price_history ph
    JOIN jimscanner_ggsan_products gp ON gp.goods_no = ph.goods_no
    WHERE gp.cate_cd = (SELECT cate_cd FROM jimscanner_ggsan_products WHERE goods_no = p_goods_no)
  ),
  cate_transitions AS (
    SELECT goods_no, status, observed_at
    FROM cate_events
    WHERE status IS DISTINCT FROM prev_status
  ),
  cate_spells AS (
    SELECT
      EXTRACT(EPOCH FROM (
        LEAD(observed_at) OVER (PARTITION BY goods_no ORDER BY observed_at) - observed_at
      )) / 86400.0 AS spell_days,
      status
    FROM cate_transitions
  ),
  cate_stats AS (
    SELECT
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY spell_days)::real AS cate_median_days
    FROM cate_spells
    WHERE status = 'sold_out'
      AND spell_days IS NOT NULL
      AND spell_days BETWEEN 0.005 AND 180
  ),
  current_state AS (
    SELECT
      observed_at AS spell_start,
      status
    FROM transitions
    ORDER BY observed_at DESC
    LIMIT 1
  )
  SELECT
    p_goods_no AS goods_no,
    COALESCE(ss.sample_size, 0) AS sample_size,
    ss.median_days AS sku_median_days,
    ss.p25_days AS sku_iqr_low,
    ss.p75_days AS sku_iqr_high,
    cs.cate_median_days,
    -- Bayesian shrinkage
    CASE
      WHEN COALESCE(ss.sample_size, 0) = 0 THEN COALESCE(cs.cate_median_days, 7.0)
      ELSE (
        (ss.sample_size * ss.median_days + prior_weight * COALESCE(cs.cate_median_days, ss.median_days))
        / (ss.sample_size + prior_weight)
      )::real
    END AS shrunk_median_days,
    cur.spell_start AS current_sold_out_start,
    CASE
      WHEN cur.status = 'sold_out' THEN
        cur.spell_start + (
          CASE
            WHEN COALESCE(ss.sample_size, 0) = 0 THEN COALESCE(cs.cate_median_days, 7.0)
            ELSE (
              (ss.sample_size * ss.median_days + prior_weight * COALESCE(cs.cate_median_days, ss.median_days))
              / (ss.sample_size + prior_weight)
            )
          END * INTERVAL '1 day'
        )
      ELSE NULL
    END AS predicted_restock_at,
    CASE WHEN cur.status = 'sold_out' THEN
      cur.spell_start + (COALESCE(ss.p25_days, COALESCE(cs.cate_median_days, 7.0) * 0.6) * INTERVAL '1 day')
    ELSE NULL END AS predicted_low,
    CASE WHEN cur.status = 'sold_out' THEN
      cur.spell_start + (COALESCE(ss.p75_days, COALESCE(cs.cate_median_days, 7.0) * 1.5) * INTERVAL '1 day')
    ELSE NULL END AS predicted_high
  FROM (SELECT 1) dummy
  LEFT JOIN sku_stats ss ON true
  LEFT JOIN cate_stats cs ON true
  LEFT JOIN current_state cur ON true;
$$;

REVOKE ALL ON FUNCTION jimscanner_ggsan_restock_eta(text, float) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_ggsan_restock_eta(text, float) TO service_role;


-- 2) 현재 품절 SKU 전체 ETA 리스트 RPC (페이지·cron 둘 다 호출)
CREATE OR REPLACE FUNCTION jimscanner_ggsan_restock_eta_list(
  prior_weight float DEFAULT 3.0,
  result_limit int DEFAULT 500
)
RETURNS TABLE (
  goods_no text,
  title text,
  cate_cd text,
  cate_label text,
  price_krw int,
  image_url text,
  detail_url text,
  current_sold_out_start timestamptz,
  days_sold_out real,
  sample_size int,
  sku_median_days real,
  sku_iqr_low real,
  sku_iqr_high real,
  cate_median_days real,
  shrunk_median_days real,
  predicted_restock_at timestamptz,
  predicted_low timestamptz,
  predicted_high timestamptz,
  days_until_restock real,
  is_watched boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH events AS (
    SELECT
      goods_no,
      status,
      observed_at,
      LAG(status) OVER (PARTITION BY goods_no ORDER BY observed_at) AS prev_status
    FROM jimscanner_ggsan_price_history
  ),
  transitions AS (
    SELECT goods_no, status, observed_at
    FROM events
    WHERE status IS DISTINCT FROM prev_status
  ),
  spells AS (
    SELECT
      goods_no,
      observed_at AS spell_start,
      LEAD(observed_at) OVER (PARTITION BY goods_no ORDER BY observed_at) AS spell_end
    FROM transitions
    WHERE status = 'sold_out'
  ),
  complete_spells AS (
    SELECT
      goods_no,
      EXTRACT(EPOCH FROM (spell_end - spell_start)) / 86400.0 AS spell_days
    FROM spells
    WHERE spell_end IS NOT NULL
      AND EXTRACT(EPOCH FROM (spell_end - spell_start)) / 86400.0 BETWEEN 0.005 AND 180
  ),
  sku_stats AS (
    SELECT
      goods_no,
      COUNT(*)::int AS sample_size,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY spell_days)::real AS median_days,
      PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY spell_days)::real AS p25_days,
      PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY spell_days)::real AS p75_days
    FROM complete_spells
    GROUP BY goods_no
  ),
  cate_stats AS (
    SELECT
      gp.cate_cd,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cs.spell_days)::real AS cate_median_days
    FROM complete_spells cs
    JOIN jimscanner_ggsan_products gp ON gp.goods_no = cs.goods_no
    WHERE gp.cate_cd IS NOT NULL
    GROUP BY gp.cate_cd
  ),
  global_median AS (
    SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY spell_days)::real AS global_median_days
    FROM complete_spells
  ),
  -- 각 SKU 의 가장 최근 transition 행 — 현재 sold_out 상태로 들어선 시점
  latest_transition AS (
    SELECT DISTINCT ON (goods_no)
      goods_no,
      observed_at AS spell_start,
      status
    FROM transitions
    ORDER BY goods_no, observed_at DESC
  ),
  currently_sold_out AS (
    SELECT lt.goods_no, lt.spell_start
    FROM latest_transition lt
    WHERE lt.status = 'sold_out'
  ),
  -- 통합 effective median (shrinkage 적용)
  effective AS (
    SELECT
      cso.goods_no,
      cso.spell_start,
      COALESCE(ss.sample_size, 0) AS sample_size,
      ss.median_days AS sku_median_days,
      ss.p25_days AS sku_iqr_low,
      ss.p75_days AS sku_iqr_high,
      COALESCE(cs.cate_median_days, gm.global_median_days, 7.0) AS cate_or_global_median,
      CASE
        WHEN COALESCE(ss.sample_size, 0) = 0
          THEN COALESCE(cs.cate_median_days, gm.global_median_days, 7.0)
        ELSE (
          (ss.sample_size * ss.median_days
            + prior_weight * COALESCE(cs.cate_median_days, gm.global_median_days, ss.median_days))
          / (ss.sample_size + prior_weight)
        )::real
      END AS shrunk_median_days
    FROM currently_sold_out cso
    LEFT JOIN sku_stats ss ON ss.goods_no = cso.goods_no
    LEFT JOIN jimscanner_ggsan_products gp ON gp.goods_no = cso.goods_no
    LEFT JOIN cate_stats cs ON cs.cate_cd = gp.cate_cd
    CROSS JOIN global_median gm
  )
  SELECT
    gp.goods_no,
    gp.title,
    gp.cate_cd,
    gp.cate_label,
    gp.price_krw,
    gp.image_url,
    gp.detail_url,
    e.spell_start AS current_sold_out_start,
    GREATEST(0, EXTRACT(EPOCH FROM (now() - e.spell_start)) / 86400.0)::real AS days_sold_out,
    e.sample_size,
    e.sku_median_days,
    e.sku_iqr_low,
    e.sku_iqr_high,
    e.cate_or_global_median AS cate_median_days,
    e.shrunk_median_days,
    (e.spell_start + (e.shrunk_median_days * INTERVAL '1 day')) AS predicted_restock_at,
    (e.spell_start + (COALESCE(e.sku_iqr_low, e.cate_or_global_median * 0.6) * INTERVAL '1 day')) AS predicted_low,
    (e.spell_start + (COALESCE(e.sku_iqr_high, e.cate_or_global_median * 1.5) * INTERVAL '1 day')) AS predicted_high,
    (EXTRACT(EPOCH FROM (
      (e.spell_start + (e.shrunk_median_days * INTERVAL '1 day')) - now()
    )) / 86400.0)::real AS days_until_restock,
    EXISTS (
      SELECT 1
      FROM jimscanner_ggsan_restock_watch w
      WHERE w.goods_no = gp.goods_no
        AND w.status IN ('watching', 'registered')
    ) AS is_watched
  FROM effective e
  JOIN jimscanner_ggsan_products gp ON gp.goods_no = e.goods_no
  ORDER BY (
    EXTRACT(EPOCH FROM (
      (e.spell_start + (e.shrunk_median_days * INTERVAL '1 day')) - now()
    )) / 86400.0
  ) ASC NULLS LAST
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_ggsan_restock_eta_list(float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_ggsan_restock_eta_list(float, int) TO service_role;


-- 3) D-3 자동 핀 큐 (재입고 즉시 쿠팡 자동등록 파이프라인이 선점하도록)
CREATE TABLE IF NOT EXISTS jimscanner_ggsan_restock_watch (
  goods_no text PRIMARY KEY REFERENCES jimscanner_ggsan_products(goods_no) ON DELETE CASCADE,
  predicted_restock_at timestamptz NOT NULL,
  shrunk_median_days real,
  sample_size int,
  queued_by text DEFAULT 'predict-restock-eta',
  queued_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'watching',  -- 'watching' | 'registered' | 'cancelled' | 'expired'
  ack_at timestamptz,
  registered_at timestamptz,
  notes text
);

CREATE INDEX IF NOT EXISTS jimscanner_ggsan_restock_watch_status
  ON jimscanner_ggsan_restock_watch(status, predicted_restock_at);

ALTER TABLE jimscanner_ggsan_restock_watch ENABLE ROW LEVEL SECURITY;
