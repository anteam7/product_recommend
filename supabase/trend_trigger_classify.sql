-- ────────────────────────────────────────────────────────────
-- 트렌드 촉발원인 분류 RPC (V0, 2026-06-03)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/triggers
-- 목적: "얼마나 뜨는가"(4-스코어)에 더해 "왜 뜨며 얼마나 갈까"를 데이터화.
--   상승 중인 jimscanner_trends_products 별로 '근거 출처 믹스'를 결합해
--   지배적 '촉발 아키타입'을 분류하고, 그에 따른 '지속성 등급'과
--   권장 '소싱 포스처'를 산출한다.
--
-- 입력 신호 (모두 product 의 alias text 기준 trigram 매칭):
--   1) TV 출연      : jimscanner_trends_keywords (source='naver_tvtime')
--   2) 뉴스·규제     : jimscanner_market_raw      (source IN 'naver_news','kca_press')
--   3) 커뮤니티·밈   : jimscanner_market_raw      (source IN 'clien_park','quasarzone_sale')
--   4) 검색 유기     : jimscanner_trends_keywords (source IN 'naver_search_trend','naver_shopping_hot')
--   + alias.source 분포 (각 신호의 직접 가중)
--   + 계절          : canonical_name / alias 의 시즌 키워드 휴리스틱
--
-- 출력: product 단위로 지배 아키타입 + 지속성 등급(1 플래시 ~ 4 구조적) + 소싱 포스처.
--   결과는 jimscanner_trends_scores.score_components 의 trigger_archetype/durability
--   키로도 백필 가능(별도 routine). 본 RPC 는 read-only 조회용.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_trend_trigger_classify(
  days_window int DEFAULT 30,
  min_sim float DEFAULT 0.30,
  min_final_score float DEFAULT 0.0,
  result_limit int DEFAULT 300
)
RETURNS TABLE (
  product_id uuid,
  canonical_name text,
  category_top text,
  final_score numeric,
  trend_score numeric,
  -- 신호별 raw 강도
  tv_signal real,
  news_signal real,
  community_signal real,
  search_signal real,
  season_signal real,
  -- alias source 분포 (디버깅·UI breakdown)
  alias_count int,
  alias_sources text[],
  -- 분류 결과
  trigger_archetype text,   -- 'tv' | 'news' | 'community' | 'search' | 'season'
  durability int,           -- 1 플래시 ~ 4 구조적 (season 은 4 = 주기적)
  durability_label text,
  sourcing_posture text,    -- 'shallow_fast' | 'medium' | 'deep_long'
  top_evidence text         -- 가장 강한 매칭 근거 (키워드/제목)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  -- 최신 score (product 별 latest computed_at)
  latest_scores AS (
    SELECT DISTINCT ON (s.product_id)
      s.product_id, s.final_score, s.trend_score, s.computed_at
    FROM jimscanner_trends_scores s
    ORDER BY s.product_id, s.computed_at DESC
  ),
  -- 분류 대상 product (최신 score 있고, 임계 이상)
  prods AS (
    SELECT p.id, p.canonical_name, p.category_top, p.alias_count,
           ls.final_score, ls.trend_score
    FROM jimscanner_trends_products p
    JOIN latest_scores ls ON ls.product_id = p.id
    WHERE ls.final_score >= min_final_score
  ),
  -- product 의 alias text + 직접 source 분포
  aliases AS (
    SELECT a.product_id, a.alias, COALESCE(a.source, '') AS source
    FROM jimscanner_trends_aliases a
    WHERE a.product_id IN (SELECT id FROM prods)
  ),
  alias_source_dist AS (
    SELECT product_id, ARRAY_AGG(DISTINCT source) FILTER (WHERE source <> '') AS sources
    FROM aliases
    GROUP BY product_id
  ),

  -- 1) TV 출연 신호 (alias ↔ naver_tvtime trigram)
  tv_kw AS (
    SELECT keyword, COUNT(*)::int AS occ
    FROM jimscanner_trends_keywords
    WHERE source = 'naver_tvtime'
      AND collected_at > now() - (days_window || ' days')::interval
    GROUP BY keyword
  ),
  tv_match AS (
    SELECT a.product_id,
           SUM(t.occ * similarity(a.alias, t.keyword))::real AS sig,
           (ARRAY_AGG(t.keyword ORDER BY t.occ * similarity(a.alias, t.keyword) DESC))[1] AS top_kw
    FROM aliases a
    JOIN tv_kw t ON a.alias % t.keyword AND similarity(a.alias, t.keyword) >= min_sim
    GROUP BY a.product_id
  ),

  -- 4) 검색 유기 신호 (alias ↔ naver_search_trend / naver_shopping_hot)
  search_kw AS (
    SELECT keyword, COUNT(*)::int AS occ
    FROM jimscanner_trends_keywords
    WHERE source IN ('naver_search_trend', 'naver_shopping_hot')
      AND collected_at > now() - (days_window || ' days')::interval
    GROUP BY keyword
  ),
  search_match AS (
    SELECT a.product_id,
           SUM(s.occ * similarity(a.alias, s.keyword))::real AS sig,
           (ARRAY_AGG(s.keyword ORDER BY s.occ * similarity(a.alias, s.keyword) DESC))[1] AS top_kw
    FROM aliases a
    JOIN search_kw s ON a.alias % s.keyword AND similarity(a.alias, s.keyword) >= min_sim
    GROUP BY a.product_id
  ),

  -- 2/3) 뉴스·규제 / 커뮤니티·밈 (alias ↔ market_raw title trigram)
  raw_rows AS (
    SELECT source, title
    FROM jimscanner_market_raw
    WHERE source IN ('naver_news', 'kca_press', 'clien_park', 'quasarzone_sale')
      AND title IS NOT NULL
      AND captured_at > now() - (days_window || ' days')::interval
  ),
  news_match AS (
    SELECT a.product_id,
           SUM(similarity(a.alias, r.title))::real AS sig,
           (ARRAY_AGG(r.title ORDER BY similarity(a.alias, r.title) DESC))[1] AS top_t
    FROM aliases a
    JOIN raw_rows r ON r.source IN ('naver_news', 'kca_press')
      AND a.alias % r.title AND similarity(a.alias, r.title) >= min_sim
    GROUP BY a.product_id
  ),
  community_match AS (
    SELECT a.product_id,
           SUM(similarity(a.alias, r.title))::real AS sig,
           (ARRAY_AGG(r.title ORDER BY similarity(a.alias, r.title) DESC))[1] AS top_t
    FROM aliases a
    JOIN raw_rows r ON r.source IN ('clien_park', 'quasarzone_sale')
      AND a.alias % r.title AND similarity(a.alias, r.title) >= min_sim
    GROUP BY a.product_id
  ),

  -- 5) 계절 신호 (휴리스틱: canonical_name 에 시즌 키워드 포함)
  season_match AS (
    SELECT p.id AS product_id,
           CASE WHEN p.canonical_name ~ '(여름|겨울|봄|가을|장마|폭염|크리스마스|설|추석|블프|광군제|난방|제습|선풍기|히터|패딩|반팔|모기|꽃가루|미세먼지)'
                THEN 1.0 ELSE 0.0 END::real AS sig
    FROM prods p
  ),

  -- 신호 결합
  combined AS (
    SELECT
      p.id AS product_id, p.canonical_name, p.category_top, p.alias_count,
      p.final_score, p.trend_score,
      COALESCE(tv.sig, 0)::real AS tv_signal,
      COALESCE(nw.sig, 0)::real AS news_signal,
      COALESCE(cm.sig, 0)::real AS community_signal,
      COALESCE(se.sig, 0)::real AS search_signal,
      COALESCE(ss.sig, 0)::real AS season_signal,
      COALESCE(asd.sources, ARRAY[]::text[]) AS alias_sources,
      tv.top_kw AS tv_top, se.top_kw AS search_top,
      nw.top_t AS news_top, cm.top_t AS community_top
    FROM prods p
    LEFT JOIN tv_match tv ON tv.product_id = p.id
    LEFT JOIN search_match se ON se.product_id = p.id
    LEFT JOIN news_match nw ON nw.product_id = p.id
    LEFT JOIN community_match cm ON cm.product_id = p.id
    LEFT JOIN season_match ss ON ss.product_id = p.id
    LEFT JOIN alias_source_dist asd ON asd.product_id = p.id
  ),
  -- 지배 아키타입 선정 (가중 후 argmax). TV·뉴스에 약간의 가중치.
  classified AS (
    SELECT c.*,
      (CASE
        WHEN c.tv_signal * 1.3 >= GREATEST(c.news_signal * 1.2, c.community_signal, c.search_signal, c.season_signal * 0.8)
             AND c.tv_signal > 0 THEN 'tv'
        WHEN c.news_signal * 1.2 >= GREATEST(c.tv_signal * 1.3, c.community_signal, c.search_signal, c.season_signal * 0.8)
             AND c.news_signal > 0 THEN 'news'
        WHEN c.community_signal >= GREATEST(c.tv_signal * 1.3, c.news_signal * 1.2, c.search_signal, c.season_signal * 0.8)
             AND c.community_signal > 0 THEN 'community'
        WHEN c.season_signal * 0.8 >= GREATEST(c.tv_signal * 1.3, c.news_signal * 1.2, c.community_signal, c.search_signal)
             AND c.season_signal > 0 THEN 'season'
        WHEN c.search_signal > 0 THEN 'search'
        ELSE 'search'   -- 신호 없으면 기본 검색유기 (가장 보수적)
      END) AS archetype
    FROM combined c
  )
  SELECT
    cl.product_id,
    cl.canonical_name,
    cl.category_top,
    cl.final_score,
    cl.trend_score,
    cl.tv_signal,
    cl.news_signal,
    cl.community_signal,
    cl.search_signal,
    cl.season_signal,
    cl.alias_count,
    cl.alias_sources,
    cl.archetype AS trigger_archetype,
    (CASE cl.archetype
      WHEN 'tv'        THEN 1   -- 플래시 (스파이크형 단기 소진)
      WHEN 'community' THEN 2   -- 입소문·밈 (단기~중기)
      WHEN 'search'    THEN 3   -- 검색유기 (중기)
      WHEN 'news'      THEN 4   -- 뉴스·규제 (구조적·장기)
      WHEN 'season'    THEN 4   -- 계절 (주기적 = 구조적 취급)
      ELSE 3
    END)::int AS durability,
    (CASE cl.archetype
      WHEN 'tv'        THEN '플래시'
      WHEN 'community' THEN '입소문'
      WHEN 'search'    THEN '점진'
      WHEN 'news'      THEN '구조적'
      WHEN 'season'    THEN '주기적'
      ELSE '점진'
    END) AS durability_label,
    (CASE cl.archetype
      WHEN 'tv'        THEN 'shallow_fast'  -- 얕게-빠르게 (단기 소진형)
      WHEN 'community' THEN 'shallow_fast'
      WHEN 'search'    THEN 'medium'
      WHEN 'news'      THEN 'deep_long'     -- 깊게-길게 (구조적 수요)
      WHEN 'season'    THEN 'deep_long'
      ELSE 'medium'
    END) AS sourcing_posture,
    COALESCE(
      CASE cl.archetype
        WHEN 'tv'        THEN cl.tv_top
        WHEN 'search'    THEN cl.search_top
        WHEN 'news'      THEN cl.news_top
        WHEN 'community' THEN cl.community_top
        ELSE NULL
      END, '') AS top_evidence
  FROM classified cl
  ORDER BY cl.final_score DESC, cl.trend_score DESC
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출 (기존 jimscanner_* RPC 정책과 동일)
REVOKE ALL ON FUNCTION jimscanner_trend_trigger_classify(int, float, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_trend_trigger_classify(int, float, float, int) TO service_role;
