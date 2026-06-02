-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 협찬·바이럴 어뷰징 의심 게이트 (PR-astroturf, 2026-06-03)
-- ─────────────────────────────────────────────────────────────
-- 목적: 커뮤니티 출처(ppomppu/dcinside/82cook/natepan/clien/quasarzone/kca/blog)에서
--   '여러 출처에 동시에 같은 문구로 떴다'를 수요 확증이 아니라 인위적 코디네이션(협찬·뒷광고·
--   바이럴 푸시) 신호로 재해석하는 보완 게이트.
--
-- 기존 삼각검증(#3)은 다출처=확증으로 보지만, 동시·동일문구 버스트는 정반대 함정.
-- astroturf_score(0~100)가 높을수록 가짜 트렌드 의심 → final_score 디스카운트 + UI 경고.
--
-- 피처:
--   ① concurrency      : 여러 커뮤니티에 짧은 창(기본 48h) 내 동시 첫등장
--   ② phrase_similarity : payload 텍스트 pg_trgm 유사도(복붙·정형 카피 탐지)
--   ③ organic_unconfirmed: 커뮤니티는 폭발인데 naver_search_trend/shopping_insight volume 평탄
--   ④ no_ramp          : 사전 램프(점진 누적) 없는 급발진
--
-- D5/D7: 운영자 전용. RLS enable + 정책 정의 X = service-role 만 접근(기존 패턴 동일).
-- 적용: psql + PGPASSWORD (docs/database.md), pg_trgm 확장 필요.
-- ─────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─────────────────────────────────────────────────────────────
-- 0) 커뮤니티 vs 유기(검색/쇼핑) 출처 분류 헬퍼
--    커뮤니티: 인위적 푸시가 가능한 게시판/언론. 유기: 사용자 검색·구매 신호.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_trends_is_community_source(p_source text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_source = ANY (ARRAY[
    'ppomppu','dcinside','82cook','natepan',
    'clien_park','clien','quasarzone_sale','quasarzone',
    'kca_press','naver_blog','naver_news'
  ]);
$$;

CREATE OR REPLACE FUNCTION jimscanner_trends_is_organic_source(p_source text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_source = ANY (ARRAY[
    'naver_search_trend','naver_shopping_insight','naver_shopping_trends','google_trends_kr'
  ]);
$$;

-- ─────────────────────────────────────────────────────────────
-- 1) 키워드별 어뷰징 의심 점수 뷰
--    jimscanner_trends_keywords 의 시계열 첫등장/볼륨을 교차.
--    최근 14일 윈도우 기준. UI/recompute 크론이 이 뷰를 읽음.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW jimscanner_trends_astroturf_candidates AS
WITH recent AS (
  SELECT
    lower(btrim(keyword)) AS keyword_norm,
    keyword,
    source,
    volume_relative,
    collected_at
  FROM jimscanner_trends_keywords
  WHERE collected_at >= now() - interval '14 days'
    AND keyword IS NOT NULL
    AND btrim(keyword) <> ''
),
-- 커뮤니티 출처별 첫등장 시각
community_first AS (
  SELECT keyword_norm, source, min(collected_at) AS first_at, count(*) AS hits
  FROM recent
  WHERE jimscanner_trends_is_community_source(source)
  GROUP BY keyword_norm, source
),
-- 키워드별 커뮤니티 동시성 집계
concurrency AS (
  SELECT
    keyword_norm,
    count(DISTINCT source)                            AS community_sources,
    min(first_at)                                     AS earliest_at,
    max(first_at)                                     AS latest_first_at,
    -- 첫등장 시각 최대 간격(시간). 작을수록 동시발화 = 의심.
    EXTRACT(EPOCH FROM (max(first_at) - min(first_at))) / 3600.0 AS spread_hours
  FROM community_first
  GROUP BY keyword_norm
),
-- 유기(검색/쇼핑) 신호 최대 볼륨
organic AS (
  SELECT keyword_norm, max(coalesce(volume_relative, 0)) AS organic_volume,
         count(*) AS organic_hits
  FROM recent
  WHERE jimscanner_trends_is_organic_source(source)
  GROUP BY keyword_norm
),
-- 램프 진단: 첫등장 이전(키워드 최초 이력 대비) 점진 누적이 있었는지.
-- 전체 이력에서 커뮤니티 첫등장 7일 전 mention 수.
ramp AS (
  SELECT
    lower(btrim(k.keyword)) AS keyword_norm,
    count(*) FILTER (
      WHERE k.collected_at < c.earliest_at
        AND k.collected_at >= c.earliest_at - interval '7 days'
    ) AS pre_ramp_hits
  FROM jimscanner_trends_keywords k
  JOIN concurrency c ON c.keyword_norm = lower(btrim(k.keyword))
  GROUP BY lower(btrim(k.keyword))
)
SELECT
  c.keyword_norm,
  (SELECT cf.source FROM community_first cf WHERE cf.keyword_norm = c.keyword_norm ORDER BY cf.first_at LIMIT 1) AS first_source,
  c.community_sources,
  c.earliest_at,
  c.spread_hours,
  coalesce(o.organic_volume, 0)   AS organic_volume,
  coalesce(o.organic_hits, 0)     AS organic_hits,
  coalesce(r.pre_ramp_hits, 0)    AS pre_ramp_hits,

  -- ① concurrency feature 0~100: 2개 이상 커뮤니티가 48h 내 동시 첫등장이면 높음.
  LEAST(100, GREATEST(0,
    CASE
      WHEN c.community_sources < 2 THEN 0
      ELSE (c.community_sources - 1) * 25
           * GREATEST(0.2, 1 - LEAST(1, c.spread_hours / 48.0))
    END
  ))::numeric AS f_concurrency,

  -- ③ organic_unconfirmed 0~100: 커뮤니티는 다출처인데 유기 볼륨 평탄(<20)일수록 높음.
  CASE
    WHEN c.community_sources >= 2 AND coalesce(o.organic_volume, 0) < 20
      THEN LEAST(100, (2 - coalesce(o.organic_volume, 0) / 20.0) * 50)
    ELSE 0
  END::numeric AS f_organic_unconfirmed,

  -- ④ no_ramp 0~100: 사전 7일 누적이 거의 없는 급발진일수록 높음.
  CASE
    WHEN coalesce(r.pre_ramp_hits, 0) = 0 AND c.community_sources >= 2 THEN 70
    WHEN coalesce(r.pre_ramp_hits, 0) <= 1 AND c.community_sources >= 2 THEN 40
    ELSE 0
  END::numeric AS f_no_ramp
FROM concurrency c
LEFT JOIN organic o ON o.keyword_norm = c.keyword_norm
LEFT JOIN ramp r    ON r.keyword_norm = c.keyword_norm
WHERE c.community_sources >= 2;   -- 단일 출처는 코디네이션 대상 아님

-- ─────────────────────────────────────────────────────────────
-- 2) phrase_similarity(②) — payload 텍스트 복붙/정형 카피 탐지 RPC
--    raw payload 를 텍스트화해 키워드 포함 mention 들끼리 pg_trgm 평균 유사도.
--    높을수록 복붙 의심. 무거운 연산이라 후보 키워드에 대해서만 호출.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_trends_phrase_similarity(p_keyword text)
RETURNS numeric LANGUAGE sql STABLE AS $$
  WITH texts AS (
    SELECT left(lower(payload::text), 2000) AS body
    FROM jimscanner_trends_raw
    WHERE collected_at >= now() - interval '14 days'
      AND jimscanner_trends_is_community_source(source)
      AND payload::text ILIKE '%' || p_keyword || '%'
    LIMIT 30
  ),
  pairs AS (
    SELECT similarity(a.body, b.body) AS sim
    FROM texts a
    JOIN texts b ON a.body < b.body
  )
  SELECT round(coalesce(avg(sim), 0) * 100, 1)::numeric FROM pairs;
