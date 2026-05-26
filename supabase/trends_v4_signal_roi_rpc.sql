-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 시그널 소스 ROI Sankey RPC (2026-05-26)
-- ─────────────────────────────────────────────────────────────
-- get_signal_roi_flow(days_window)
--   3단 Sankey 데이터 한 번에 생성:
--     col1: source (naver_shopping_insight / naver_search_trend / naver_tvtime /
--           improvement_scout / ggsan / quasarzone_sale 등)
--     col2: classified_category (LLM 분류 top, NULL = '_unclassified')
--     col3: terminal_status (pinned / recommended / rejected / orphan_unclassified)
--
--   terminal_status 룰:
--     - jimscanner_trends_pins 에 (keyword, source) 존재 → 'pinned'
--     - keywords.pinned = true                            → 'pinned'
--     - classified_category 비어있음                       → 'orphan_unclassified'
--     - classified_intent IN ('commercial','transactional')
--       OR domain_score >= 0.4                            → 'recommended'
--     - 그 외                                              → 'rejected'
--
-- 호출: /admin/trend-radar/sources/roi 페이지에서 days_window=7|30 으로 호출.
-- 권한: service_role (어드민 SSR 에서만 사용).
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_signal_roi_flow(days_window int DEFAULT 7)
RETURNS TABLE (
  source text,
  classified_category text,
  terminal_status text,
  flow_count bigint,
  avg_confidence numeric,
  avg_domain_score numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH win AS (
    SELECT
      k.source,
      k.classified_category,
      k.classified_intent,
      k.domain_score,
      k.keyword,
      k.pinned
    FROM jimscanner_trends_keywords k
    WHERE k.collected_at >= now() - make_interval(days => days_window)
  ),
  classified AS (
    SELECT
      w.source,
      COALESCE(NULLIF(btrim(w.classified_category), ''), '_unclassified')
        AS classified_category,
      CASE
        WHEN w.pinned IS TRUE                                THEN 'pinned'
        WHEN EXISTS (
          SELECT 1 FROM jimscanner_trends_pins p
          WHERE p.keyword = w.keyword AND p.source = w.source
        )                                                    THEN 'pinned'
        WHEN w.classified_category IS NULL
          OR btrim(w.classified_category) = ''               THEN 'orphan_unclassified'
        WHEN w.classified_intent IN ('commercial','transactional')
          OR COALESCE(w.domain_score, 0) >= 0.4              THEN 'recommended'
        ELSE                                                      'rejected'
      END AS terminal_status,
      w.domain_score
    FROM win w
  )
  SELECT
    c.source,
    c.classified_category,
    c.terminal_status,
    COUNT(*)::bigint                              AS flow_count,
    AVG(COALESCE(c.domain_score, 0))::numeric     AS avg_confidence,
    AVG(COALESCE(c.domain_score, 0))::numeric     AS avg_domain_score
  FROM classified c
  GROUP BY c.source, c.classified_category, c.terminal_status
  ORDER BY flow_count DESC
$$;

REVOKE ALL ON FUNCTION get_signal_roi_flow(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_signal_roi_flow(int) TO service_role;
