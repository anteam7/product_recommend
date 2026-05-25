-- ────────────────────────────────────────────────────────────
-- ggsan 위탁 후보 추천 RPC (V0, 2026-05-11)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/recommend
-- 입력 신호:
--   1) TV 편성 (jimscanner_trends_keywords, source='naver_tvtime')
--   2) 검색·쇼핑 (source IN naver_shopping_hot, naver_search_trend, aliex_best, musinsa_best)
--   3) 임박특가 플래그 (jimscanner_ggsan_products.is_imminent)
-- 출력: ggsan 상품 단위, 각 점수와 매칭 근거 펼침
-- V1 보강 예정: 스마트스토어 등록상품수(saturation_penalty), 커뮤니티 시그널, 가격 인하 추세
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
  -- 점수 분해
  tv_score real,
  search_score real,
  raw_score real,
  imminent_bonus real,
  final_score real,
  -- 매칭 근거
  tv_match_count int,
  tv_top_keyword text,
  tv_total_pushes int,
  search_match_count int,
  search_top_keyword text,
  search_sources text[],
  -- SERP 광고밀도 게이트 (2026-05-25 추가)
  -- 매칭된 키워드 중 SERP 광고 점유율이 가장 높은 값. 0.6+ 면 organic 진입 불가로 디스카운트
  serp_ad_density real,
  serp_gate_keyword text,
  serp_gate_blocked boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  -- 1) TV 편성 키워드 (30일 누적, source=naver_tvtime)
  tv_keywords AS (
    SELECT keyword, COUNT(*)::int AS tv_count
    FROM jimscanner_trends_keywords
    WHERE source = 'naver_tvtime'
      AND collected_at > now() - (days_window || ' days')::interval
    GROUP BY keyword
  ),
  -- 2) TV ↔ ggsan trigram 매칭 (ggsan title gin_trgm 인덱스 활용)
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

  -- 3) 검색·쇼핑 키워드 (수요 측 시그널)
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
  -- 4) 검색 ↔ ggsan trigram 매칭
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

  -- 5) ggsan 상품에 점수 매핑 (시그널 1개 이상 있는 것만)
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
      -- SERP 광고밀도 게이트: 매칭된 TV/search 키워드 중 ad_density 가장 높은 값
      (
        SELECT COALESCE(MAX(d.ad_density), 0)::real
        FROM jimscanner_serp_density_latest d
        WHERE d.keyword IN (
          COALESCE(tv.tv_top_keyword, ''),
          COALESCE(s.search_top_keyword, '')
        )
      ) AS serp_ad_density,
      (
        SELECT d.keyword
        FROM jimscanner_serp_density_latest d
        WHERE d.keyword IN (
          COALESCE(tv.tv_top_keyword, ''),
          COALESCE(s.search_top_keyword, '')
        )
        ORDER BY d.ad_density DESC NULLS LAST
        LIMIT 1
      ) AS serp_gate_keyword
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
    ((s.tv_score * 1.5 + s.search_score * 1.0)
       * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END))::real AS final_score,
    s.tv_match_count,
    s.tv_top_keyword,
    s.tv_total_pushes,
    s.search_match_count,
    s.search_top_keyword,
    s.search_sources,
    s.serp_ad_density,
    s.serp_gate_keyword,
    (s.serp_ad_density >= 0.6) AS serp_gate_blocked
  FROM scored s
  WHERE ((s.tv_score * 1.5 + s.search_score * 1.0)
           * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)) >= min_score
  ORDER BY
    -- SERP 광고로 도배된 키워드는 뒤로
    (CASE WHEN s.serp_ad_density >= 0.6 THEN 1 ELSE 0 END) ASC,
    -- 임박특가 우선
    (CASE WHEN s.is_imminent THEN 1 ELSE 0 END) DESC,
    -- final_score
    ((s.tv_score * 1.5 + s.search_score * 1.0)
       * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)) DESC
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출
REVOKE ALL ON FUNCTION jimscanner_ggsan_recommend(int, float, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_ggsan_recommend(int, float, float, int) TO service_role;
