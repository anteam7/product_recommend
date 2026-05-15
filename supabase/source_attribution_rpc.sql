-- ────────────────────────────────────────────────────────────
-- Source ROI 귀속 분석 RPC (V0, 2026-05-15)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/sources (하단 Source ROI 섹션)
-- 입력 신호:
--   jimscanner_trends_aliases.source × .product_id
--   jimscanner_trends_scores.final_score (product 별 최신)
-- 출력: 수집 소스별 총 alias 수 · 연결된 product 수 · 평균 final_score ·
--       고점수(≥70) 비율 · 최초 발굴 기여 건수
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_source_attribution(
  days_window int DEFAULT 7
)
RETURNS TABLE (
  source text,
  alias_count bigint,
  linked_product_count bigint,
  scored_product_count bigint,
  avg_final_score numeric,
  high_score_count bigint,
  high_score_pct numeric,
  first_discovery_count bigint,
  latest_alias_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  -- 1) days_window 내에 생성된 alias 만 대상
  recent_aliases AS (
    SELECT
      a.id,
      a.product_id,
      COALESCE(a.source, 'unknown') AS source,
      a.created_at
    FROM jimscanner_trends_aliases a
    WHERE a.created_at >= now() - (days_window || ' days')::interval
  ),
  -- 2) product 별 최신 final_score
  latest_scores AS (
    SELECT DISTINCT ON (s.product_id)
      s.product_id,
      s.final_score
    FROM jimscanner_trends_scores s
    ORDER BY s.product_id, s.computed_at DESC
  ),
  -- 3) product 별 최초 alias (= 발굴 기여 소스 식별용)
  first_aliases AS (
    SELECT DISTINCT ON (a.product_id)
      a.product_id,
      COALESCE(a.source, 'unknown') AS first_source
    FROM jimscanner_trends_aliases a
    ORDER BY a.product_id, a.created_at ASC
  ),
  -- 4) alias × score JOIN
  joined AS (
    SELECT
      ra.source,
      ra.id AS alias_id,
      ra.product_id,
      ra.created_at,
      ls.final_score
    FROM recent_aliases ra
    LEFT JOIN latest_scores ls ON ls.product_id = ra.product_id
  ),
  -- 5) 소스별 최초 발굴 기여 건수
  discovery_counts AS (
    SELECT
      first_source AS source,
      COUNT(*)::bigint AS first_discovery_count
    FROM first_aliases fa
    WHERE EXISTS (
      SELECT 1 FROM recent_aliases ra2
      WHERE ra2.product_id = fa.product_id
        AND COALESCE(ra2.source, 'unknown') = fa.first_source
    )
    GROUP BY first_source
  )
  SELECT
    j.source,
    COUNT(*)::bigint                                                AS alias_count,
    COUNT(DISTINCT j.product_id)::bigint                            AS linked_product_count,
    COUNT(DISTINCT j.product_id) FILTER (WHERE j.final_score IS NOT NULL)::bigint
                                                                    AS scored_product_count,
    ROUND(AVG(j.final_score)::numeric, 2)                           AS avg_final_score,
    COUNT(*) FILTER (WHERE j.final_score >= 70)::bigint             AS high_score_count,
    CASE
      WHEN COUNT(*) FILTER (WHERE j.final_score IS NOT NULL) > 0
      THEN ROUND(
        100.0 * COUNT(*) FILTER (WHERE j.final_score >= 70)::numeric
        / COUNT(*) FILTER (WHERE j.final_score IS NOT NULL)::numeric,
        1
      )
      ELSE NULL
    END                                                             AS high_score_pct,
    COALESCE(dc.first_discovery_count, 0)::bigint                   AS first_discovery_count,
    MAX(j.created_at)                                               AS latest_alias_at
  FROM joined j
  LEFT JOIN discovery_counts dc ON dc.source = j.source
  GROUP BY j.source, dc.first_discovery_count
  ORDER BY avg_final_score DESC NULLS LAST, alias_count DESC;
$$;

-- 권한: service-role 만 호출 (어드민 페이지에서 createAdminClient 경유)
REVOKE ALL ON FUNCTION get_source_attribution(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_source_attribution(int) TO service_role;

COMMENT ON FUNCTION get_source_attribution(int) IS
  '수집 소스별 ROI 집계: alias 수 · 연결 product 수 · 평균 final_score · 고점수 비율 · 최초 발굴 기여. days_window 일 내 생성된 alias 기준.';
