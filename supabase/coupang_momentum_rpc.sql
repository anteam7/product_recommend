-- ────────────────────────────────────────────────────────────
-- 판매중 SKU 트렌드 모멘텀 RPC (2026-06-02)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/coupang-publish/momentum
-- 방향: forward-operations 루프 — '무엇을 새로 팔까(발굴)'가 아니라
--   '이미 파는 것 중 뭘 밀고 뭘 접을까'.
-- 키: jimscanner_coupang_listings.source_goods_no (= ggsan goods_no)
--   → jimscanner_ggsan_products.title 로 트렌드 키워드 trigram 역매칭
--   → 최근(recent_days) vs 직전(prior_days) 윈도 일평균 강도 Δ 로 가열/안정/냉각 분류
-- service_role 전용 (SECURITY DEFINER + grant 명시) — recommend RPC 와 동일 패턴
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_coupang_momentum(
  recent_days int DEFAULT 7,
  prior_days int DEFAULT 14,
  min_sim float DEFAULT 0.20,
  spark_days int DEFAULT 14
)
RETURNS TABLE (
  listing_id uuid,
  registered_title text,
  status text,
  displayable boolean,
  list_price_krw int,
  msp_price_krw int,
  estimated_margin_pct numeric,
  product_id bigint,
  source_goods_no text,
  ggsan_title text,
  cate_label text,
  image_url text,
  detail_url text,
  sold_count int,
  -- 모멘텀
  recent_score real,          -- 최근 윈도 일평균 매칭 강도
  prior_score real,           -- 직전 윈도 일평균 매칭 강도
  delta_score real,           -- recent - prior
  momentum_pct real,          -- (recent-prior)/prior*100  (prior=0&recent>0 → 999)
  recent_match_count int,
  top_keyword text,
  trend_state text,           -- 'heating' | 'stable' | 'cooling' | 'no_signal'
  spark numeric[]             -- 최근 spark_days 일별 매칭 강도 (스파크라인)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  -- 1) 살아있는 SKU (판매중·승인) + ggsan 카탈로그 join
  live AS (
    SELECT
      l.id AS listing_id,
      l.registered_title,
      l.status,
      l.displayable,
      l.list_price_krw,
      l.msp_price_krw,
      l.estimated_margin_pct,
      l.product_id,
      l.source_goods_no,
      l.sold_count,
      g.title AS ggsan_title,
      g.cate_label,
      g.image_url,
      g.detail_url
    FROM jimscanner_coupang_listings l
    JOIN jimscanner_ggsan_products g ON g.goods_no = l.source_goods_no
    WHERE l.status IN ('SELLING', 'APPROVED')
      AND l.source <> 'manual'
      AND l.source_goods_no IS NOT NULL
  ),

  -- 2) 트렌드 키워드 이벤트 (spark·prior 윈도 전체)
  kw AS (
    SELECT
      keyword,
      collected_at,
      date_trunc('day', collected_at) AS day
    FROM jimscanner_trends_keywords
    WHERE collected_at > now() - (GREATEST(recent_days + prior_days, spark_days) || ' days')::interval
      AND source IN (
        'naver_tvtime',
        'naver_shopping_hot',
        'naver_search_trend',
        'aliex_best',
        'musinsa_best'
      )
  ),

  -- 3) SKU ↔ 키워드 trigram 매칭 (ggsan title 기준)
  matched AS (
    SELECT
      live.listing_id,
      kw.keyword,
      kw.collected_at,
      kw.day,
      similarity(kw.keyword, live.ggsan_title) AS sim
    FROM live
    JOIN kw ON kw.keyword % live.ggsan_title
    WHERE similarity(kw.keyword, live.ggsan_title) >= min_sim
  ),

  -- 4) 윈도별 집계
  agg AS (
    SELECT
      listing_id,
      SUM(sim) FILTER (
        WHERE collected_at > now() - (recent_days || ' days')::interval
      )::real AS recent_raw,
      SUM(sim) FILTER (
        WHERE collected_at <= now() - (recent_days || ' days')::interval
          AND collected_at > now() - ((recent_days + prior_days) || ' days')::interval
      )::real AS prior_raw,
      COUNT(DISTINCT keyword) FILTER (
        WHERE collected_at > now() - (recent_days || ' days')::interval
      )::int AS recent_match_count,
      (ARRAY_AGG(keyword ORDER BY sim DESC))[1] AS top_keyword
    FROM matched
    GROUP BY listing_id
  ),

  -- 5) 스파크라인용 일별 시계열
  days AS (
    SELECT generate_series(
      date_trunc('day', now()) - ((spark_days - 1) || ' days')::interval,
      date_trunc('day', now()),
      '1 day'::interval
    ) AS day
  ),
  spark_agg AS (
    SELECT
      live.listing_id,
      ARRAY_AGG(COALESCE(dd.s, 0)::numeric ORDER BY days.day) AS spark
    FROM live
    CROSS JOIN days
    LEFT JOIN LATERAL (
      SELECT SUM(m.sim) AS s
      FROM matched m
      WHERE m.listing_id = live.listing_id AND m.day = days.day
    ) dd ON true
    GROUP BY live.listing_id
  )

  SELECT
    live.listing_id,
    live.registered_title,
    live.status,
    live.displayable,
    live.list_price_krw,
    live.msp_price_krw,
    live.estimated_margin_pct,
    live.product_id,
    live.source_goods_no,
    live.ggsan_title,
    live.cate_label,
    live.image_url,
    live.detail_url,
    live.sold_count,
    (COALESCE(agg.recent_raw, 0) / GREATEST(recent_days, 1))::real AS recent_score,
    (COALESCE(agg.prior_raw, 0) / GREATEST(prior_days, 1))::real AS prior_score,
    (COALESCE(agg.recent_raw, 0) / GREATEST(recent_days, 1)
      - COALESCE(agg.prior_raw, 0) / GREATEST(prior_days, 1))::real AS delta_score,
    (CASE
      WHEN COALESCE(agg.prior_raw, 0) = 0 AND COALESCE(agg.recent_raw, 0) > 0 THEN 999
      WHEN COALESCE(agg.prior_raw, 0) = 0 THEN 0
      ELSE ((COALESCE(agg.recent_raw, 0) / GREATEST(recent_days, 1))
            - (COALESCE(agg.prior_raw, 0) / GREATEST(prior_days, 1)))
           / (COALESCE(agg.prior_raw, 0) / GREATEST(prior_days, 1)) * 100
    END)::real AS momentum_pct,
    COALESCE(agg.recent_match_count, 0) AS recent_match_count,
    COALESCE(agg.top_keyword, '') AS top_keyword,
    (CASE
      WHEN COALESCE(agg.recent_raw, 0) = 0 AND COALESCE(agg.prior_raw, 0) = 0 THEN 'no_signal'
      WHEN COALESCE(agg.prior_raw, 0) = 0 AND COALESCE(agg.recent_raw, 0) > 0 THEN 'heating'
      WHEN ((COALESCE(agg.recent_raw, 0) / GREATEST(recent_days, 1))
            - (COALESCE(agg.prior_raw, 0) / GREATEST(prior_days, 1)))
           / (COALESCE(agg.prior_raw, 0) / GREATEST(prior_days, 1)) * 100 >= 20 THEN 'heating'
      WHEN ((COALESCE(agg.recent_raw, 0) / GREATEST(recent_days, 1))
            - (COALESCE(agg.prior_raw, 0) / GREATEST(prior_days, 1)))
           / (COALESCE(agg.prior_raw, 0) / GREATEST(prior_days, 1)) * 100 <= -20 THEN 'cooling'
      ELSE 'stable'
    END) AS trend_state,
    COALESCE(spark_agg.spark, ARRAY[]::numeric[]) AS spark
  FROM live
  LEFT JOIN agg ON agg.listing_id = live.listing_id
  LEFT JOIN spark_agg ON spark_agg.listing_id = live.listing_id
  ORDER BY
    -- 가열 먼저, 그다음 모멘텀 강도, 그다음 마진
    (CASE
      WHEN COALESCE(agg.recent_raw, 0) = 0 AND COALESCE(agg.prior_raw, 0) = 0 THEN 3
      WHEN COALESCE(agg.prior_raw, 0) = 0 AND COALESCE(agg.recent_raw, 0) > 0 THEN 0
      ELSE 1
    END) ASC,
    delta_score DESC,
    live.estimated_margin_pct DESC NULLS LAST;
$$;

-- 어드민 service-role 만 호출 (anon/authenticated 차단)
REVOKE ALL ON FUNCTION jimscanner_coupang_momentum(int, int, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_coupang_momentum(int, int, float, int) TO service_role;
