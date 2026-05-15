-- ────────────────────────────────────────────────────────────
-- 커뮤니티 선행 시그널 lead-lag 발굴 RPC (community-lead, 2026-05-15)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/community-lead
-- 82cook · natepan · ppomppu · dcinside · clien 등 커뮤니티 raw 시그널과
-- commerce (naver_tvtime + naver_shopping_insight + naver_search_trend) 시그널의
-- 14일 롤링 카운트를 product 별로 비교 — '커뮤니티 선행(lead)' 후보를 발굴.
--
-- 정의:
--   community_rolling_14d = 지난 N일 jimscanner_market_raw 매칭 row 수
--   commerce_rolling_14d  = 지난 N일 jimscanner_trends_keywords 매칭 row 수 (commerce 소스)
--   lead_days             = commerce 첫 등장 - community 첫 등장 (양수 = 커뮤니티가 선행)
--                           commerce 가 비면 N(=days_window) 로 캡
--   dominant_board        = 가장 많이 등장한 커뮤니티 소스
--   ggsan_match_count     = ggsan 카탈로그 fuzzy 매칭 수
--
-- service_role 만 호출 (어드민 한정) — SECURITY DEFINER + grant 명시
-- pg_trgm % 연산자 기반 fuzzy 매칭 (TV ↔ ggsan 매칭 RPC 와 동일 패턴)
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_community_lead(
  days_window int DEFAULT 14,
  min_sim float DEFAULT 0.25,
  result_limit int DEFAULT 100
)
RETURNS TABLE (
  product_id uuid,
  canonical_name text,
  category_top text,
  community_rolling_14d int,
  commerce_rolling_14d int,
  lead_days int,
  dominant_board text,
  ggsan_match_count int,
  community_first_seen timestamptz,
  commerce_first_seen timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH community AS (
    SELECT
      p.id   AS product_id,
      p.canonical_name,
      p.category_top,
      r.source,
      r.captured_at
    FROM jimscanner_trends_products p
    JOIN jimscanner_market_raw r
      ON r.source IN (
           '82cook','82cook_talk','82cook_recipe',
           'natepan','natepan_top',
           'ppomppu','ppomppu_sale','ppomppu_freeboard',
           'dcinside','dcinside_hit',
           'clien','clien_park'
         )
     AND r.captured_at > now() - (days_window || ' days')::interval
     AND coalesce(r.title, '') <> ''
     AND coalesce(r.title, '') % p.canonical_name
     AND similarity(coalesce(r.title, ''), p.canonical_name) >= min_sim
  ),
  community_agg AS (
    SELECT
      product_id,
      canonical_name,
      category_top,
      count(*)::int                              AS community_rolling_14d,
      MIN(captured_at)                            AS community_first_seen,
      MAX(captured_at)                            AS community_last_seen,
      mode() WITHIN GROUP (ORDER BY source)       AS dominant_board
    FROM community
    GROUP BY product_id, canonical_name, category_top
  ),
  commerce AS (
    SELECT
      p.id AS product_id,
      count(*)::int     AS commerce_rolling_14d,
      MIN(k.collected_at) AS commerce_first_seen
    FROM jimscanner_trends_products p
    JOIN jimscanner_trends_keywords k
      ON k.source IN ('naver_tvtime','naver_shopping_insight','naver_search_trend')
     AND k.collected_at > now() - (days_window || ' days')::interval
     AND coalesce(k.keyword, '') <> ''
     AND coalesce(k.keyword, '') % p.canonical_name
     AND similarity(coalesce(k.keyword, ''), p.canonical_name) >= min_sim
    GROUP BY p.id
  ),
  ggsan AS (
    SELECT
      p.id AS product_id,
      count(*)::int AS ggsan_match_count
    FROM jimscanner_trends_products p
    JOIN jimscanner_ggsan_products g
      ON g.title % p.canonical_name
     AND similarity(g.title, p.canonical_name) >= min_sim
    GROUP BY p.id
  )
  SELECT
    ca.product_id,
    ca.canonical_name,
    ca.category_top,
    ca.community_rolling_14d,
    COALESCE(c.commerce_rolling_14d, 0)::int AS commerce_rolling_14d,
    CASE
      WHEN c.commerce_first_seen IS NULL THEN days_window
      ELSE GREATEST(
        0,
        EXTRACT(EPOCH FROM (c.commerce_first_seen - ca.community_first_seen))::int / 86400
      )
    END::int AS lead_days,
    ca.dominant_board,
    COALESCE(g.ggsan_match_count, 0)::int AS ggsan_match_count,
    ca.community_first_seen,
    c.commerce_first_seen
  FROM community_agg ca
  LEFT JOIN commerce c ON c.product_id = ca.product_id
  LEFT JOIN ggsan g    ON g.product_id = ca.product_id
  WHERE ca.community_rolling_14d >= 2
  ORDER BY
    -- 커뮤니티가 commerce 보다 더 시끄러운 정도 우선
    (ca.community_rolling_14d - COALESCE(c.commerce_rolling_14d, 0)) DESC,
    ca.community_rolling_14d DESC
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_community_lead(int, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_community_lead(int, float, int) TO service_role;
