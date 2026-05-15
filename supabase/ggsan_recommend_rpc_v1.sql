-- ────────────────────────────────────────────────────────────
-- ggsan 위탁 후보 추천 RPC (V1, 2026-05-15)
-- ────────────────────────────────────────────────────────────
-- V0 대비 변경:
--   + price_delta_7d_pct, price_delta_30d_pct, lowest_price_in_30d 노출
--   + price_drop_bonus 를 final_score 에 곱셈 합산
--       - 7일내 -10% 이상 하락:   1.2배
--       - 7일내 -5%~-10% 하락:    1.1배
--       - 그 외:                  1.0배
--
-- 사용처:
--   - /admin/trend-radar/recommend
--   - /admin/trend-radar/price-momentum (가격 인하 모멘텀 매수 신호)
-- ────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS jimscanner_ggsan_recommend(int, float, float, int);

CREATE OR REPLACE FUNCTION jimscanner_ggsan_recommend(
  days_window int DEFAULT 30,
  min_sim float DEFAULT 0.20,
  min_score float DEFAULT 0.5,
  result_limit int DEFAULT 100
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
  ggsan_last_seen timestamptz,
  -- 점수 분해
  tv_score real,
  search_score real,
  raw_score real,
  imminent_bonus real,
  price_drop_bonus real,
  final_score real,
  -- 매칭 근거
  tv_match_count int,
  tv_top_keyword text,
  tv_total_pushes int,
  search_match_count int,
  search_top_keyword text,
  search_sources text[],
  -- 가격 시계열
  price_delta_7d_pct real,
  price_delta_30d_pct real,
  lowest_price_in_30d int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  tv_keywords AS (
    SELECT keyword, COUNT(*)::int AS tv_count
    FROM jimscanner_trends_keywords
    WHERE source = 'naver_tvtime'
      AND collected_at > now() - (days_window || ' days')::interval
    GROUP BY keyword
  ),
  tv_matches AS (
    SELECT
      gp.goods_no,
      tv.keyword AS tv_keyword,
      tv.tv_count,
      similarity(tv.keyword, gp.title) AS sim,
      tv.tv_count::real * similarity(tv.keyword, gp.title) AS strength
    FROM tv_keywords tv
    CROSS JOIN LATERAL (
      SELECT g.goods_no, g.title
      FROM jimscanner_ggsan_products g
      WHERE g.title % tv.keyword
      ORDER BY similarity(tv.keyword, g.title) DESC
      LIMIT 5
    ) gp
    WHERE similarity(tv.keyword, gp.title) >= min_sim
  ),
  tv_agg AS (
    SELECT
      goods_no,
      SUM(strength)::real AS tv_score,
      COUNT(DISTINCT tv_keyword)::int AS tv_match_count,
      SUM(tv_count)::int AS tv_total_pushes,
      (ARRAY_AGG(tv_keyword ORDER BY strength DESC))[1] AS tv_top_keyword
    FROM tv_matches
    GROUP BY goods_no
  ),
  search_keywords AS (
    SELECT
      keyword,
      source,
      COUNT(*)::int AS occurrences
    FROM jimscanner_trends_keywords
    WHERE source IN (
      'naver_shopping_hot',
      'naver_search_trend',
      'aliex_best',
      'musinsa_best'
    )
      AND collected_at > now() - (days_window || ' days')::interval
    GROUP BY keyword, source
  ),
  search_matches AS (
    SELECT
      gp.goods_no,
      sk.keyword AS search_keyword,
      sk.source,
      sk.occurrences,
      similarity(sk.keyword, gp.title) AS sim,
      sk.occurrences::real * similarity(sk.keyword, gp.title) AS strength
    FROM search_keywords sk
    CROSS JOIN LATERAL (
      SELECT g.goods_no, g.title
      FROM jimscanner_ggsan_products g
      WHERE g.title % sk.keyword
      ORDER BY similarity(sk.keyword, g.title) DESC
      LIMIT 5
    ) gp
    WHERE similarity(sk.keyword, gp.title) >= min_sim
  ),
  search_agg AS (
    SELECT
      goods_no,
      SUM(strength)::real AS search_score,
      COUNT(DISTINCT search_keyword)::int AS search_match_count,
      (ARRAY_AGG(search_keyword ORDER BY strength DESC))[1] AS search_top_keyword,
      ARRAY_AGG(DISTINCT source) AS search_sources
    FROM search_matches
    GROUP BY goods_no
  ),

  -- 가격 시계열: 7일/30일 전 가격, 30일 최저가
  price_stats AS (
    SELECT
      ph.goods_no,
      -- 7일 이전 가장 가까운 관측치
      (
        SELECT ph7.price_krw
        FROM jimscanner_ggsan_price_history ph7
        WHERE ph7.goods_no = ph.goods_no
          AND ph7.observed_at <= now() - interval '7 days'
          AND ph7.price_krw IS NOT NULL
        ORDER BY ph7.observed_at DESC
        LIMIT 1
      ) AS price_7d_ago,
      (
        SELECT ph30.price_krw
        FROM jimscanner_ggsan_price_history ph30
        WHERE ph30.goods_no = ph.goods_no
          AND ph30.observed_at <= now() - interval '30 days'
          AND ph30.price_krw IS NOT NULL
        ORDER BY ph30.observed_at DESC
        LIMIT 1
      ) AS price_30d_ago,
      MIN(ph.price_krw) FILTER (WHERE ph.observed_at > now() - interval '30 days') AS lowest_30d
    FROM jimscanner_ggsan_price_history ph
    GROUP BY ph.goods_no
  ),

  scored AS (
    SELECT
      gp.goods_no, gp.title, gp.cate_cd, gp.cate_label, gp.price_krw,
      gp.is_imminent, gp.image_url, gp.detail_url, gp.last_seen_at,
      COALESCE(tv.tv_score, 0)::real AS tv_score,
      COALESCE(s.search_score, 0)::real AS search_score,
      COALESCE(tv.tv_match_count, 0) AS tv_match_count,
      COALESCE(tv.tv_top_keyword, '') AS tv_top_keyword,
      COALESCE(tv.tv_total_pushes, 0) AS tv_total_pushes,
      COALESCE(s.search_match_count, 0) AS search_match_count,
      COALESCE(s.search_top_keyword, '') AS search_top_keyword,
      COALESCE(s.search_sources, ARRAY[]::text[]) AS search_sources,
      ps.price_7d_ago,
      ps.price_30d_ago,
      ps.lowest_30d,
      -- 7일 변화율 (%)
      CASE
        WHEN ps.price_7d_ago IS NOT NULL AND ps.price_7d_ago > 0 AND gp.price_krw IS NOT NULL
          THEN ((gp.price_krw - ps.price_7d_ago)::real / ps.price_7d_ago::real * 100.0)::real
        ELSE NULL
      END AS d7_pct,
      CASE
        WHEN ps.price_30d_ago IS NOT NULL AND ps.price_30d_ago > 0 AND gp.price_krw IS NOT NULL
          THEN ((gp.price_krw - ps.price_30d_ago)::real / ps.price_30d_ago::real * 100.0)::real
        ELSE NULL
      END AS d30_pct
    FROM jimscanner_ggsan_products gp
    LEFT JOIN tv_agg tv ON tv.goods_no = gp.goods_no
    LEFT JOIN search_agg s ON s.goods_no = gp.goods_no
    LEFT JOIN price_stats ps ON ps.goods_no = gp.goods_no
    WHERE tv.tv_score IS NOT NULL OR s.search_score IS NOT NULL
  ),

  scored_bonus AS (
    SELECT
      s.*,
      (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)::real AS imminent_bonus_v,
      (CASE
        WHEN s.d7_pct IS NOT NULL AND s.d7_pct <= -10.0 THEN 1.2
        WHEN s.d7_pct IS NOT NULL AND s.d7_pct <= -5.0  THEN 1.1
        ELSE 1.0
      END)::real AS price_drop_bonus_v
    FROM scored s
  )

  SELECT
    sb.goods_no,
    sb.title,
    sb.cate_cd,
    sb.cate_label,
    sb.price_krw,
    sb.is_imminent,
    sb.image_url,
    sb.detail_url,
    sb.last_seen_at AS ggsan_last_seen,
    sb.tv_score,
    sb.search_score,
    (sb.tv_score * 1.5 + sb.search_score * 1.0)::real AS raw_score,
    sb.imminent_bonus_v AS imminent_bonus,
    sb.price_drop_bonus_v AS price_drop_bonus,
    ((sb.tv_score * 1.5 + sb.search_score * 1.0)
       * sb.imminent_bonus_v
       * sb.price_drop_bonus_v)::real AS final_score,
    sb.tv_match_count,
    sb.tv_top_keyword,
    sb.tv_total_pushes,
    sb.search_match_count,
    sb.search_top_keyword,
    sb.search_sources,
    sb.d7_pct AS price_delta_7d_pct,
    sb.d30_pct AS price_delta_30d_pct,
    sb.lowest_30d AS lowest_price_in_30d
  FROM scored_bonus sb
  WHERE ((sb.tv_score * 1.5 + sb.search_score * 1.0)
           * sb.imminent_bonus_v
           * sb.price_drop_bonus_v) >= min_score
  ORDER BY
    (CASE WHEN sb.is_imminent THEN 1 ELSE 0 END) DESC,
    ((sb.tv_score * 1.5 + sb.search_score * 1.0)
       * sb.imminent_bonus_v
       * sb.price_drop_bonus_v) DESC
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_ggsan_recommend(int, float, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_ggsan_recommend(int, float, float, int) TO service_role;


-- ────────────────────────────────────────────────────────────
-- 가격 모멘텀 sparkline RPC: 상품 단위 최근 30일 일별 가격 시계열
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_ggsan_price_sparkline(
  p_goods_no text,
  p_days int DEFAULT 30
)
RETURNS TABLE (
  observed_day date,
  price_krw int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    (date_trunc('day', observed_at AT TIME ZONE 'Asia/Seoul'))::date AS observed_day,
    -- 같은 날 여러 스냅샷이 있으면 마지막(가장 늦은 시각) 가격
    (ARRAY_AGG(price_krw ORDER BY observed_at DESC))[1] AS price_krw
  FROM jimscanner_ggsan_price_history
  WHERE goods_no = p_goods_no
    AND observed_at > now() - (p_days || ' days')::interval
    AND price_krw IS NOT NULL
  GROUP BY 1
  ORDER BY 1 ASC;
$$;

REVOKE ALL ON FUNCTION jimscanner_ggsan_price_sparkline(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_ggsan_price_sparkline(text, int) TO service_role;
