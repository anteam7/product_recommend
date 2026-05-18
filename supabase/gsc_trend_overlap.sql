-- GSC × 트렌드 매칭 진입우선순위 RPC — 2026-05-18
--
-- 기존 jimscanner_gsc_queries (자연 유입 검색어) × jimscanner_trends_aliases (트렌드 alias)
-- 를 키워드 ILIKE 매칭으로 조인해서 "이미 우리 사이트가 노출되는 검색어 중 트렌드가 상승 중인" 쿼리만 노출.
--
-- 사용처: src/app/admin/(dashboard)/trend-radar/owned-traffic/page.tsx
--
-- 출력 필드:
--  - query: GSC 검색어
--  - clicks_28d / impressions_28d: 최근 days 윈도우 합계
--  - position_avg: impressions 가중 평균 (단순 avg → 가중 avg)
--  - position_delta_7d: 최근 7일 평균 - 직전 7일 평균 (음수 = position 개선)
--  - product_id / canonical_name / category_top: 매칭된 트렌드 상품 (없으면 NULL)
--  - matched_alias: 어떤 alias 가 매칭됐는지
--  - trend_final_score: 매칭 상품의 최신 final_score (없으면 NULL)
--  - trend_score_delta_7d: final_score 의 7일 전 대비 변화
--  - priority_rank: position<=10 + trend 상승 + impressions 충분 우선
--
-- 멱등: 정의를 매번 새로 만들기 위해 DROP + CREATE.

DROP FUNCTION IF EXISTS jimscanner_gsc_trend_overlap(int, int);

