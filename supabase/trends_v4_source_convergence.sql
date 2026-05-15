-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 다중 소스 합치(Convergence) 지수
-- ─────────────────────────────────────────────────────────────
-- product_id × 14일 윈도우에서 매칭된 distinct raw source 수를 합산해
-- 0~100 합치 점수를 산출.
--
-- 사용처:
--   /admin/trend-radar       — 다중 소스 합치 보드
--   /admin/trend-radar/products/[id] — 소스 칩 + 합치 sparkline
--
-- 소스 정규화(아래 8개를 표준 채널로 가정):
--   naver_tvtime / naver_shopping_insight / naver_search_trend /
--   naver_news / naver_blog / clien_park / quasarzone_sale / ggsan
--
-- 데이터 소스 UNION:
--   1) jimscanner_trends_aliases.source — alias 가 처음 발견된 소스
--   2) jimscanner_trends_keywords.source — keyword=alias 매칭
--   3) jimscanner_market_raw.source — (query=alias OR title ILIKE %alias%)
-- ─────────────────────────────────────────────────────────────

-- 표준 채널 8종 (NULL/희귀 소스는 제외하여 1/8 ~ 8/8 비율 산출에 사용)
-- 'naver_shopping_hot' 등 alias 에 자주 박힌 변형은 정규화 매핑함.
CREATE OR REPLACE FUNCTION jimscanner_trends_normalize_source(s text)
RETURNS text AS $$
  SELECT CASE
    WHEN s IS NULL THEN NULL
    WHEN s ILIKE 'naver_tv%' THEN 'naver_tvtime'
    WHEN s ILIKE 'naver_shop%' OR s = 'naver_shopping_insight' OR s = 'naver_shopping_hot' THEN 'naver_shopping_insight'
    WHEN s ILIKE 'naver_search%' OR s = 'naver_datalab' OR s = 'naver_search_trend' THEN 'naver_search_trend'
    WHEN s = 'naver_news' THEN 'naver_news'
    WHEN s = 'naver_blog' THEN 'naver_blog'
    WHEN s ILIKE 'clien%' THEN 'clien_park'
    WHEN s ILIKE 'quasar%' THEN 'quasarzone_sale'
    WHEN s = 'ggsan' OR s ILIKE 'ggsan%' THEN 'ggsan'
    ELSE NULL  -- 기타 (manual, google_suggest, kca_press 등) — 합치 계산 제외
  END
$$ LANGUAGE sql IMMUTABLE;


-- 메인 합치 뷰 (per product, 14d window)
CREATE OR REPLACE VIEW jimscanner_trends_source_convergence AS
WITH ws AS (SELECT (now() - interval '14 days') AS start_at),
src_aliases AS (
  SELECT a.product_id,
         jimscanner_trends_normalize_source(a.source) AS source
  FROM jimscanner_trends_aliases a
  WHERE a.source IS NOT NULL
    AND a.created_at >= (SELECT start_at FROM ws)
),
src_keywords AS (
  SELECT a.product_id,
         jimscanner_trends_normalize_source(k.source) AS source
  FROM jimscanner_trends_aliases a
  JOIN jimscanner_trends_keywords k
    ON k.keyword = a.alias
   AND k.collected_at >= (SELECT start_at FROM ws)
),
src_raw AS (
  SELECT a.product_id,
         jimscanner_trends_normalize_source(r.source) AS source
  FROM jimscanner_trends_aliases a
  JOIN jimscanner_market_raw r
    ON (r.query = a.alias OR r.title ILIKE ('%' || a.alias || '%'))
   AND r.captured_at >= (SELECT start_at FROM ws)
),
unioned AS (
  SELECT product_id, source FROM src_aliases WHERE source IS NOT NULL
  UNION
  SELECT product_id, source FROM src_keywords WHERE source IS NOT NULL
  UNION
  SELECT product_id, source FROM src_raw WHERE source IS NOT NULL
)
SELECT
  product_id,
  array_agg(DISTINCT source ORDER BY source) AS sources,
  count(DISTINCT source)::int AS source_count,
  LEAST(100, round((count(DISTINCT source)::numeric / 8) * 100))::int AS convergence_score
FROM unioned
GROUP BY product_id;


-- 일자별 합치 sparkline (최근 14일)
CREATE OR REPLACE VIEW jimscanner_trends_source_convergence_daily AS
WITH days AS (
  SELECT generate_series(
    (now() - interval '13 days')::date,
    now()::date,
    interval '1 day'
  )::date AS day
),
ws AS (SELECT (now() - interval '14 days') AS start_at),
src_aliases AS (
  SELECT a.product_id, a.created_at::date AS day,
         jimscanner_trends_normalize_source(a.source) AS source
  FROM jimscanner_trends_aliases a
  WHERE a.created_at >= (SELECT start_at FROM ws)
),
src_keywords AS (
  SELECT a.product_id, k.collected_at::date AS day,
         jimscanner_trends_normalize_source(k.source) AS source
  FROM jimscanner_trends_aliases a
  JOIN jimscanner_trends_keywords k
    ON k.keyword = a.alias
   AND k.collected_at >= (SELECT start_at FROM ws)
),
src_raw AS (
  SELECT a.product_id, r.captured_at::date AS day,
         jimscanner_trends_normalize_source(r.source) AS source
  FROM jimscanner_trends_aliases a
  JOIN jimscanner_market_raw r
    ON (r.query = a.alias OR r.title ILIKE ('%' || a.alias || '%'))
   AND r.captured_at >= (SELECT start_at FROM ws)
),
unioned AS (
  SELECT product_id, day, source FROM src_aliases WHERE source IS NOT NULL
  UNION
  SELECT product_id, day, source FROM src_keywords WHERE source IS NOT NULL
  UNION
  SELECT product_id, day, source FROM src_raw WHERE source IS NOT NULL
)
SELECT product_id, day, count(DISTINCT source)::int AS source_count
FROM unioned
GROUP BY product_id, day;


-- 모멘텀 (최신 score 시계열 vs 이전 score) 도우미 — 단일 점수가 상승 추세인지 표시.
-- 합치 보드의 "단일 소스 의심" 컬럼에서 final_score 가 오르고 있는 product 추출에 사용.
CREATE OR REPLACE VIEW jimscanner_trends_score_momentum AS
WITH ranked AS (
  SELECT s.product_id, s.final_score, s.computed_at,
         row_number() OVER (PARTITION BY s.product_id ORDER BY s.computed_at DESC) AS rn
  FROM jimscanner_trends_scores s
),
latest AS (SELECT product_id, final_score AS cur_score, computed_at FROM ranked WHERE rn = 1),
prev   AS (SELECT product_id, final_score AS prev_score FROM ranked WHERE rn = 2)
SELECT
  l.product_id,
  l.cur_score,
  COALESCE(p.prev_score, l.cur_score) AS prev_score,
  (l.cur_score - COALESCE(p.prev_score, l.cur_score))::numeric AS delta,
  l.computed_at
FROM latest l
LEFT JOIN prev p ON p.product_id = l.product_id;


-- 권한: 모든 view 는 service-role 만 사용 (admin 페이지 read-only).
-- (Postgres view 는 base table 의 RLS 를 상속하지만, service-role 는 어차피 bypass.)
