-- ────────────────────────────────────────────────────────────
-- 미분류 백로그 발굴 우선순위 큐 — LLM 예산 집중 라우터 (2026-06-03)
-- ────────────────────────────────────────────────────────────
-- 사용처:
--   - /admin/trend-radar/queue 페이지 (분류 대기열 보드)
--   - scripts/classify-trends-llm.mjs fetchCandidates() 정렬
--
-- 목적:
--   intent_label / llm_classified_at 가 NULL 인 미분류 product 를
--   LLM 없이 계산 가능한 '사전 잠재력 점수(priority_score)' 로 desc 정렬.
--   FIFO/임의 순서가 아니라 신호 강도순으로 LLM 호출 예산을 집중해
--   백로그에 묻힌 잠재 winner 를 먼저 끌어올린다.
--
-- 점수 구성 (모두 기존 컬럼만 사용):
--   · alias_count         : product 에 매핑된 alias 수 (수요 관측 빈도)
--   · source_count        : alias 의 distinct source 수 (교차출처 다양성 — 강한 신호)
--   · recency_bonus       : last_seen_at 최근성 가중 (30일 선형 감쇠)
--   · confidence_sum      : alias confidence 합 (동반 키워드 신뢰도 합성)
--
-- service_role 로만 호출 (어드민 한정) — SECURITY DEFINER + grant 명시
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_classify_priority(
  result_limit int DEFAULT 500
)
RETURNS TABLE (
  id uuid,
  canonical_name text,
  category_top text,
  category_mid text,
  alias_count int,
  source_count int,
  confidence_sum numeric,
  last_seen_at timestamptz,
  recency_days numeric,
  priority_score numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH alias_agg AS (
    SELECT
      a.product_id,
      COUNT(DISTINCT a.source) FILTER (WHERE a.source IS NOT NULL AND a.source <> '')::int AS source_count,
      COALESCE(SUM(a.confidence), 0)::numeric AS confidence_sum
    FROM jimscanner_trends_aliases a
    GROUP BY a.product_id
  )
  SELECT
    p.id,
    p.canonical_name,
    p.category_top,
    p.category_mid,
    p.alias_count,
    COALESCE(ag.source_count, 0) AS source_count,
    COALESCE(ag.confidence_sum, 0) AS confidence_sum,
    p.last_seen_at,
    ROUND(EXTRACT(EPOCH FROM (now() - p.last_seen_at)) / 86400.0, 1) AS recency_days,
    ROUND(
      -- alias 빈도: 관측 횟수
      (p.alias_count * 2.0)
      -- 교차출처 다양성: winner 신호 가중 ↑↑
      + (COALESCE(ag.source_count, 0) * 6.0)
      -- 최근성: 30일 선형 감쇠 (오늘=30점, 30일전=0점)
      + GREATEST(0, 30 - (EXTRACT(EPOCH FROM (now() - p.last_seen_at)) / 86400.0))
      -- alias confidence 합 (동반 키워드 신뢰도)
      + (COALESCE(ag.confidence_sum, 0) * 3.0)
    , 1) AS priority_score
  FROM jimscanner_trends_products p
  LEFT JOIN alias_agg ag ON ag.product_id = p.id
  WHERE p.llm_classified_at IS NULL
  ORDER BY priority_score DESC, p.alias_count DESC, p.last_seen_at DESC
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출 (anon/authenticated 차단)
REVOKE ALL ON FUNCTION jimscanner_classify_priority(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_classify_priority(int) TO service_role;
