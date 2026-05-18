-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 마진 확장 윈도우 보드 (2026-05-19)
-- ─────────────────────────────────────────────────────────────
-- 가설: 공급가가 7일 rolling min 기준 30일 median 대비 유의미하게
--       내려갔는데, 동기간 trend_score 는 유지(±5pt 이내) 혹은 상승.
--       → 위탁 마진이 일시적으로 벌어지는 "윈도우". 핀 후보.
--
-- 사전 집계용 view. 일 1회 cron 호출(/api/cron/refresh-margin-windows)
-- 에서 view 를 그대로 SELECT 해서 UI 캐시테이블에 넣어도 되고,
-- view 가 가벼우면 admin 페이지에서 직접 SELECT 해도 됨.
-- ─────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS jimscanner_margin_windows;

CREATE VIEW jimscanner_margin_windows AS
WITH
-- 1) 가격 시계열 — trends_supplier (product_id 기반) 와
--    ggsan_price_history (goods_no 기반 → trends_aliases 매핑) 를 UNION.
price_ts AS (
  SELECT
    s.product_id,
    s.supplier_source AS source,
    s.price_krw::numeric AS price_krw,
    s.collected_at AS observed_at
  FROM jimscanner_trends_supplier s
  WHERE s.price_krw IS NOT NULL
    AND s.collected_at >= now() - interval '60 days'

  UNION ALL

  -- ggsan price_history → trends_aliases (alias_type='ggsan_goods_no') 로
  -- product_id 매핑. alias 가 없으면 자연스럽게 제외됨.
  SELECT
    a.product_id,
    'ggsan' AS source,
    h.price_krw::numeric AS price_krw,
    h.observed_at
  FROM jimscanner_ggsan_price_history h
  JOIN jimscanner_trends_aliases a
    ON a.alias = h.goods_no
   AND a.alias_type = 'ggsan_goods_no'
  WHERE h.price_krw IS NOT NULL
    AND h.observed_at >= now() - interval '60 days'
),

-- 2) product_id 별 7d rolling min, 30d median
agg_price AS (
  SELECT
    product_id,
    MIN(price_krw) FILTER (WHERE observed_at >= now() - interval '7 days')  AS price_min_7d,
    MAX(price_krw) FILTER (WHERE observed_at >= now() - interval '7 days')  AS price_max_7d,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY price_krw)
      FILTER (WHERE observed_at >= now() - interval '30 days')              AS price_median_30d,
    MAX(price_krw) FILTER (WHERE observed_at <  now() - interval '7 days'
                            AND observed_at >= now() - interval '30 days')  AS price_prev_max,
    COUNT(*)        FILTER (WHERE observed_at >= now() - interval '30 days') AS n_obs_30d,
    array_agg(DISTINCT source)                                              AS sources
  FROM price_ts
  GROUP BY product_id
),

-- 3) trend_score 최근(7d) 평균 vs 이전(7~30d) 평균
latest_score AS (
  SELECT DISTINCT ON (product_id)
    product_id, trend_score, final_score, computed_at
  FROM jimscanner_trends_scores
  ORDER BY product_id, computed_at DESC
),
score_window AS (
  SELECT
    product_id,
    AVG(trend_score) FILTER (WHERE computed_at >= now() - interval '7 days')                              AS trend_recent_avg,
    AVG(trend_score) FILTER (WHERE computed_at <  now() - interval '7 days'
                              AND computed_at >= now() - interval '30 days')                              AS trend_prev_avg
  FROM jimscanner_trends_scores
  WHERE computed_at >= now() - interval '30 days'
  GROUP BY product_id
)

SELECT
  p.id            AS product_id,
  p.canonical_name,
  p.category_top,
  p.brand,
  ap.sources,
  ap.price_prev_max::int   AS price_prev_krw,
  ap.price_min_7d::int     AS price_curr_krw,
  ap.price_median_30d::int AS price_median_30d,
  -- 인하율(%): (median30 - min7) / median30 * 100. NULL 처리.
  CASE
    WHEN ap.price_median_30d IS NULL OR ap.price_median_30d = 0 THEN NULL
    ELSE ROUND(((ap.price_median_30d - ap.price_min_7d) / ap.price_median_30d * 100)::numeric, 2)
  END AS supply_drop_pct,
  -- 수요(트렌드) 변동 pt: 최근7d - 이전(7~30d)
  CASE
    WHEN sw.trend_prev_avg IS NULL THEN NULL
    ELSE ROUND((COALESCE(sw.trend_recent_avg, ls.trend_score) - sw.trend_prev_avg)::numeric, 2)
  END AS trend_delta_pt,
  ls.trend_score AS trend_score_latest,
  ls.final_score AS final_score_latest,
  -- 예상 마진 확대 ppt: 위탁 판매 마진이 도매가 비례라 가정 시,
  -- supply_drop_pct 의 약 50~70% 가 마진 ppt 증가로 환산 (보수치 60%).
  CASE
    WHEN ap.price_median_30d IS NULL OR ap.price_median_30d = 0 THEN NULL
    ELSE ROUND(((ap.price_median_30d - ap.price_min_7d) / ap.price_median_30d * 100 * 0.6)::numeric, 2)
  END AS expected_margin_expand_ppt,
  -- 창 종료 추정일: 가격이 다시 30d median 90% 이상으로 회복되는 시점 추정.
  -- v1 은 단순화: 마지막 관측일 + 7 days.
  (now() + interval '7 days')::date AS estimated_window_close,
  ap.n_obs_30d,
  -- 분류 플래그: 인하 5% 이상 + 트렌드 -5pt 이상 유지 시 윈도우 인정.
  CASE
    WHEN ap.price_median_30d IS NULL OR ap.price_median_30d = 0 THEN FALSE
    WHEN ((ap.price_median_30d - ap.price_min_7d) / ap.price_median_30d * 100) < 5 THEN FALSE
    WHEN COALESCE(sw.trend_recent_avg - sw.trend_prev_avg, 0) < -5 THEN FALSE
    ELSE TRUE
  END AS is_margin_window
FROM jimscanner_trends_products p
JOIN agg_price ap         ON ap.product_id = p.id
LEFT JOIN latest_score ls ON ls.product_id = p.id
LEFT JOIN score_window sw ON sw.product_id = p.id
WHERE ap.n_obs_30d >= 2
ORDER BY
  is_margin_window DESC,
  supply_drop_pct DESC NULLS LAST,
  ls.final_score DESC NULLS LAST;

COMMENT ON VIEW jimscanner_margin_windows IS
  '공급가(supplier+ggsan) 7d min vs 30d median 인하율 + trend_score ±5pt 유지 페어. ' ||
  'is_margin_window=true 만 UI 1차 노출. ' ||
  '관련 페이지: /admin/trend-radar/margin-window';
