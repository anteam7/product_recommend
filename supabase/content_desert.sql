-- ─────────────────────────────────────────────────────────────
-- Content Desert MV — 수요-콘텐츠 비대칭 SEO 사각지대 발굴
-- 2026-05-20
-- ─────────────────────────────────────────────────────────────
-- 키워드별 수요(volume_relative) 와 한국어 콘텐츠 풍부도
-- (naver_blog · naver_news · google_suggest 빈도 + 자체 블로그)
-- 를 결합해 gap_score = demand_z - ln(1 + content_count) 계산.
--
-- 필터: classify-trends-llm 분류 끝난 키워드만 (=keyword 가 alias 로
--       연결된 product 의 llm_classified_at IS NOT NULL).
--
-- 갱신: cron 1회/일, REFRESH MATERIALIZED VIEW.
-- 노출: 어드민 한정 (RLS X, service-role).
-- ─────────────────────────────────────────────────────────────

DROP MATERIALIZED VIEW IF EXISTS public.jimscanner_content_gap_v;

CREATE MATERIALIZED VIEW public.jimscanner_content_gap_v AS
WITH
-- 1) 키워드별 최신 volume_relative + 최근 30일 max
kw_latest AS (
  SELECT
    keyword,
    MAX(volume_relative)                 AS volume_relative_max,
    AVG(volume_relative)::numeric        AS volume_relative_avg,
    MAX(collected_at)                    AS last_seen_at,
    -- 시계열: 14d / 30d 비교 (수요 증가 시그널)
    MAX(volume_relative) FILTER (WHERE collected_at >= now() - interval '14 days') AS vol_14d,
    MAX(volume_relative) FILTER (WHERE collected_at >= now() - interval '30 days') AS vol_30d
  FROM public.jimscanner_trends_keywords
  WHERE collected_at >= now() - interval '60 days'
    AND volume_relative IS NOT NULL
  GROUP BY keyword
),
-- 2) keyword → product 매칭 (alias 통해서). llm 분류 끝난 product 만.
kw_product AS (
  SELECT DISTINCT ON (a.alias)
    a.alias                              AS keyword,
    p.id                                 AS product_id,
    p.canonical_name,
    p.category_top,
    p.category_mid,
    p.llm_classified_at,
    p.intent_label
  FROM public.jimscanner_trends_aliases a
  JOIN public.jimscanner_trends_products p ON p.id = a.product_id
  WHERE p.llm_classified_at IS NOT NULL
  ORDER BY a.alias, a.confidence DESC NULLS LAST, a.created_at DESC
),
-- 3) 한국어 콘텐츠 풍부도 (market_raw: blog/news/suggest 빈도)
content_density AS (
  SELECT
    k.keyword,
    COUNT(*) FILTER (WHERE r.source = 'naver_blog')      AS blog_count,
    COUNT(*) FILTER (WHERE r.source = 'naver_news')      AS news_count,
    COUNT(*) FILTER (WHERE r.source = 'google_suggest')  AS suggest_count,
    COUNT(*)                                              AS content_count
  FROM kw_latest k
  LEFT JOIN public.jimscanner_market_raw r
    ON r.source IN ('naver_blog', 'naver_news', 'google_suggest')
   AND (
        r.title ILIKE '%' || k.keyword || '%'
     OR r.query ILIKE '%' || k.keyword || '%'
   )
   AND r.captured_at >= now() - interval '30 days'
  GROUP BY k.keyword
),
-- 4) 자체 블로그 카운트 (있을 때 — jimscanner_blog_posts 등). 없으면 0.
own_blog AS (
  SELECT
    k.keyword,
    0::int AS own_blog_count
  FROM kw_latest k
),
-- 5) 결합 + z-score
combined AS (
  SELECT
    kp.product_id,
    kp.canonical_name,
    kp.category_top,
    kp.category_mid,
    kp.intent_label,
    kl.keyword,
    kl.volume_relative_max,
    kl.volume_relative_avg,
    kl.vol_14d,
    kl.vol_30d,
    kl.last_seen_at,
    COALESCE(cd.blog_count,    0) AS blog_count,
    COALESCE(cd.news_count,    0) AS news_count,
    COALESCE(cd.suggest_count, 0) AS suggest_count,
    COALESCE(cd.content_count, 0) AS content_count,
    COALESCE(ob.own_blog_count, 0) AS own_blog_count
  FROM kw_latest kl
  JOIN kw_product kp ON kp.keyword = kl.keyword
  LEFT JOIN content_density cd ON cd.keyword = kl.keyword
  LEFT JOIN own_blog ob ON ob.keyword = kl.keyword
),
stats AS (
  SELECT
    AVG(volume_relative_max) AS mu,
    NULLIF(STDDEV_POP(volume_relative_max), 0) AS sigma
  FROM combined
)
SELECT
  c.product_id,
  c.canonical_name,
  c.category_top,
  c.category_mid,
  c.intent_label,
  c.keyword,
  c.volume_relative_max,
  c.volume_relative_avg,
  c.vol_14d,
  c.vol_30d,
  c.last_seen_at,
  c.blog_count,
  c.news_count,
  c.suggest_count,
  c.content_count,
  c.own_blog_count,
  -- z-score (간이): (x - mu) / sigma, 표본 부족 시 0
  CASE
    WHEN s.sigma IS NULL THEN 0
    ELSE ROUND(((c.volume_relative_max - s.mu) / s.sigma)::numeric, 3)
  END AS demand_z,
  -- gap_score = demand_z - ln(1 + content_count)
  CASE
    WHEN s.sigma IS NULL THEN -LN(1 + c.content_count)::numeric
    ELSE ROUND(
      (((c.volume_relative_max - s.mu) / s.sigma) - LN(1 + c.content_count))::numeric,
      3
    )
  END AS gap_score,
  -- ggsan vendor 매칭 여부 (canonical_name 으로 ILIKE)
  EXISTS (
    SELECT 1 FROM public.jimscanner_ggsan_products gp
    WHERE gp.title ILIKE '%' || c.keyword || '%'
    LIMIT 1
  ) AS has_ggsan_match,
  -- 핀 상태 (기존 v3 핀 테이블)
  EXISTS (
    SELECT 1 FROM public.jimscanner_trends_pins tp
    WHERE tp.keyword = c.keyword
    LIMIT 1
  ) AS is_pinned,
  now() AS computed_at
FROM combined c
CROSS JOIN stats s;

CREATE UNIQUE INDEX IF NOT EXISTS jimscanner_content_gap_v_keyword
  ON public.jimscanner_content_gap_v(keyword);

CREATE INDEX IF NOT EXISTS jimscanner_content_gap_v_gap_score
  ON public.jimscanner_content_gap_v(gap_score DESC);

CREATE INDEX IF NOT EXISTS jimscanner_content_gap_v_category
  ON public.jimscanner_content_gap_v(category_top, gap_score DESC);

-- MV 갱신 helper (cron 에서 호출). CONCURRENTLY 는 unique index 필요.
CREATE OR REPLACE FUNCTION public.jimscanner_refresh_content_gap()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.jimscanner_content_gap_v;
EXCEPTION WHEN OTHERS THEN
  -- concurrently 실패 (초기 채움 등) 시 일반 refresh
  REFRESH MATERIALIZED VIEW public.jimscanner_content_gap_v;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