CREATE OR REPLACE FUNCTION jimscanner_gsc_trend_overlap(
  days_window int DEFAULT 28,
  min_impr int DEFAULT 20
)
RETURNS TABLE (
  query text,
  clicks_window bigint,
  impressions_window bigint,
  position_avg numeric,
  position_delta_7d numeric,
  product_id uuid,
  canonical_name text,
  category_top text,
  matched_alias text,
  alias_confidence numeric,
  trend_final_score numeric,
  trend_score_delta_7d numeric,
  priority_rank numeric
)
LANGUAGE sql
STABLE
AS $$
WITH win AS (
  -- 윈도우 합계 (clicks, impressions, impression-weighted avg position)
  SELECT
    q.query,
    SUM(q.clicks)::bigint AS clicks_window,
    SUM(q.impressions)::bigint AS impressions_window,
    CASE
      WHEN SUM(q.impressions) = 0 THEN NULL
      ELSE ROUND((SUM(q.position * q.impressions) / NULLIF(SUM(q.impressions), 0))::numeric, 2)
    END AS position_avg
  FROM jimscanner_gsc_queries q
  WHERE q.date >= (CURRENT_DATE - days_window)
  GROUP BY q.query
  HAVING SUM(q.impressions) >= min_impr
),
recent7 AS (
  SELECT
    q.query,
    CASE WHEN SUM(q.impressions) = 0 THEN NULL
         ELSE SUM(q.position * q.impressions) / NULLIF(SUM(q.impressions), 0) END AS pos_recent
  FROM jimscanner_gsc_queries q
  WHERE q.date >= (CURRENT_DATE - 7)
  GROUP BY q.query
),
prior7 AS (
  SELECT
    q.query,
    CASE WHEN SUM(q.impressions) = 0 THEN NULL
         ELSE SUM(q.position * q.impressions) / NULLIF(SUM(q.impressions), 0) END AS pos_prior
  FROM jimscanner_gsc_queries q
  WHERE q.date >= (CURRENT_DATE - 14) AND q.date < (CURRENT_DATE - 7)
  GROUP BY q.query
),
-- alias 매칭: query 가 alias 를 포함하거나 alias 가 query 를 포함하면 매칭. confidence DESC 로 베스트만.
matches AS (
  SELECT DISTINCT ON (w.query)
    w.query,
    a.product_id,
    a.alias AS matched_alias,
    a.confidence AS alias_confidence
  FROM win w
  JOIN jimscanner_trends_aliases a
    ON (
      w.query ILIKE '%' || a.alias || '%'
      OR a.alias ILIKE '%' || w.query || '%'
    )
   AND length(a.alias) >= 2
  ORDER BY w.query, a.confidence DESC NULLS LAST, length(a.alias) DESC
),
-- 매칭된 product 의 최신 final_score
latest_score AS (
  SELECT DISTINCT ON (s.product_id)
    s.product_id, s.final_score, s.computed_at
  FROM jimscanner_trends_scores s
  ORDER BY s.product_id, s.computed_at DESC
),
-- 7일 전 final_score (가장 가까운 score, computed_at <= now - 7d)
prior_score AS (
  SELECT DISTINCT ON (s.product_id)
    s.product_id, s.final_score AS prior_final_score
  FROM jimscanner_trends_scores s
  WHERE s.computed_at <= (now() - interval '7 days')
  ORDER BY s.product_id, s.computed_at DESC
)
SELECT
  w.query,
  w.clicks_window,
  w.impressions_window,
  w.position_avg,
  CASE
    WHEN r7.pos_recent IS NULL OR p7.pos_prior IS NULL THEN NULL
    ELSE ROUND((r7.pos_recent - p7.pos_prior)::numeric, 2)
  END AS position_delta_7d,
  m.product_id,
  p.canonical_name,
  p.category_top,
  m.matched_alias,
  m.alias_confidence,
  ls.final_score AS trend_final_score,
  CASE
    WHEN ls.final_score IS NULL OR ps.prior_final_score IS NULL THEN NULL
    ELSE ROUND((ls.final_score - ps.prior_final_score)::numeric, 2)
  END AS trend_score_delta_7d,
  -- priority_rank:
  --  - position <= 10 → 강한 가산 (60)
  --  - position <= 20 → 30
  --  - trend final_score 가산 (0~100 → 0~40)
  --  - 7일 trend 상승분 가산 (max 20)
  --  - position 개선(음수) 가산 (절대값 * 2, max 10)
  --  - impressions log 가산 (0~10)
  (
    CASE
      WHEN w.position_avg IS NULL THEN 0
      WHEN w.position_avg <= 10 THEN 60
      WHEN w.position_avg <= 20 THEN 30
      WHEN w.position_avg <= 50 THEN 10
      ELSE 0
    END
    + COALESCE(ls.final_score, 0) * 0.4
    + GREATEST(
        LEAST(
          COALESCE(ls.final_score, 0) - COALESCE(ps.prior_final_score, 0),
          20
        ),
        0
      )
    + CASE
        WHEN r7.pos_recent IS NULL OR p7.pos_prior IS NULL THEN 0
        WHEN (r7.pos_recent - p7.pos_prior) < 0 THEN LEAST(ABS(r7.pos_recent - p7.pos_prior) * 2, 10)
        ELSE 0
      END
    + LEAST(LN(GREATEST(w.impressions_window, 1)) * 2, 10)
  )::numeric AS priority_rank
FROM win w
LEFT JOIN matches m ON m.query = w.query
LEFT JOIN jimscanner_trends_products p ON p.id = m.product_id
LEFT JOIN latest_score ls ON ls.product_id = m.product_id
LEFT JOIN prior_score ps ON ps.product_id = m.product_id
LEFT JOIN recent7 r7 ON r7.query = w.query
LEFT JOIN prior7 p7 ON p7.query = w.query
ORDER BY priority_rank DESC NULLS LAST, w.impressions_window DESC;
$$;

-- service_role 만 호출 (RLS 와 동일 패턴 — 정책 미부여)
REVOKE ALL ON FUNCTION jimscanner_gsc_trend_overlap(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_gsc_trend_overlap(int, int) TO service_role;
