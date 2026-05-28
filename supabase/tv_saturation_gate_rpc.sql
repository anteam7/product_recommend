-- ────────────────────────────────────────────────────────────
-- TV 편성 포화도 역게이트 RPC (TV-Quiet Niche, 2026-05-29)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/tv-quiet 페이지
-- 가설: TV홈쇼핑 과노출 카테고리는 대형 셀러·브랜드가 광고비로 장악한
--       레드오션. 소형 위탁 셀러에겐 진입 함정.
--   → TV편성을 '경쟁압 프록시'로 뒤집어, '수요 높음 × TV편성 낮음'
--     (=대형사 무관심 조용한 틈새) 사분면을 발굴한다.
--
-- 산출:
--   search_demand : 검색·쇼핑 시그널 강도 (수요 프록시)
--   tv_push       : naver_tvtime 30일 누적 편성 강도 (경쟁압 프록시)
--   *_pctile      : 결과 집합 내 백분위 (0~1, percent_rank)
--   tv_quiet_score: search_pctile - tv_pctile
--                   (+1 = 수요는 최상위인데 TV편성은 최하위 = 황금 틈새)
--                   (-1 = TV 포화 레드오션, 진입 함정)
--
-- recommend RPC 와 달리 TV 가점을 '경고'로 재해석 — 동일 trigram 매칭
-- 구조를 재사용하되 점수 합성 방향만 뒤집음.
-- service_role 로만 호출 (어드민 한정) — SECURITY DEFINER + grant 명시.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_tv_saturation_gate(
  days_window int DEFAULT 30,
  min_sim float DEFAULT 0.20,
  result_limit int DEFAULT 200
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
  -- 2축 원시값
  search_demand real,
  tv_push real,
  -- 백분위 (결과 집합 내)
  search_pctile real,
  tv_pctile real,
  -- 역게이트 점수
  tv_quiet_score real,
  -- 사분면 라벨 (quiet_niche / hot_redocean / low_demand / contested)
  quadrant text,
  -- 매칭 근거
  search_match_count int,
  search_top_keyword text,
  search_sources text[],
  tv_match_count int,
  tv_top_keyword text,
  tv_total_pushes int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  -- 1) TV 편성 키워드 (경쟁압 프록시)
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
      SUM(strength)::real AS tv_push,
      COUNT(DISTINCT tv_keyword)::int AS tv_match_count,
      SUM(tv_count)::int AS tv_total_pushes,
      (ARRAY_AGG(tv_keyword ORDER BY strength DESC))[1] AS tv_top_keyword
    FROM tv_matches
    GROUP BY goods_no
  ),

  -- 2) 검색·쇼핑 키워드 (수요 프록시)
  search_keywords AS (
    SELECT keyword, source, COUNT(*)::int AS occurrences
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
      SUM(strength)::real AS search_demand,
      COUNT(DISTINCT search_keyword)::int AS search_match_count,
      (ARRAY_AGG(search_keyword ORDER BY strength DESC))[1] AS search_top_keyword,
      ARRAY_AGG(DISTINCT source) AS search_sources
    FROM search_matches
    GROUP BY goods_no
  ),

  -- 3) ggsan 상품 단위 2축 결합 (수요 시그널이 있는 것만 — 틈새 후보군)
  scored AS (
    SELECT
      gp.goods_no, gp.title, gp.cate_cd, gp.cate_label, gp.price_krw,
      gp.is_imminent, gp.image_url, gp.detail_url, gp.last_seen_at,
      COALESCE(s.search_demand, 0)::real AS search_demand,
      COALESCE(tv.tv_push, 0)::real AS tv_push,
      COALESCE(s.search_match_count, 0) AS search_match_count,
      COALESCE(s.search_top_keyword, '') AS search_top_keyword,
      COALESCE(s.search_sources, ARRAY[]::text[]) AS search_sources,
      COALESCE(tv.tv_match_count, 0) AS tv_match_count,
      COALESCE(tv.tv_top_keyword, '') AS tv_top_keyword,
      COALESCE(tv.tv_total_pushes, 0) AS tv_total_pushes
    FROM jimscanner_ggsan_products gp
    JOIN search_agg s ON s.goods_no = gp.goods_no
    LEFT JOIN tv_agg tv ON tv.goods_no = gp.goods_no
  ),
  -- 4) 결과 집합 내 백분위 산출 (percent_rank: 0~1)
  ranked AS (
    SELECT
      *,
      percent_rank() OVER (ORDER BY search_demand)::real AS search_pctile,
      percent_rank() OVER (ORDER BY tv_push)::real AS tv_pctile
    FROM scored
  )

  SELECT
    r.goods_no,
    r.title,
    r.cate_cd,
    r.cate_label,
    r.price_krw,
    r.is_imminent,
    r.image_url,
    r.detail_url,
    r.last_seen_at AS ggsan_last_seen,
    r.search_demand,
    r.tv_push,
    r.search_pctile,
    r.tv_pctile,
    (r.search_pctile - r.tv_pctile)::real AS tv_quiet_score,
    (CASE
      WHEN r.search_pctile >= 0.5 AND r.tv_pctile <  0.5 THEN 'quiet_niche'   -- 황금: 수요↑ TV↓
      WHEN r.search_pctile >= 0.5 AND r.tv_pctile >= 0.5 THEN 'hot_redocean'  -- 레드오션: 수요↑ TV↑
      WHEN r.search_pctile <  0.5 AND r.tv_pctile <  0.5 THEN 'low_demand'    -- 한산: 수요↓ TV↓
      ELSE 'contested'                                                        -- 함정: 수요↓ TV↑
    END) AS quadrant,
    r.search_match_count,
    r.search_top_keyword,
    r.search_sources,
    r.tv_match_count,
    r.tv_top_keyword,
    r.tv_total_pushes
  FROM ranked r
  ORDER BY (r.search_pctile - r.tv_pctile) DESC, r.search_demand DESC
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출 (anon/authenticated 차단)
REVOKE ALL ON FUNCTION jimscanner_tv_saturation_gate(int, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_tv_saturation_gate(int, float, int) TO service_role;
