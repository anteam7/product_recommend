-- ────────────────────────────────────────────────────────────
-- 도매가 변동성 게이트 RPC (PR-COST-STABILITY-1, 2026-06-02)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/cost-stability
-- 목적: jimscanner_ggsan_price_history 시계열을 처음으로 활용해
--       goods_no 별 N일 윈도우의 도매가 변동성(원가측 운영 리스크)을 집계.
--   - 위탁은 쿠팡 고정가 등록 후 도매가가 먼저 오르면 그대로 역마진.
--   - 고변동 상품 = 판매가 모니터링 필수 / 저변동 상품 = set&forget 적합.
-- 출력 지표:
--   - cv          : 변동계수(표준편차/평균) — 핵심 변동성 축
--   - change_count: 연속 관측 간 가격 변동 횟수
--   - max_spike_pct: 최대 급등폭(직전 대비 +%)
--   - soldout_count: 품절 전환 빈도
--   - spark       : 최근 가격 시계열(스파크라인용, 오래된→최신)
-- 수요축(recommend final_score)은 페이지에서 jimscanner_ggsan_recommend 와 병합.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_ggsan_cost_stability(
  days_window int DEFAULT 30,
  min_observations int DEFAULT 2,
  result_limit int DEFAULT 500
)
RETURNS TABLE (
  goods_no text,
  title text,
  cate_cd text,
  cate_label text,
  price_krw int,            -- 현재 카탈로그 가격
  is_imminent boolean,
  image_url text,
  detail_url text,
  -- 변동성 지표
  n_obs int,
  avg_price real,
  stddev_price real,
  cv real,                  -- 변동계수 = stddev / avg
  min_price int,
  max_price int,
  change_count int,         -- 연속 관측 간 가격 변동 횟수
  max_spike_pct real,       -- 최대 급등폭(직전 대비 +비율)
  soldout_count int,        -- 품절 전환 횟수
  first_obs timestamptz,
  last_obs timestamptz,
  spark int[]               -- 최근 가격 시계열(오래된→최신)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH hist AS (
    SELECT
      ph.goods_no,
      ph.price_krw,
      ph.status,
      ph.observed_at,
      LAG(ph.price_krw)  OVER w AS prev_price,
      LAG(ph.status)     OVER w AS prev_status
    FROM jimscanner_ggsan_price_history ph
    WHERE ph.observed_at > now() - (days_window || ' days')::interval
    WINDOW w AS (PARTITION BY ph.goods_no ORDER BY ph.observed_at)
  ),
  agg AS (
    SELECT
      goods_no,
      COUNT(*)::int                                              AS n_obs,
      AVG(price_krw)::real                                       AS avg_price,
      COALESCE(STDDEV_POP(price_krw), 0)::real                   AS stddev_price,
      MIN(price_krw)::int                                        AS min_price,
      MAX(price_krw)::int                                        AS max_price,
      COUNT(*) FILTER (
        WHERE prev_price IS NOT NULL AND prev_price <> price_krw
      )::int                                                     AS change_count,
      COALESCE(MAX(
        CASE
          WHEN prev_price IS NOT NULL AND prev_price > 0 AND price_krw > prev_price
          THEN (price_krw - prev_price)::real / prev_price
          ELSE 0
        END
      ), 0)::real                                                AS max_spike_pct,
      COUNT(*) FILTER (
        WHERE status = 'sold_out' AND prev_status IS DISTINCT FROM 'sold_out'
      )::int                                                     AS soldout_count,
      MIN(observed_at)                                           AS first_obs,
      MAX(observed_at)                                           AS last_obs
    FROM hist
    GROUP BY goods_no
  ),
  spark AS (
    SELECT goods_no, ARRAY_AGG(price_krw ORDER BY observed_at) AS spark
    FROM (
      SELECT
        goods_no, price_krw, observed_at,
        ROW_NUMBER() OVER (PARTITION BY goods_no ORDER BY observed_at DESC) AS rn
      FROM hist
      WHERE price_krw IS NOT NULL
    ) s
    WHERE rn <= 40
    GROUP BY goods_no
  )
  SELECT
    a.goods_no,
    gp.title, gp.cate_cd, gp.cate_label, gp.price_krw, gp.is_imminent,
    gp.image_url, gp.detail_url,
    a.n_obs, a.avg_price, a.stddev_price,
    (CASE WHEN a.avg_price > 0 THEN a.stddev_price / a.avg_price ELSE 0 END)::real AS cv,
    a.min_price, a.max_price, a.change_count, a.max_spike_pct, a.soldout_count,
    a.first_obs, a.last_obs,
    sp.spark
  FROM agg a
  JOIN jimscanner_ggsan_products gp ON gp.goods_no = a.goods_no
  LEFT JOIN spark sp ON sp.goods_no = a.goods_no
  WHERE a.n_obs >= min_observations
  ORDER BY cv DESC NULLS LAST
  LIMIT result_limit;
$$;
