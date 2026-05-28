-- 다중소스 교차검증 코로보레이션 레이더 — 2026-05-28
-- 지난 14일 키워드별 독립 소스 발화 강도를 0~1 정규화한 8축 레이더 + Corroboration Score.
-- 단일 소스 스파이크 노이즈를 다양성 지수로 솎아내기 위한 신뢰점수.
--
-- 8축:
--   1) naver_search_trend       (DataLab 검색량)
--   2) naver_shopping_insight   (DataLab 쇼핑랭킹)
--   3) naver_tvtime             (홈쇼핑 편성 push)
--   4) naver_news               (뉴스 노출)
--   5) naver_blog               (블로그 노출)
--   6) google_suggest           (구글 자동완성 등장)
--   7) quasarzone_sale          (커뮤니티 핫딜 회자)
--   8) clien_park               (클리언/뽐뿌 회자)
--
-- score = weighted sum × (1 + diversity_bonus) — Herfindahl 역수로 다양성 보정.

-- ─────────────────────────────────────────
-- raw materialized view (집계 비용 큼 → cron 15분마다 refresh)

DROP MATERIALIZED VIEW IF EXISTS jimscanner_trend_corroboration_mv CASCADE;

CREATE MATERIALIZED VIEW jimscanner_trend_corroboration_mv AS
WITH recent_keywords AS (
  SELECT lower(trim(keyword)) AS keyword_norm,
         (array_agg(keyword ORDER BY collected_at DESC))[1] AS keyword,
         source,
         count(*) AS cnt
  FROM jimscanner_trends_keywords
  WHERE collected_at >= now() - interval '14 days'
    AND keyword IS NOT NULL
    AND length(trim(keyword)) >= 2
  GROUP BY lower(trim(keyword)), source
),
recent_market AS (
  SELECT lower(trim(coalesce(query, title))) AS keyword_norm,
         (array_agg(coalesce(query, title) ORDER BY captured_at DESC))[1] AS keyword,
         source,
         count(*) AS cnt
  FROM jimscanner_market_raw
  WHERE captured_at >= now() - interval '14 days'
    AND coalesce(query, title) IS NOT NULL
    AND length(trim(coalesce(query, title))) >= 2
  GROUP BY lower(trim(coalesce(query, title))), source
),
all_sigs AS (
  SELECT keyword_norm, keyword, source, cnt FROM recent_keywords
  UNION ALL
  SELECT keyword_norm, keyword, source, cnt FROM recent_market
),
per_keyword AS (
  SELECT keyword_norm,
         (array_agg(keyword ORDER BY cnt DESC))[1] AS keyword,
         coalesce(sum(cnt) FILTER (WHERE source = 'naver_search_trend'), 0)     AS s_search,
         coalesce(sum(cnt) FILTER (WHERE source = 'naver_shopping_insight'), 0) AS s_shop,
         coalesce(sum(cnt) FILTER (WHERE source = 'naver_tvtime'), 0)           AS s_tv,
         coalesce(sum(cnt) FILTER (WHERE source = 'naver_news'), 0)             AS s_news,
         coalesce(sum(cnt) FILTER (WHERE source = 'naver_blog'), 0)             AS s_blog,
         coalesce(sum(cnt) FILTER (WHERE source = 'google_suggest'), 0)         AS s_suggest,
         coalesce(sum(cnt) FILTER (WHERE source = 'quasarzone_sale'), 0)        AS s_quasar,
         coalesce(sum(cnt) FILTER (WHERE source = 'clien_park'), 0)             AS s_clien
  FROM all_sigs
  GROUP BY keyword_norm
),
maxes AS (
  SELECT
    greatest(max(s_search),    1) AS m_search,
    greatest(max(s_shop),      1) AS m_shop,
    greatest(max(s_tv),        1) AS m_tv,
    greatest(max(s_news),      1) AS m_news,
    greatest(max(s_blog),      1) AS m_blog,
    greatest(max(s_suggest),   1) AS m_suggest,
    greatest(max(s_quasar),    1) AS m_quasar,
    greatest(max(s_clien),     1) AS m_clien
  FROM per_keyword
),
normalized AS (
  SELECT
    p.keyword_norm,
    p.keyword,
    least(1.0, p.s_search::numeric  / m.m_search)  AS a_search,
    least(1.0, p.s_shop::numeric    / m.m_shop)    AS a_shop,
    least(1.0, p.s_tv::numeric      / m.m_tv)      AS a_tv,
    least(1.0, p.s_news::numeric    / m.m_news)    AS a_news,
    least(1.0, p.s_blog::numeric    / m.m_blog)    AS a_blog,
    least(1.0, p.s_suggest::numeric / m.m_suggest) AS a_suggest,
    least(1.0, p.s_quasar::numeric  / m.m_quasar)  AS a_quasar,
    least(1.0, p.s_clien::numeric   / m.m_clien)   AS a_clien,
    p.s_search, p.s_shop, p.s_tv, p.s_news, p.s_blog, p.s_suggest, p.s_quasar, p.s_clien
  FROM per_keyword p CROSS JOIN maxes m
),
scored AS (
  SELECT
    keyword,
    keyword_norm,
    a_search, a_shop, a_tv, a_news, a_blog, a_suggest, a_quasar, a_clien,
    s_search, s_shop, s_tv, s_news, s_blog, s_suggest, s_quasar, s_clien,
    -- 8축 중 0.05 임계 초과한 소스 개수
    ((a_search  > 0.05)::int
   + (a_shop    > 0.05)::int
   + (a_tv      > 0.05)::int
   + (a_news    > 0.05)::int
   + (a_blog    > 0.05)::int
   + (a_suggest > 0.05)::int
   + (a_quasar  > 0.05)::int
   + (a_clien   > 0.05)::int) AS source_count,
    (a_search + a_shop + a_tv + a_news + a_blog + a_suggest + a_quasar + a_clien) AS axis_sum
  FROM normalized
)
SELECT
  keyword,
  keyword_norm,
  source_count,
  -- diversity_index = 1 - HHI(축비율) — 1 에 가까울수록 여러 축이 균등하게 외친 신호
  CASE WHEN axis_sum > 0 THEN
    1.0 - (
        power(a_search  / axis_sum, 2)
      + power(a_shop    / axis_sum, 2)
      + power(a_tv      / axis_sum, 2)
      + power(a_news    / axis_sum, 2)
      + power(a_blog    / axis_sum, 2)
      + power(a_suggest / axis_sum, 2)
      + power(a_quasar  / axis_sum, 2)
      + power(a_clien   / axis_sum, 2)
    )
  ELSE 0.0 END AS diversity_index,
  -- score = weighted sum of normalized axes × (1 + diversity bonus)
  -- 가중치: search/shop 이 의도-증거로 가장 무거움, tv/news 중간, blog/suggest/quasar/clien 보조.
  round(
    (
      (a_search  * 1.5
     + a_shop    * 1.3
     + a_tv      * 1.1
     + a_news    * 1.0
     + a_blog    * 0.7
     + a_suggest * 0.9
     + a_quasar  * 0.8
     + a_clien   * 0.7
      )
      *
      (1.0 + CASE WHEN axis_sum > 0 THEN
        1.0 - (
            power(a_search  / axis_sum, 2)
          + power(a_shop    / axis_sum, 2)
          + power(a_tv      / axis_sum, 2)
          + power(a_news    / axis_sum, 2)
          + power(a_blog    / axis_sum, 2)
          + power(a_suggest / axis_sum, 2)
          + power(a_quasar  / axis_sum, 2)
          + power(a_clien   / axis_sum, 2)
        )
      ELSE 0.0 END)
    )::numeric, 4
  ) AS score,
  jsonb_build_object(
    'naver_search_trend',     jsonb_build_object('norm', round(a_search::numeric, 3),  'raw', s_search),
    'naver_shopping_insight', jsonb_build_object('norm', round(a_shop::numeric, 3),    'raw', s_shop),
    'naver_tvtime',           jsonb_build_object('norm', round(a_tv::numeric, 3),      'raw', s_tv),
    'naver_news',             jsonb_build_object('norm', round(a_news::numeric, 3),    'raw', s_news),
    'naver_blog',             jsonb_build_object('norm', round(a_blog::numeric, 3),    'raw', s_blog),
    'google_suggest',         jsonb_build_object('norm', round(a_suggest::numeric, 3), 'raw', s_suggest),
    'quasarzone_sale',        jsonb_build_object('norm', round(a_quasar::numeric, 3),  'raw', s_quasar),
    'clien_park',             jsonb_build_object('norm', round(a_clien::numeric, 3),   'raw', s_clien)
  ) AS axis_json,
  now() AS refreshed_at
FROM scored
WHERE source_count >= 1;

CREATE UNIQUE INDEX IF NOT EXISTS jimscanner_trend_corroboration_mv_kw
  ON jimscanner_trend_corroboration_mv (keyword_norm);
CREATE INDEX IF NOT EXISTS jimscanner_trend_corroboration_mv_score
  ON jimscanner_trend_corroboration_mv (score DESC);

-- 편의용 view — 외부에서 안정적인 이름으로 query.
CREATE OR REPLACE VIEW jimscanner_trend_corroboration AS
  SELECT * FROM jimscanner_trend_corroboration_mv;

GRANT SELECT ON jimscanner_trend_corroboration TO service_role;
GRANT SELECT ON jimscanner_trend_corroboration_mv TO service_role;

-- ─────────────────────────────────────────
-- refresh helper — concurrently 필요시 unique index 가 있으므로 가능.
CREATE OR REPLACE FUNCTION refresh_trend_corroboration()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY jimscanner_trend_corroboration_mv;
END;
$$ LANGUAGE plpgsql;
