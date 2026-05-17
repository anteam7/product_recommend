-- ─────────────────────────────────────────────────────────────
-- 공급사 SKU 신뢰성 점수 (PR-RELIABILITY-1, 2026-05-17)
-- ─────────────────────────────────────────────────────────────
-- 목적: ggsan 도매 SKU 별 시계열 운영 안정성을 0-100점으로 산출.
--   - jimscanner_ggsan_products.{first_seen_at,last_seen_at,last_changed_at,status,is_imminent}
--   - jimscanner_ggsan_price_history.{price_krw,status,observed_at}
-- 신호:
--   - 가격 변동계수 (price CV) → 가격 안정
--   - sold_out/imminent 전환 빈도, is_imminent 출현률 → 재고 안정
--   - active 유지일수, last_seen 신선도, removed 여부 → 운영 안정
--   - price_history 행 수, 관측 기간 → 이력 두께(신뢰도 보정)
-- 사용처:
--   - /admin/trend-radar/ggsan 페이지: 신뢰성 컬럼/정렬/필터
--   - /admin/trend-radar/products/[id]: 게이지 + sparkline 오버레이 (매칭 시)
--   - 핀 진입 후보 카드: 신뢰성 < 40 경고 배지
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_ggsan_supplier_reliability(
  lookback_days int DEFAULT 30,
  min_history   int DEFAULT 2
)
RETURNS TABLE (
  goods_no               text,
  title                  text,
  cate_cd                text,
  cate_label             text,
  price_krw              int,
  is_imminent            boolean,
  status                 text,
  -- 0-100 종합 점수
  reliability_score      int,
  -- 0-100 하위 4축
  price_stability        int,
  stock_stability        int,
  ops_stability          int,
  history_thickness      int,
  -- 진단 지표 (디버깅·툴팁용)
  history_rows           int,
  distinct_prices        int,
  price_cv               numeric,
  price_min              int,
  price_max              int,
  stockout_events        int,
  imminent_events        int,
  active_days            numeric,
  last_seen_age_hours    numeric,
  change_events_30d      int,
  last_observed_at       timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  prods AS (
    SELECT
      p.goods_no, p.title, p.cate_cd, p.cate_label, p.price_krw,
      p.is_imminent, p.status,
      p.first_seen_at, p.last_seen_at, p.last_changed_at
    FROM jimscanner_ggsan_products p
  ),
  hist AS (
    SELECT
      h.goods_no,
      h.price_krw,
      h.status,
      h.observed_at,
      LAG(h.status) OVER (PARTITION BY h.goods_no ORDER BY h.observed_at) AS prev_status
    FROM jimscanner_ggsan_price_history h
    WHERE h.observed_at >= now() - make_interval(days => lookback_days)
  ),
  agg AS (
    SELECT
      h.goods_no,
      COUNT(*)::int                                                AS history_rows,
      COUNT(DISTINCT h.price_krw)::int                             AS distinct_prices,
      AVG(h.price_krw)::numeric                                    AS price_avg,
      STDDEV_POP(h.price_krw)::numeric                             AS price_stddev,
      MIN(h.price_krw)::int                                        AS price_min,
      MAX(h.price_krw)::int                                        AS price_max,
      MAX(h.observed_at)                                           AS last_observed_at,
      COUNT(*) FILTER (
        WHERE h.status IN ('sold_out','imminent')
        AND COALESCE(h.prev_status,'') NOT IN ('sold_out','imminent')
      )::int                                                       AS stockout_events,
      COUNT(*) FILTER (WHERE h.status = 'imminent')::int           AS imminent_events
    FROM hist h
    GROUP BY h.goods_no
  )
  SELECT
    p.goods_no,
    p.title,
    p.cate_cd,
    p.cate_label,
    p.price_krw,
    p.is_imminent,
    p.status,
    -- ── 점수 산출 ────────────────────────────────────────────
    -- reliability_score = 가중 평균 (price 30% / stock 30% / ops 25% / thickness 15%)
    LEAST(100, GREATEST(0, ROUND(
      0.30 * (CASE
                WHEN a.price_avg IS NULL OR a.price_avg = 0 THEN 60
                WHEN a.history_rows < min_history THEN 60
                ELSE GREATEST(0, 100 - LEAST(100, (a.price_stddev / a.price_avg) * 400))
              END)
    + 0.30 * (CASE
                WHEN a.history_rows < min_history THEN 60
                ELSE GREATEST(0, 100
                       - LEAST(60, COALESCE(a.stockout_events,0) * 20)
                       - LEAST(40, (COALESCE(a.imminent_events,0)::numeric / NULLIF(a.history_rows,0)) * 100))
              END)
    + 0.25 * (CASE
                WHEN p.status = 'removed' THEN 0
                WHEN p.status = 'sold_out' THEN 30
                ELSE GREATEST(0, 100
                       - LEAST(50, EXTRACT(EPOCH FROM (now() - p.last_seen_at))/3600 / 6)
                       + LEAST(20, EXTRACT(EPOCH FROM (now() - p.first_seen_at))/86400 / 3))
              END)
    + 0.15 * LEAST(100, COALESCE(a.history_rows,0) * 6
                       + (CASE WHEN COALESCE(a.history_rows,0) >= min_history THEN 20 ELSE 0 END))
    )))::int                                                       AS reliability_score,

    -- price_stability: CV 기반 (0% = 100점, 25%↑ = 0점)
    LEAST(100, GREATEST(0, ROUND(
      CASE
        WHEN a.price_avg IS NULL OR a.price_avg = 0 THEN 60
        WHEN a.history_rows < min_history THEN 60
        ELSE 100 - LEAST(100, (a.price_stddev / a.price_avg) * 400)
      END
    )))::int                                                       AS price_stability,

    -- stock_stability: stockout 횟수 + imminent 비율
    LEAST(100, GREATEST(0, ROUND(
      CASE
        WHEN a.history_rows < min_history THEN 60
        ELSE 100
             - LEAST(60, COALESCE(a.stockout_events,0) * 20)
             - LEAST(40, (COALESCE(a.imminent_events,0)::numeric / NULLIF(a.history_rows,0)) * 100)
      END
    )))::int                                                       AS stock_stability,

    -- ops_stability: removed/sold_out 페널티 + last_seen 신선도 + 누적 active 보너스
    LEAST(100, GREATEST(0, ROUND(
      CASE
        WHEN p.status = 'removed' THEN 0
        WHEN p.status = 'sold_out' THEN 30
        ELSE 100
             - LEAST(50, EXTRACT(EPOCH FROM (now() - p.last_seen_at))/3600 / 6)
             + LEAST(20, EXTRACT(EPOCH FROM (now() - p.first_seen_at))/86400 / 3)
      END
    )))::int                                                       AS ops_stability,

    -- history_thickness: 관측 row 수 (이력 두께)
    LEAST(100, GREATEST(0,
      COALESCE(a.history_rows,0) * 6
      + (CASE WHEN COALESCE(a.history_rows,0) >= min_history THEN 20 ELSE 0 END)
    ))::int                                                        AS history_thickness,

    -- 진단 지표
    COALESCE(a.history_rows, 0)                                    AS history_rows,
    COALESCE(a.distinct_prices, 0)                                 AS distinct_prices,
    CASE
      WHEN a.price_avg IS NULL OR a.price_avg = 0 THEN NULL
      ELSE ROUND((a.price_stddev / a.price_avg)::numeric, 4)
    END                                                            AS price_cv,
    COALESCE(a.price_min, p.price_krw)                             AS price_min,
    COALESCE(a.price_max, p.price_krw)                             AS price_max,
    COALESCE(a.stockout_events, 0)                                 AS stockout_events,
    COALESCE(a.imminent_events, 0)                                 AS imminent_events,
    ROUND(EXTRACT(EPOCH FROM (now() - p.first_seen_at))/86400, 2)  AS active_days,
    ROUND(EXTRACT(EPOCH FROM (now() - p.last_seen_at))/3600, 2)    AS last_seen_age_hours,
    -- 30일내 last_changed_at 변동 count는 history rows로 대체
    COALESCE(a.history_rows, 0)                                    AS change_events_30d,
    COALESCE(a.last_observed_at, p.last_changed_at)                AS last_observed_at
  FROM prods p
  LEFT JOIN agg a ON a.goods_no = p.goods_no;
$$;

COMMENT ON FUNCTION jimscanner_ggsan_supplier_reliability(int, int) IS
  '공급사 SKU 신뢰성 점수: 가격·재고·운영·이력두께 4축을 0-100 종합 점수로 반환';


-- ─────────────────────────────────────────────────────────────
-- 가격·재고 이벤트 sparkline 시계열 RPC
-- ─────────────────────────────────────────────────────────────
-- products/[id] 상세 페이지 미니차트용. 최근 N일 price_history 시계열을 반환.
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_ggsan_price_sparkline(
  p_goods_no   text,
  lookback_days int DEFAULT 30,
  max_points    int DEFAULT 48
)
RETURNS TABLE (
  observed_at  timestamptz,
  price_krw    int,
  status       text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT observed_at, price_krw, status
  FROM jimscanner_ggsan_price_history
  WHERE goods_no = p_goods_no
    AND observed_at >= now() - make_interval(days => lookback_days)
  ORDER BY observed_at DESC
  LIMIT max_points;
$$;

COMMENT ON FUNCTION jimscanner_ggsan_price_sparkline(text, int, int) IS
  'ggsan SKU 가격·재고 시계열 (sparkline 미니차트용)';