$$;

-- ─────────────────────────────────────────────────────────────
-- 3) astroturf_score 종합 RPC — 4피처 가중 합산(0~100)
--    가중치: concurrency .30 / phrase_similarity .30 / organic_unconfirmed .25 / no_ramp .15
--    recompute 크론·UI 가 호출. 후보 + 종합 점수 + 피처 breakdown 반환.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_trends_astroturf_scores(p_min_score numeric DEFAULT 0)
RETURNS TABLE (
  keyword_norm text,
  first_source text,
  community_sources int,
  earliest_at timestamptz,
  spread_hours numeric,
  organic_volume numeric,
  pre_ramp_hits int,
  f_concurrency numeric,
  f_phrase_similarity numeric,
  f_organic_unconfirmed numeric,
  f_no_ramp numeric,
  astroturf_score numeric
) LANGUAGE sql STABLE AS $$
  SELECT
    c.keyword_norm,
    c.first_source,
    c.community_sources::int,
    c.earliest_at,
    round(c.spread_hours, 1),
    c.organic_volume,
    c.pre_ramp_hits::int,
    round(c.f_concurrency, 1),
    jimscanner_trends_phrase_similarity(c.keyword_norm) AS f_phrase_similarity,
    round(c.f_organic_unconfirmed, 1),
    round(c.f_no_ramp, 1),
    round(
      c.f_concurrency * 0.30
      + jimscanner_trends_phrase_similarity(c.keyword_norm) * 0.30
      + c.f_organic_unconfirmed * 0.25
      + c.f_no_ramp * 0.15
    , 1) AS astroturf_score
  FROM jimscanner_trends_astroturf_candidates c
  WHERE round(
      c.f_concurrency * 0.30
      + jimscanner_trends_phrase_similarity(c.keyword_norm) * 0.30
      + c.f_organic_unconfirmed * 0.25
      + c.f_no_ramp * 0.15
    , 1) >= p_min_score
  ORDER BY astroturf_score DESC;
$$;

-- ─────────────────────────────────────────────────────────────
-- 4) 증거 타임라인 RPC — 후보 클릭 시 동시발화 멘션 원문 표시
--    커뮤니티별 첫등장 + payload 발췌를 시각순으로.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_trends_astroturf_evidence(p_keyword text)
RETURNS TABLE (
  source text,
  collected_at timestamptz,
  snippet text
) LANGUAGE sql STABLE AS $$
  SELECT
    r.source,
    r.collected_at,
    left(regexp_replace(r.payload::text, '\s+', ' ', 'g'), 400) AS snippet
  FROM jimscanner_trends_raw r
  WHERE r.collected_at >= now() - interval '14 days'
    AND jimscanner_trends_is_community_source(r.source)
    AND r.payload::text ILIKE '%' || p_keyword || '%'
  ORDER BY r.collected_at ASC
  LIMIT 60;
$$;

-- ─────────────────────────────────────────────────────────────
-- 적용 후: recompute 크론(scripts 의 score 재계산 흐름)에서
--   astroturf_score >= 40 인 키워드를 alias 로 가진 product 의 final_score 를
--   discount 하고 score_components.authenticity 에 {astroturf_score, features} 기록.
--   (SQL 단독으로는 product 매핑이 alias 정규화에 의존하므로 크론에서 수행)
-- ─────────────────────────────────────────────────────────────
