-- ────────────────────────────────────────────────────────────
-- 수집→분류→매핑→핀 funnel coverage RPC (2026-05-20)
-- ────────────────────────────────────────────────────────────
-- 카테고리(category_top) 단위로 다음 4단 funnel 을 집계:
--   1) raw        : jimscanner_trends_keywords 에 수집된 키워드 수 (window 내)
--   2) classified : LLM 분류가 끝난 키워드 수 (classified_category IS NOT NULL)
--   3) mapped     : alias 매핑이 존재하는 키워드 (jimscanner_trends_aliases 와 join)
--   4) pinned     : pinned=true 인 키워드
--
-- 호출: SELECT * FROM jimscanner_funnel_coverage(7);   -- 7·30·90일 윈도우
-- 운영자가 '데이터는 모이는데 왜 핀이 안 나오는가' 를 30초 안에 진단하도록.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_funnel_coverage(days_window int DEFAULT 7)
RETURNS TABLE(
  category_top text,
  raw_count bigint,
  classified_count bigint,
  mapped_count bigint,
  pinned_count bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH window_kw AS (
    SELECT
      COALESCE(NULLIF(TRIM(category_top), ''), '(미분류)') AS cat,
      keyword,
      classified_category,
      pinned
    FROM jimscanner_trends_keywords
    WHERE collected_at >= now() - (days_window || ' days')::interval
  ),
  per_kw AS (
    -- 같은 (cat, keyword) 는 한 번만 카운트 — 시계열 중복 제거.
    SELECT
      cat,
      keyword,
      bool_or(classified_category IS NOT NULL) AS is_classified,
      bool_or(pinned)                          AS is_pinned
    FROM window_kw
    GROUP BY cat, keyword
  ),
  mapped AS (
    SELECT DISTINCT p.cat, p.keyword
    FROM per_kw p
    JOIN jimscanner_trends_aliases a ON a.alias = p.keyword
  )
  SELECT
    p.cat AS category_top,
    COUNT(*)::bigint                                          AS raw_count,
    COUNT(*) FILTER (WHERE p.is_classified)::bigint           AS classified_count,
    (SELECT COUNT(*) FROM mapped m WHERE m.cat = p.cat)::bigint AS mapped_count,
    COUNT(*) FILTER (WHERE p.is_pinned)::bigint               AS pinned_count
  FROM per_kw p
  GROUP BY p.cat
  ORDER BY raw_count DESC;
$$;

-- service-role 만 호출 (RLS 우회 — 어드민 페이지 전용)
REVOKE ALL ON FUNCTION jimscanner_funnel_coverage(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_funnel_coverage(int) TO service_role;
