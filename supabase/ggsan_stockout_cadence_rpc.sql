-- ────────────────────────────────────────────────────────────
-- 도매 품절 캐던스 수요검증 RPC (2026-06-05)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/stockout-oracle
-- 신호 철학:
--   jimscanner_ggsan_price_history.status 시계열(active↔sold_out↔imminent)을
--   '버즈'(커뮤니티/검색/뉴스 소프트 신호)가 아닌 '공급측 소진'(supply-side
--   sell-through) 하드 신호로 재해석한다. 반복 품절 + 빠른 재입고일수록
--   도매단에서 실제로 누군가 계속 사가고 있다는 협찬·어뷰징 불가능한
--   그라운드트루스 → 위탁 우선순위 상위.
--
-- goods_no별 집계:
--   (a) soldout_entries  : 관측기간 내 sold_out 진입 횟수
--   (b) avg_stock_life   : active → sold_out 까지 평균 재고 수명(시간)
--   (c) avg_restock_delay: sold_out → 재판매(active 등) 평균 재입고 지연(시간)
--   (d) imminent_obs     : imminent(마감임박 할인) 관측 빈도
--   cadence_score        : 자주·빠르게 품절+빠른 재입고일수록 높음
--
-- ggsan 가격수집 스크립트(scripts/ggsan-*)가 이미 status를 적재 →
-- 신규 수집 불필요. 기존 trend_score(버즈) 대비 '공급측 검증도' 축.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_ggsan_stockout_cadence(
  days_window int DEFAULT 90,
  min_soldout int DEFAULT 1,
  result_limit int DEFAULT 300
)
RETURNS TABLE (
  goods_no text,
  title text,
  cate_cd text,
  cate_label text,
  price_krw int,
  is_imminent boolean,
  image_url text,
  detail_url text,
  current_status text,
  obs_count int,
  observed_span_days real,
  soldout_entries int,
  imminent_obs int,
  avg_stock_life_hours real,
  avg_restock_delay_hours real,
  soldout_per_30d real,
  cadence_score real
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH obs AS (
    SELECT
      ph.goods_no,
      ph.status,
      ph.observed_at,
      LAG(ph.status)      OVER (PARTITION BY ph.goods_no ORDER BY ph.observed_at) AS prev_status,
      LAG(ph.observed_at) OVER (PARTITION BY ph.goods_no ORDER BY ph.observed_at) AS prev_at
    FROM jimscanner_ggsan_price_history ph
    WHERE ph.observed_at > now() - (days_window || ' days')::interval
      AND ph.status IS NOT NULL
  ),
  -- 상태가 실제로 바뀐 전이 이벤트만
  transitions AS (
    SELECT
      goods_no, status, observed_at, prev_status,
      observed_at - LAG(observed_at) OVER (PARTITION BY goods_no ORDER BY observed_at) AS dur_prev_state
    FROM obs
    WHERE prev_status IS DISTINCT FROM status
  ),
  trans_agg AS (
    SELECT
      goods_no,
      COUNT(*) FILTER (WHERE status = 'sold_out')::int AS soldout_entries,
      -- active → sold_out 직전 active 상태가 지속된 시간 = 재고 수명
      AVG(EXTRACT(EPOCH FROM dur_prev_state) / 3600.0)
        FILTER (WHERE status = 'sold_out' AND prev_status = 'active')::real AS avg_stock_life_hours,
      -- sold_out → 재판매: 직전 sold_out 상태 지속 시간 = 재입고 지연
      AVG(EXTRACT(EPOCH FROM dur_prev_state) / 3600.0)
        FILTER (WHERE prev_status = 'sold_out' AND status <> 'sold_out')::real AS avg_restock_delay_hours
    FROM transitions
    GROUP BY goods_no
  ),
  span_agg AS (
    SELECT
      goods_no,
      COUNT(*)::int AS obs_count,
      COUNT(*) FILTER (WHERE status = 'imminent')::int AS imminent_obs,
      MIN(observed_at) AS first_at,
      MAX(observed_at) AS last_at,
      GREATEST(EXTRACT(EPOCH FROM (MAX(observed_at) - MIN(observed_at))) / 86400.0, 0.0)::real AS span_days
    FROM obs
    GROUP BY goods_no
  ),
  cur AS (
    SELECT DISTINCT ON (goods_no) goods_no, status AS current_status
    FROM obs
    ORDER BY goods_no, observed_at DESC
  )
  SELECT
    g.goods_no,
    g.title,
    g.cate_cd,
    g.cate_label,
    g.price_krw,
    g.is_imminent,
    g.image_url,
    g.detail_url,
    c.current_status,
    sp.obs_count,
    sp.span_days AS observed_span_days,
    ta.soldout_entries,
    sp.imminent_obs,
    ta.avg_stock_life_hours,
    ta.avg_restock_delay_hours,
    (ta.soldout_entries::real / NULLIF(sp.span_days, 0) * 30.0)::real AS soldout_per_30d,
    -- 캐던스 점수: 빈도(30일 정규화) × 빠른 재입고 보너스(지연 미관측은 1주로 가정)
    --             × imminent 가산. 자주·빠르게 품절+빠른 재입고일수록 ↑
    (
      (ta.soldout_entries::real / NULLIF(sp.span_days, 0) * 30.0)
      * (24.0 / (24.0 + COALESCE(ta.avg_restock_delay_hours, 168.0)))
      * (1.0 + LEAST(sp.imminent_obs, 5) * 0.05)
    )::real AS cadence_score
  FROM trans_agg ta
  JOIN span_agg sp ON sp.goods_no = ta.goods_no
  JOIN cur c       ON c.goods_no = ta.goods_no
  JOIN jimscanner_ggsan_products g ON g.goods_no = ta.goods_no
  WHERE ta.soldout_entries >= min_soldout
  ORDER BY cadence_score DESC NULLS LAST
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_ggsan_stockout_cadence(int, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_ggsan_stockout_cadence(int, int, int) TO service_role;
