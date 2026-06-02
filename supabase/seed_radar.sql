-- 시드 사각지대 레이더 — 2026-06-03
-- 발굴 깔때기 "입구"(jimscanner_trends_seeds) 의 커버리지 피드백 루프.
--   (1) market_raw 빈출 토큰 ↔ 활성 seed 키워드/카테고리 집합 안티조인 → '미커버 핫텀' 큐
--   (2) seed → keywords → (alias) products → scores 경로로 seed 별 산출 ROI 집계
-- DB 적용은 사람이 psql 로. 코드는 적용 후 상태(아래 RPC 존재)를 가정한다.

-- ─────────────────────────────────────────
-- 1) 미커버 핫텀 RPC
--    market_raw 의 title/query 를 한글·영숫자 토큰으로 쪼개 빈도 집계 후,
--    활성 seed 가 이미 커버하는 토큰(키워드그룹 키워드 + 쇼핑 카테고리명)과
--    이미 funnel 에 들어온 trends_keywords 키워드를 제외 → 사각지대만 노출.
CREATE OR REPLACE FUNCTION jimscanner_seed_radar_uncovered(
  p_days     int DEFAULT 14,
  p_min_freq int DEFAULT 2,
  p_limit    int DEFAULT 80
)
RETURNS TABLE (
  token        text,
  frequency    bigint,
  source_count bigint,
  sources      text[],
  sample_title text,
  last_seen    timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH params AS (
    SELECT (now() - make_interval(days => GREATEST(p_days, 1)))::timestamptz AS since
  ),
  -- 활성 seed 가 커버하는 어휘 (키워드그룹 키워드 + 쇼핑 카테고리명, 모두 lower)
  covered AS (
    SELECT lower(trim(kw)) AS term
    FROM jimscanner_trends_seeds s,
         LATERAL jsonb_array_elements_text(COALESCE(s.config->'keywords', '[]'::jsonb)) AS kw
    WHERE s.is_active
    UNION
    SELECT lower(trim(s.config->>'name'))
    FROM jimscanner_trends_seeds s
    WHERE s.is_active AND s.config ? 'name'
    UNION
    SELECT lower(trim(s.label))
    FROM jimscanner_trends_seeds s
    WHERE s.is_active
  ),
  -- 이미 funnel 에 진입한 키워드 (최근 90일)
  in_funnel AS (
    SELECT DISTINCT lower(trim(keyword)) AS term
    FROM jimscanner_trends_keywords
    WHERE collected_at >= now() - interval '90 days'
  ),
  -- 한국어 흔한 불용어 (의미 없는 토큰 컷)
  stop AS (
    SELECT unnest(ARRAY[
      '그리고','하지만','그래서','오늘','내일','지금','관련','정보','사진','영상','뉴스',
      '에서','으로','하는','있는','없는','대한','위한','때문','이번','최근','경우','우리',
      'the','and','for','you','this','that','with','한국','코리아','네이버','블로그'
    ]) AS term
  ),
  tokens AS (
    SELECT
      lower(tok) AS token,
      r.source,
      r.title,
      r.captured_at
    FROM jimscanner_market_raw r, params p,
      LATERAL regexp_split_to_table(
        lower(COALESCE(r.title, '') || ' ' || COALESCE(r.query, '')),
        '[^가-힣a-z0-9]+'
      ) AS tok
    WHERE r.captured_at >= p.since
      AND char_length(tok) >= 2
      AND tok ~ '[가-힣a-z]'           -- 순수 숫자 토큰 컷
  ),
  filtered AS (
    SELECT t.*
    FROM tokens t
    WHERE t.token NOT IN (SELECT term FROM covered)
      AND t.token NOT IN (SELECT term FROM in_funnel)
      AND t.token NOT IN (SELECT term FROM stop)
  )
  SELECT
    f.token,
    count(*)                          AS frequency,
    count(DISTINCT f.source)          AS source_count,
    array_agg(DISTINCT f.source)      AS sources,
    (array_agg(f.title ORDER BY f.captured_at DESC))[1] AS sample_title,
    max(f.captured_at)                AS last_seen
  FROM filtered f
  GROUP BY f.token
  HAVING count(*) >= GREATEST(p_min_freq, 1)
  ORDER BY count(DISTINCT f.source) DESC, count(*) DESC
  LIMIT GREATEST(p_limit, 1);
$$;

-- ─────────────────────────────────────────
-- 2) seed ROI RPC
--    각 활성 seed 가 만들어낸 키워드/상품/평균 점수 집계.
--    keyword_group: source='naver_search_trend' AND keyword = ANY(config.keywords)
--    category:      source='naver_shopping_insight' AND category_top = config.name
--    keyword → alias(keyword) → product → 최신 score 로 productivity 측정.
CREATE OR REPLACE FUNCTION jimscanner_seed_radar_roi(
  p_days int DEFAULT 90
)
RETURNS TABLE (
  seed_id       uuid,
  source        text,
  kind          text,
  label         text,
  is_active     boolean,
  keyword_count bigint,
  product_count bigint,
  avg_final_score numeric,
  last_keyword_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH params AS (
    SELECT (now() - make_interval(days => GREATEST(p_days, 1)))::timestamptz AS since
  ),
  -- seed → 매칭된 키워드 row
  seed_kw AS (
    SELECT s.id AS seed_id, k.keyword, k.collected_at
    FROM jimscanner_trends_seeds s
    JOIN jimscanner_trends_keywords k
      ON (
           s.kind = 'keyword_group'
           AND k.source = 'naver_search_trend'
           AND lower(trim(k.keyword)) IN (
             SELECT lower(trim(kw))
             FROM jsonb_array_elements_text(COALESCE(s.config->'keywords','[]'::jsonb)) kw
           )
         )
      OR (
           s.kind = 'category'
           AND k.source = 'naver_shopping_insight'
           AND lower(trim(k.category_top)) = lower(trim(s.config->>'name'))
         )
    , params p
    WHERE k.collected_at >= p.since
  ),
  -- 매칭 키워드 → alias → product
  seed_prod AS (
    SELECT DISTINCT sk.seed_id, a.product_id
    FROM seed_kw sk
    JOIN jimscanner_trends_aliases a
      ON lower(trim(a.alias)) = lower(trim(sk.keyword))
     AND a.alias_type = 'keyword'
  ),
  -- product → 최신 final_score
  latest_score AS (
    SELECT DISTINCT ON (product_id) product_id, final_score
    FROM jimscanner_trends_scores
    ORDER BY product_id, computed_at DESC
  )
  SELECT
    s.id,
    s.source,
    s.kind,
    s.label,
    s.is_active,
    COUNT(DISTINCT sk.keyword)                       AS keyword_count,
    COUNT(DISTINCT sp.product_id)                    AS product_count,
    ROUND(AVG(ls.final_score), 1)                    AS avg_final_score,
    MAX(sk.collected_at)                             AS last_keyword_at
  FROM jimscanner_trends_seeds s
  LEFT JOIN seed_kw   sk ON sk.seed_id = s.id
  LEFT JOIN seed_prod sp ON sp.seed_id = s.id
  LEFT JOIN latest_score ls ON ls.product_id = sp.product_id
  GROUP BY s.id, s.source, s.kind, s.label, s.is_active, s.display_order
  ORDER BY product_count DESC, keyword_count DESC, s.display_order;
$$;

-- RLS: SECURITY DEFINER 이므로 service-role 외 노출 없음 (어드민 RPC 전용).
REVOKE ALL ON FUNCTION jimscanner_seed_radar_uncovered(int, int, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION jimscanner_seed_radar_roi(int) FROM PUBLIC, anon, authenticated;
