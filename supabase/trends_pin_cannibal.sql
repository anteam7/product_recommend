-- ────────────────────────────────────────────────────────────
-- 포트폴리오 카니발리제이션 맵 — 핀×핀 Co-SERP 중첩 보드
-- ────────────────────────────────────────────────────────────
-- 활성 핀(jimscanner_trends_pins)끼리 같은 SERP·동일 구매자 의도를 두고
-- 자기잠식하는 관계를 탐지. 외부 competition_score(우리 vs 시장)와 달리
-- "우리 포트폴리오 내부 중첩"을 측정한다.
--
-- Cannibal Score = 0.55 * jaccard(token) + 0.25 * category_overlap
--                + 0.20 * supplier_overlap (ggsan 매칭 시)
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_pin_cannibal_pairs(
  min_overlap numeric DEFAULT 0.15,
  days_window int DEFAULT 30
)
RETURNS TABLE (
  pin_a_keyword text,
  pin_a_source  text,
  pin_b_keyword text,
  pin_b_source  text,
  token_jaccard numeric,
  category_overlap numeric,
  supplier_overlap numeric,
  cannibal_score numeric,
  recommendation text
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  cutoff timestamptz := now() - make_interval(days => days_window);
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT
      p.keyword,
      p.source,
      ARRAY(
        SELECT DISTINCT t
        FROM unnest(regexp_split_to_array(lower(p.keyword), '[\s/,\-_]+')) AS t
        WHERE length(t) >= 2
      ) AS tokens
    FROM jimscanner_trends_pins p
  ),
  cats AS (
    SELECT
      lower(k.keyword) AS key_l,
      array_agg(DISTINCT k.category_top) FILTER (WHERE k.category_top IS NOT NULL) AS cset
    FROM jimscanner_trends_keywords k
    WHERE k.collected_at >= cutoff
    GROUP BY lower(k.keyword)
  ),
  suppliers AS (
    SELECT
      b.keyword AS key_kw,
      ARRAY(
        SELECT g.goods_no
        FROM jimscanner_ggsan_products g
        WHERE similarity(g.title, b.keyword) >= 0.3
        LIMIT 50
      ) AS gset
    FROM base b
  ),
  enriched AS (
    SELECT b.keyword, b.source, b.tokens,
           COALESCE(c.cset, ARRAY[]::text[]) AS cset,
           COALESCE(s.gset, ARRAY[]::text[]) AS gset
    FROM base b
    LEFT JOIN cats c ON c.key_l = lower(b.keyword)
    LEFT JOIN suppliers s ON s.key_kw = b.keyword
  ),
  pairs AS (
    SELECT
      a.keyword AS a_kw, a.source AS a_src,
      b.keyword AS b_kw, b.source AS b_src,
      CASE
        WHEN cardinality(a.tokens) = 0 OR cardinality(b.tokens) = 0 THEN 0::numeric
        ELSE (
          SELECT count(*)::numeric FROM (
            SELECT unnest(a.tokens) INTERSECT SELECT unnest(b.tokens)
          ) i
        ) / GREATEST((
          SELECT count(*)::numeric FROM (
            SELECT unnest(a.tokens) UNION SELECT unnest(b.tokens)
          ) u
        ), 1)
      END AS tj,
      CASE
        WHEN cardinality(a.cset) = 0 OR cardinality(b.cset) = 0 THEN 0::numeric
        ELSE (
          SELECT count(*)::numeric FROM (
            SELECT unnest(a.cset) INTERSECT SELECT unnest(b.cset)
          ) i
        ) / GREATEST((
          SELECT count(*)::numeric FROM (
            SELECT unnest(a.cset) UNION SELECT unnest(b.cset)
          ) u
        ), 1)
      END AS cov,
      CASE
        WHEN cardinality(a.gset) = 0 OR cardinality(b.gset) = 0 THEN 0::numeric
        ELSE (
          SELECT count(*)::numeric FROM (
            SELECT unnest(a.gset) INTERSECT SELECT unnest(b.gset)
          ) i
        ) / GREATEST((
          SELECT count(*)::numeric FROM (
            SELECT unnest(a.gset) UNION SELECT unnest(b.gset)
          ) u
        ), 1)
      END AS sov
    FROM enriched a
    JOIN enriched b
      ON (a.source, a.keyword) < (b.source, b.keyword)
  )
  SELECT
    a_kw,
    a_src,
    b_kw,
    b_src,
    round(tj, 4),
    round(cov, 4),
    round(sov, 4),
    round((0.55 * tj + 0.25 * cov + 0.20 * sov)::numeric, 4) AS cs,
    CASE
      WHEN (0.55 * tj + 0.25 * cov + 0.20 * sov) >= 0.55 THEN '회피'
      WHEN (0.55 * tj + 0.25 * cov + 0.20 * sov) >= 0.30 THEN '통합'
      ELSE '유지'
    END
  FROM pairs
  WHERE (0.55 * tj + 0.25 * cov + 0.20 * sov) >= min_overlap
  ORDER BY (0.55 * tj + 0.25 * cov + 0.20 * sov) DESC;
END;
$$;

COMMENT ON FUNCTION jimscanner_pin_cannibal_pairs(numeric, int) IS
  '핀×핀 카니발 점수 — token Jaccard + category overlap + ggsan supplier overlap (가중합).';
