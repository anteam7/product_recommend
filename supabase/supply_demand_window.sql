-- ────────────────────────────────────────────────────────────
-- 공급↓ × 수요↑ 동시발생 진입윈도우 감지 RPC (2026-05-18)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/entry-window
-- 공급측: jimscanner_ggsan_price_history → 도매가 7일 하락률, 재고 안정도
-- 수요측: jimscanner_trends_keywords (naver_search_trend, naver_tvtime, naver_shopping_hot,
--          shopping_insight) → 7일/28일 mentions 가속도
-- 매칭: ggsan title ↔ keyword pg_trgm similarity (기존 ggsan_recommend_rpc 와 동일 기법)
--
-- convergence_score = clamp(supply_drop_pct_7d, 0..50) / 50
--                   * clamp(demand_accel_7d, 0..3) / 3
--                   * (1 + 0.2 * (in_stock_days_7d / 7))
-- → 0..1.2 범위, 두 축 동시양호 일 때만 큰 값.
--
-- 진입 윈도우 만료(D-n): 첫 convergence 시그널 이후 10일을 골든 윈도우로 가정.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_supply_demand_window(
  result_limit int DEFAULT 100,
  min_sim float DEFAULT 0.20,
  min_convergence float DEFAULT 0.0
)
RETURNS TABLE (
  product_id text,
  title text,
  cate_cd text,
  cate_label text,
  price_krw int,
  image_url text,
  detail_url text,
  is_imminent boolean,
  -- supply side
  supply_drop_pct_7d real,
  supply_in_stock_days int,
  price_now int,
  price_7d_ago int,
  -- demand side
  demand_count_7d int,
  demand_count_prev7 int,
  demand_count_28d int,
  demand_accel_7d real,
  demand_accel_28d real,
  demand_top_keyword text,
  demand_sources text[],
  -- combined
  convergence_score real,
  window_d_remain int,
  first_signal_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  -- ─── 1) 공급측: ggsan price history → 7일 하락률, 재고 안정도
  price_now AS (
    SELECT DISTINCT ON (h.goods_no)
      h.goods_no,
      h.price_krw AS price_now,
      h.observed_at AS observed_at_now,
      h.status AS status_now
    FROM jimscanner_ggsan_price_history h
    WHERE h.observed_at > now() - interval '14 days'
    ORDER BY h.goods_no, h.observed_at DESC
  ),
  price_7d AS (
    SELECT DISTINCT ON (h.goods_no)
      h.goods_no,
      h.price_krw AS price_7d_ago,
      h.observed_at AS observed_at_7d
    FROM jimscanner_ggsan_price_history h
    WHERE h.observed_at < now() - interval '5 days'
      AND h.observed_at > now() - interval '21 days'
    ORDER BY h.goods_no, h.observed_at DESC
  ),
  stock_stability AS (
    SELECT
      goods_no,
      COUNT(DISTINCT date_trunc('day', observed_at))::int FILTER (
        WHERE status IS NULL OR status = 'active'
      ) AS in_stock_days_7d
    FROM jimscanner_ggsan_price_history
    WHERE observed_at > now() - interval '7 days'
    GROUP BY goods_no
  ),
  supply AS (
    SELECT
      pn.goods_no,
      pn.price_now,
      p7.price_7d_ago,
      CASE
        WHEN p7.price_7d_ago IS NULL OR p7.price_7d_ago <= 0 THEN 0::real
        WHEN pn.price_now IS NULL THEN 0::real
        ELSE ((p7.price_7d_ago - pn.price_now)::real / p7.price_7d_ago::real * 100.0)::real
      END AS supply_drop_pct_7d,
      COALESCE(ss.in_stock_days_7d, 0) AS supply_in_stock_days
    FROM price_now pn
    LEFT JOIN price_7d p7 ON p7.goods_no = pn.goods_no
    LEFT JOIN stock_stability ss ON ss.goods_no = pn.goods_no
  ),

  -- ─── 2) 수요측: trends_keywords 가속도 (7d vs prev7d, 28d 누계)
  demand_sources_def AS (
    SELECT unnest(ARRAY[
      'naver_search_trend',
      'naver_tvtime',
      'naver_shopping_hot',
      'shopping_insight'
    ]) AS source
  ),
  -- 모든 ggsan 상품에 대해 fuzzy 매칭되는 키워드의 시간대별 카운트
  -- (LATERAL → 인덱스 활용)
  keyword_matches AS (
    SELECT
      gp.goods_no,
      k.keyword,
      k.source,
      k.collected_at,
      similarity(k.keyword, gp.title) AS sim
    FROM jimscanner_ggsan_products gp
    CROSS JOIN LATERAL (
      SELECT keyword, source, collected_at
      FROM jimscanner_trends_keywords kk
      WHERE kk.source IN (
        'naver_search_trend',
        'naver_tvtime',
        'naver_shopping_hot',
        'shopping_insight'
      )
        AND kk.collected_at > now() - interval '28 days'
        AND kk.keyword % gp.title          -- pg_trgm 인덱스 (gin_trgm on ggsan title) + 키워드 trigram
    ) k
    WHERE similarity(k.keyword, gp.title) >= min_sim
  ),
  demand AS (
    SELECT
      goods_no,
      COUNT(*) FILTER (WHERE collected_at > now() - interval '7 days')::int AS demand_count_7d,
      COUNT(*) FILTER (WHERE collected_at <= now() - interval '7 days'
                         AND collected_at > now() - interval '14 days')::int AS demand_count_prev7,
      COUNT(*) FILTER (WHERE collected_at > now() - interval '28 days')::int AS demand_count_28d,
      MIN(collected_at) AS first_signal_at,
      (ARRAY_AGG(keyword ORDER BY sim DESC))[1] AS demand_top_keyword,
      ARRAY_AGG(DISTINCT source) AS demand_sources
    FROM keyword_matches
    GROUP BY goods_no
  ),
  demand_calc AS (
    SELECT
      d.*,
      CASE
        WHEN d.demand_count_prev7 = 0 AND d.demand_count_7d > 0 THEN d.demand_count_7d::real
        WHEN d.demand_count_prev7 = 0 THEN 0::real
        ELSE ((d.demand_count_7d - d.demand_count_prev7)::real / d.demand_count_prev7::real)::real
      END AS demand_accel_7d,
      CASE
        WHEN d.demand_count_28d = 0 THEN 0::real
        ELSE ((d.demand_count_7d::real * 4.0 - d.demand_count_28d::real) / d.demand_count_28d::real)::real
      END AS demand_accel_28d
    FROM demand d
  ),

  -- ─── 3) 결합
  combined AS (
    SELECT
      gp.goods_no,
      gp.title,
      gp.cate_cd,
      gp.cate_label,
      gp.price_krw,
      gp.image_url,
      gp.detail_url,
      gp.is_imminent,
      COALESCE(s.supply_drop_pct_7d, 0)::real AS supply_drop_pct_7d,
      COALESCE(s.supply_in_stock_days, 0) AS supply_in_stock_days,
      s.price_now,
      s.price_7d_ago,
      COALESCE(d.demand_count_7d, 0) AS demand_count_7d,
      COALESCE(d.demand_count_prev7, 0) AS demand_count_prev7,
      COALESCE(d.demand_count_28d, 0) AS demand_count_28d,
      COALESCE(d.demand_accel_7d, 0)::real AS demand_accel_7d,
      COALESCE(d.demand_accel_28d, 0)::real AS demand_accel_28d,
      COALESCE(d.demand_top_keyword, '') AS demand_top_keyword,
      COALESCE(d.demand_sources, ARRAY[]::text[]) AS demand_sources,
      d.first_signal_at
    FROM jimscanner_ggsan_products gp
    LEFT JOIN supply s ON s.goods_no = gp.goods_no
    LEFT JOIN demand_calc d ON d.goods_no = gp.goods_no
    -- 둘 중 한쪽이라도 시그널 있는 것만 (양쪽 0 인 죽은 행 제외)
    WHERE (COALESCE(s.supply_drop_pct_7d, 0) > 0 OR COALESCE(d.demand_count_7d, 0) > 0)
  )

  SELECT
    c.goods_no AS product_id,
    c.title,
    c.cate_cd,
    c.cate_label,
    c.price_krw,
    c.image_url,
    c.detail_url,
    c.is_imminent,
    c.supply_drop_pct_7d,
    c.supply_in_stock_days,
    c.price_now,
    c.price_7d_ago,
    c.demand_count_7d,
    c.demand_count_prev7,
    c.demand_count_28d,
    c.demand_accel_7d,
    c.demand_accel_28d,
    c.demand_top_keyword,
    c.demand_sources,
    -- convergence_score 0..1.2
    (
      LEAST(GREATEST(c.supply_drop_pct_7d, 0), 50.0) / 50.0
      * LEAST(GREATEST(c.demand_accel_7d, 0), 3.0) / 3.0
      * (1.0 + 0.2 * (LEAST(c.supply_in_stock_days, 7)::real / 7.0))
    )::real AS convergence_score,
    -- 윈도우 D-remain (10일 가정)
    GREATEST(
      0,
      10 - COALESCE(EXTRACT(DAY FROM (now() - c.first_signal_at))::int, 0)
    )::int AS window_d_remain,
    c.first_signal_at
  FROM combined c
  WHERE (
    LEAST(GREATEST(c.supply_drop_pct_7d, 0), 50.0) / 50.0
    * LEAST(GREATEST(c.demand_accel_7d, 0), 3.0) / 3.0
    * (1.0 + 0.2 * (LEAST(c.supply_in_stock_days, 7)::real / 7.0))
  ) >= min_convergence
  ORDER BY convergence_score DESC NULLS LAST
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출
REVOKE ALL ON FUNCTION jimscanner_supply_demand_window(int, float, float) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_supply_demand_window(int, float, float) TO service_role;

-- ────────────────────────────────────────────────────────────
-- 동일 데이터의 단순 VIEW (디폴트 파라미터, 어드민 외부 도구·ad-hoc 분석용)
-- view 와 function 이 이름 공유 시 ambiguity 회피 위해 _v 접미사
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW jimscanner_supply_demand_window_v AS
SELECT * FROM jimscanner_supply_demand_window(200, 0.20, 0.0);

REVOKE ALL ON jimscanner_supply_demand_window_v FROM PUBLIC;
GRANT SELECT ON jimscanner_supply_demand_window_v TO service_role;
