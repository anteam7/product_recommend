-- ────────────────────────────────────────────────────────────
-- 커뮤니티 출처 → 페르소나 매핑 RPC (2026-06-01)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/audience
-- 목적: 캐노니컬 상품별로 alias.source 집합을 product_id 기준 GROUP 하여
--       '어느 커뮤니티/채널에서 부상했는가'를 페이지에서 페르소나로 역추정.
--       (출처 = 인구집단 사전은 페이지 상수 + docs/source-persona-map.md)
-- 입력: jimscanner_trends_aliases.source (82cook_talk·musinsa_best·
--       dcinside_realtime·ppomppu_main·natepan_ranking·naver_tvtime·
--       aliex_best·naver_shopping_hot·naver_search_trend 등)
-- 출력: 상품 단위 + sources jsonb([{source, cnt}]) 펼침
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_trends_audience(
  days_window int DEFAULT 60,
  result_limit int DEFAULT 300
)
RETURNS TABLE (
  product_id text,
  canonical_name text,
  category_top text,
  category_mid text,
  brand text,
  intent_label text,
  description text,
  alias_count int,
  last_seen_at timestamptz,
  distinct_sources int,
  total_alias_hits int,
  sources jsonb            -- [{ "source": "82cook_talk", "cnt": 4 }, ...] cnt DESC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH src AS (
    SELECT
      a.product_id,
      a.source,
      COUNT(*)::int AS cnt
    FROM jimscanner_trends_aliases a
    WHERE a.source IS NOT NULL
      AND a.source <> ''
      AND a.created_at > now() - (days_window || ' days')::interval
    GROUP BY a.product_id, a.source
  ),
  agg AS (
    SELECT
      product_id,
      COUNT(*)::int AS distinct_sources,
      SUM(cnt)::int AS total_alias_hits,
      jsonb_agg(
        jsonb_build_object('source', source, 'cnt', cnt)
        ORDER BY cnt DESC
      ) AS sources
    FROM src
    GROUP BY product_id
  )
  SELECT
    p.id::text                 AS product_id,
    p.canonical_name,
    p.category_top,
    p.category_mid,
    p.brand,
    p.intent_label,
    p.description,
    p.alias_count,
    p.last_seen_at,
    agg.distinct_sources,
    agg.total_alias_hits,
    agg.sources
  FROM agg
  JOIN jimscanner_trends_products p ON p.id = agg.product_id
  ORDER BY agg.total_alias_hits DESC, agg.distinct_sources DESC
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출
REVOKE ALL ON FUNCTION jimscanner_trends_audience(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_trends_audience(int, int) TO service_role;
