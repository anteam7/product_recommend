-- ────────────────────────────────────────────────────────────
-- Cross-Source Convergence Score (2026-05-25)
-- ────────────────────────────────────────────────────────────
-- 후보 키워드별로 독립 시그널 소스(naver_tvtime, naver_search_trend,
-- naver_shopping_insight, naver_blog, naver_news, google_suggest, ggsan)
-- 에서 7일 카운트 → 소스별 z-score → 다소스 가중 'Convergence Score' 산출.
--
-- 사용처: /admin/trend-radar/convergence
-- 갱신: scripts/run-crons.mjs 가 매일 /api/cron/refresh-convergence 호출.
--
-- 동기: 단일 소스에서만 강하게 튀는 키워드는 ephemeral 노이즈일 확률이 높음.
-- 소스 독립성을 가중해 false positive 를 구조적으로 잘라낸다.
-- ────────────────────────────────────────────────────────────

-- 1) 7일 윈도우 키워드 × 소스 카운트
DROP MATERIALIZED VIEW IF EXISTS jimscanner_keyword_convergence CASCADE;
DROP MATERIALIZED VIEW IF EXISTS jimscanner_keyword_signals_7d CASCADE;

CREATE MATERIALIZED VIEW jimscanner_keyword_signals_7d AS
WITH unified AS (
  -- jimscanner_trends_keywords: tv / search / shopping
  SELECT lower(trim(keyword)) AS keyword, source
  FROM jimscanner_trends_keywords
  WHERE source IN ('naver_tvtime', 'naver_search_trend', 'naver_shopping_insight')
    AND collected_at > now() - interval '7 days'
    AND keyword IS NOT NULL
    AND length(trim(keyword)) >= 2

  UNION ALL

  -- jimscanner_market_raw: naver_blog / naver_news → query 가 시드 키워드
  SELECT lower(trim(query)) AS keyword, source
  FROM jimscanner_market_raw
  WHERE source IN ('naver_blog', 'naver_news')
    AND captured_at > now() - interval '7 days'
    AND query IS NOT NULL
    AND length(trim(query)) >= 2

  UNION ALL

  -- google_suggest: title 자체가 자동완성 결과(키워드)
  SELECT lower(trim(title)) AS keyword, source
  FROM jimscanner_market_raw
  WHERE source = 'google_suggest'
    AND captured_at > now() - interval '7 days'
    AND title IS NOT NULL
    AND length(trim(title)) >= 2

  UNION ALL

  -- ggsan: 최근 7일 last_seen 상품 title — 인벤토리 시그널
  SELECT lower(trim(title)) AS keyword, 'ggsan'::text AS source
  FROM jimscanner_ggsan_products
  WHERE last_seen_at > now() - interval '7 days'
    AND title IS NOT NULL
    AND length(trim(title)) >= 2
)
SELECT keyword, source, COUNT(*)::int AS count_7d
FROM unified
GROUP BY keyword, source;

CREATE UNIQUE INDEX jimscanner_keyword_signals_7d_uq
  ON jimscanner_keyword_signals_7d (keyword, source);
CREATE INDEX jimscanner_keyword_signals_7d_source
  ON jimscanner_keyword_signals_7d (source, count_7d DESC);

-- 2) Convergence Score 매뷰
-- 소스별 z-score 후 다소스 가중: sqrt(positive_source_count) × Σ max(z, 0)
-- → 한 소스에서만 튄 z=5 (single) 보다, 세 소스에서 고른 z=1.5×3 (multi) 가 더 높게 평가됨.
CREATE MATERIALIZED VIEW jimscanner_keyword_convergence AS
WITH source_stats AS (
  SELECT
    source,
    avg(count_7d::float) AS mu,
    stddev_pop(count_7d::float) AS sigma,
    count(*)::int AS keyword_count
  FROM jimscanner_keyword_signals_7d
  GROUP BY source
),
scored AS (
  SELECT
    s.keyword,
    s.source,
    s.count_7d,
    CASE
      WHEN ss.sigma > 0 THEN (s.count_7d::float - ss.mu) / ss.sigma
      ELSE 0
    END AS z_score
  FROM jimscanner_keyword_signals_7d s
  JOIN source_stats ss ON ss.source = s.source
),
aggregated AS (
  SELECT
    keyword,
    COUNT(DISTINCT source)::int AS source_count,
    COUNT(DISTINCT CASE WHEN z_score > 0 THEN source END)::int AS positive_source_count,
    SUM(GREATEST(z_score, 0))::float AS positive_z_sum,
    MAX(z_score)::float AS max_z,
    SUM(count_7d)::int AS total_count_7d,
    jsonb_object_agg(
      source,
      jsonb_build_object(
        'count', count_7d,
        'z', round(z_score::numeric, 3)
      )
    ) AS per_source
  FROM scored
  GROUP BY keyword
)
SELECT
  keyword,
  source_count,
  positive_source_count,
  total_count_7d,
  round(positive_z_sum::numeric, 3)::float AS positive_z_sum,
  round(max_z::numeric, 3)::float AS max_z,
  round(
    (sqrt(GREATEST(positive_source_count, 1)::float) * positive_z_sum)::numeric,
    3
  )::float AS convergence_score,
  per_source
FROM aggregated;

CREATE UNIQUE INDEX jimscanner_keyword_convergence_uq
  ON jimscanner_keyword_convergence (keyword);
CREATE INDEX jimscanner_keyword_convergence_score_desc
  ON jimscanner_keyword_convergence (convergence_score DESC);
CREATE INDEX jimscanner_keyword_convergence_sources
  ON jimscanner_keyword_convergence (source_count DESC, convergence_score DESC);

-- 3) Nightly refresh helper (cron 엔드포인트가 호출)
CREATE OR REPLACE FUNCTION jimscanner_refresh_keyword_convergence()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  t0 timestamptz := clock_timestamp();
  signals_rows int;
  convergence_rows int;
BEGIN
  REFRESH MATERIALIZED VIEW jimscanner_keyword_signals_7d;
  REFRESH MATERIALIZED VIEW jimscanner_keyword_convergence;
  SELECT count(*) INTO signals_rows FROM jimscanner_keyword_signals_7d;
  SELECT count(*) INTO convergence_rows FROM jimscanner_keyword_convergence;
  RETURN jsonb_build_object(
    'ok', true,
    'signals_rows', signals_rows,
    'convergence_rows', convergence_rows,
    'duration_ms', round(extract(epoch FROM (clock_timestamp() - t0)) * 1000)
  );
END;
$$;

REVOKE ALL ON FUNCTION jimscanner_refresh_keyword_convergence() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_refresh_keyword_convergence() TO service_role;

-- 4) 추천 페이지에서 사용할 키워드 조회 RPC
-- 입력 키워드 리스트 → 각 키워드의 convergence_score 반환
CREATE OR REPLACE FUNCTION jimscanner_keyword_convergence_lookup(keywords text[])
RETURNS TABLE (
  keyword text,
  convergence_score float,
  source_count int,
  positive_source_count int,
  per_source jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    kc.keyword,
    kc.convergence_score,
    kc.source_count,
    kc.positive_source_count,
    kc.per_source
  FROM jimscanner_keyword_convergence kc
  WHERE kc.keyword = ANY (SELECT lower(trim(k)) FROM unnest(keywords) k);
$$;

REVOKE ALL ON FUNCTION jimscanner_keyword_convergence_lookup(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_keyword_convergence_lookup(text[]) TO service_role;
