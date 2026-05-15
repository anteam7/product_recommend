-- ────────────────────────────────────────────────────────────
-- TV 편성 → 검색 lift 매트릭스 RPC (2026-05-15)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/tv-lift
-- 각 naver_tvtime 키워드의 "첫 편성일" 을 기준으로
-- ±7일 윈도우에서 naver_search_trend / naver_shopping_insight
-- 의 volume_relative 평균 변화율(lift = post_avg / pre_avg)을 계산.
--
-- 출력:
--   tv_count            : 편성 빈도(중복 포함)
--   first_seen          : 첫 편성 시각 (피벗)
--   pre_avg / post_avg  : ±window_days 윈도우 평균 volume_relative
--   lift                : post_avg / pre_avg (pre가 0이면 NULL)
--   stddev_post         : 사후 윈도우 표준편차 (p-value 대용)
--   sample_pre / sample_post : 표본 수 (신뢰도 판단용)
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_tv_lift(
  window_days int DEFAULT 7,
  min_tv_count int DEFAULT 1,
  result_limit int DEFAULT 500
)
RETURNS TABLE (
  keyword text,
  tv_count int,
  first_seen timestamptz,
  last_seen timestamptz,
  pre_avg numeric,
  post_avg numeric,
  lift numeric,
  stddev_post numeric,
  sample_pre int,
  sample_post int,
  search_sources text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH tv AS (
    SELECT
      k.keyword,
      COUNT(*)::int AS tv_count,
      MIN(k.collected_at) AS first_seen,
      MAX(k.collected_at) AS last_seen
    FROM jimscanner_trends_keywords k
    WHERE k.source = 'naver_tvtime'
    GROUP BY k.keyword
    HAVING COUNT(*) >= min_tv_count
  ),
  pre AS (
    SELECT
      tv.keyword,
      AVG(s.volume_relative)::numeric AS pre_avg,
      COUNT(*)::int AS sample_pre
    FROM tv
    LEFT JOIN jimscanner_trends_keywords s
      ON s.keyword = tv.keyword
     AND s.source IN ('naver_search_trend', 'naver_shopping_insight')
     AND s.collected_at >= tv.first_seen - (window_days || ' days')::interval
     AND s.collected_at <  tv.first_seen
     AND s.volume_relative IS NOT NULL
    GROUP BY tv.keyword
  ),
  post AS (
    SELECT
      tv.keyword,
      AVG(s.volume_relative)::numeric AS post_avg,
      STDDEV_POP(s.volume_relative)::numeric AS stddev_post,
      COUNT(*)::int AS sample_post,
      ARRAY_AGG(DISTINCT s.source) FILTER (WHERE s.source IS NOT NULL) AS search_sources
    FROM tv
    LEFT JOIN jimscanner_trends_keywords s
      ON s.keyword = tv.keyword
     AND s.source IN ('naver_search_trend', 'naver_shopping_insight')
     AND s.collected_at >= tv.first_seen
     AND s.collected_at <= tv.first_seen + (window_days || ' days')::interval
     AND s.volume_relative IS NOT NULL
    GROUP BY tv.keyword
  )
  SELECT
    tv.keyword,
    tv.tv_count,
    tv.first_seen,
    tv.last_seen,
    pre.pre_avg,
    post.post_avg,
    CASE
      WHEN pre.pre_avg IS NULL OR pre.pre_avg = 0 THEN NULL
      ELSE (post.post_avg / pre.pre_avg)::numeric
    END AS lift,
    post.stddev_post,
    COALESCE(pre.sample_pre, 0) AS sample_pre,
    COALESCE(post.sample_post, 0) AS sample_post,
    COALESCE(post.search_sources, ARRAY[]::text[]) AS search_sources
  FROM tv
  LEFT JOIN pre  ON pre.keyword  = tv.keyword
  LEFT JOIN post ON post.keyword = tv.keyword
  ORDER BY
    -- lift 높은 순, 표본 부족한 키워드는 뒤로
    (CASE WHEN pre.pre_avg IS NULL OR pre.pre_avg = 0 THEN 0 ELSE 1 END) DESC,
    (CASE WHEN pre.pre_avg IS NULL OR pre.pre_avg = 0 THEN 0
          ELSE post.post_avg / pre.pre_avg END) DESC NULLS LAST,
    tv.tv_count DESC
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_tv_lift(int, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_tv_lift(int, int, int) TO service_role;


-- ────────────────────────────────────────────────────────────
-- ggsan 추천 RPC v0.1 — lift 항 추가
-- ────────────────────────────────────────────────────────────
-- final_score = (tv_score × 1.5 + search_score × 1.0)
--               × imminent_bonus
--               × (1 + LN(GREATEST(lift, 1)))
--
-- lift 는 매칭된 TV 키워드들의 MAX 값 (가장 폭발한 키워드 기준).
-- lift NULL/0 일 때는 1.0 으로 처리해 가산 없음.
-- ────────────────────────────────────────────────────────────

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
  tv_score real,
  search_score real,
  raw_score real,
  imminent_bonus real,
  lift_score real,
  final_score real,
  tv_match_count int,
  tv_top_keyword text,
  tv_total_pushes int,
  tv_best_lift real,
  search_match_count int,
  search_top_keyword text,
  search_sources text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  tv_keywords AS (
    SELECT keyword, COUNT(*)::int AS tv_count,
           MIN(collected_at) AS first_seen
    FROM jimscanner_trends_keywords
    WHERE source = 'naver_tvtime'
      AND collected_at > now() - (days_window || ' days')::interval
    GROUP BY keyword
  ),
  -- ±7일 lift 계산 (위 RPC 와 동일 로직, 인라인)
  tv_lift AS (
    SELECT
      tv.keyword,
      CASE
        WHEN pre.pre_avg IS NULL OR pre.pre_avg = 0 THEN NULL
        ELSE (post.post_avg / pre.pre_avg)
      END::real AS lift
    FROM tv_keywords tv
    LEFT JOIN LATERAL (
      SELECT AVG(s.volume_relative) AS pre_avg
      FROM jimscanner_trends_keywords s
      WHERE s.keyword = tv.keyword
        AND s.source IN ('naver_search_trend','naver_shopping_insight')
        AND s.collected_at >= tv.first_seen - interval '7 days'
        AND s.collected_at <  tv.first_seen
        AND s.volume_relative IS NOT NULL
    ) pre ON true
    LEFT JOIN LATERAL (
      SELECT AVG(s.volume_relative) AS post_avg
      FROM jimscanner_trends_keywords s
      WHERE s.keyword = tv.keyword
        AND s.source IN ('naver_search_trend','naver_shopping_insight')
        AND s.collected_at >= tv.first_seen
        AND s.collected_at <= tv.first_seen + interval '7 days'
        AND s.volume_relative IS NOT NULL
    ) post ON true
  ),
  tv_matches AS (
    SELECT
      gp.goods_no,
      tv.keyword AS tv_keyword,
      tv.tv_count,
      similarity(tv.keyword, gp.title) AS sim,
      tv.tv_count::real * similarity(tv.keyword, gp.title) AS strength,
      COALESCE(tl.lift, 1.0)::real AS lift
    FROM tv_keywords tv
    LEFT JOIN tv_lift tl ON tl.keyword = tv.keyword
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
      (ARRAY_AGG(tv_keyword ORDER BY strength DESC))[1] AS tv_top_keyword,
      MAX(lift)::real AS tv_best_lift
    FROM tv_matches
    GROUP BY goods_no
  ),

  search_keywords AS (
    SELECT keyword, source, COUNT(*)::int AS occurrences
    FROM jimscanner_trends_keywords
    WHERE source IN (
      'naver_shopping_hot','naver_search_trend','aliex_best','musinsa_best'
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

  scored AS (
    SELECT
      gp.goods_no, gp.title, gp.cate_cd, gp.cate_label, gp.price_krw,
      gp.is_imminent, gp.image_url, gp.detail_url, gp.last_seen_at,
      COALESCE(tv.tv_score, 0)::real AS tv_score,
      COALESCE(s.search_score, 0)::real AS search_score,
      COALESCE(tv.tv_match_count, 0) AS tv_match_count,
      COALESCE(tv.tv_top_keyword, '') AS tv_top_keyword,
      COALESCE(tv.tv_total_pushes, 0) AS tv_total_pushes,
      COALESCE(tv.tv_best_lift, 1.0)::real AS tv_best_lift,
      COALESCE(s.search_match_count, 0) AS search_match_count,
      COALESCE(s.search_top_keyword, '') AS search_top_keyword,
      COALESCE(s.search_sources, ARRAY[]::text[]) AS search_sources
    FROM jimscanner_ggsan_products gp
    LEFT JOIN tv_agg tv ON tv.goods_no = gp.goods_no
    LEFT JOIN search_agg s ON s.goods_no = gp.goods_no
    WHERE tv.tv_score IS NOT NULL OR s.search_score IS NOT NULL
  )

  SELECT
    s.goods_no,
    s.title,
    s.cate_cd,
    s.cate_label,
    s.price_krw,
    s.is_imminent,
    s.image_url,
    s.detail_url,
    s.last_seen_at AS ggsan_last_seen,
    s.tv_score,
    s.search_score,
    (s.tv_score * 1.5 + s.search_score * 1.0)::real AS raw_score,
    (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)::real AS imminent_bonus,
    (1.0 + LN(GREATEST(s.tv_best_lift, 1.0)))::real AS lift_score,
    ((s.tv_score * 1.5 + s.search_score * 1.0)
       * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)
       * (1.0 + LN(GREATEST(s.tv_best_lift, 1.0))))::real AS final_score,
    s.tv_match_count,
    s.tv_top_keyword,
    s.tv_total_pushes,
    s.tv_best_lift,
    s.search_match_count,
    s.search_top_keyword,
    s.search_sources
  FROM scored s
  WHERE ((s.tv_score * 1.5 + s.search_score * 1.0)
           * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)
           * (1.0 + LN(GREATEST(s.tv_best_lift, 1.0)))) >= min_score
  ORDER BY
    (CASE WHEN s.is_imminent THEN 1 ELSE 0 END) DESC,
    ((s.tv_score * 1.5 + s.search_score * 1.0)
       * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)
       * (1.0 + LN(GREATEST(s.tv_best_lift, 1.0)))) DESC
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_ggsan_recommend(int, float, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_ggsan_recommend(int, float, float, int) TO service_role;
