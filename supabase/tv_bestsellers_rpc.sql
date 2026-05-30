-- ────────────────────────────────────────────────────────────
-- TV홈쇼핑 재편성 빈도 = 검증된 베스트셀러 발굴 RPC (2026-05-30)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/tv-bestsellers
--
-- 통찰: 홈쇼핑 1시간 슬롯은 수천만원 → MD는 '직전 방송에서 매출목표를
-- 친 상품만' 재편성한다. 따라서 "반복 재편성 빈도"는 검색량(구경꾼 포함)·
-- 리뷰(후행)보다 누수가 적은 *실판매 프록시*다.
--
-- 핵심 단위: '방송회차(broadcast occasion)' = DISTINCT (날짜, 시간슬롯).
--   하루 2회 스냅샷(collected_at)이라 단순 row COUNT 는 중복 → DISTINCT 필요.
--
-- 점수 3축:
--   ① 주간 편성회차(runs_7d)        = 재판매 강도
--   ② 가속도(이번주/지난주)          = 모멘텀
--   ③ 슬롯 다양성(아침/프라임 분산)  = 채널 확신도
--
-- 출력: TV 베스트셀러 후보 + ggsan 도매 소싱 가용 여부(trigram JOIN).
--   → '검증된 홈쇼핑 위너 × 도매소싱 가능' 상품만 surface.
--
-- V1 보강 예정: 쿠팡 포화도 페널티(쿠팡 등록상품수 테이블 신설 후),
--   collect-naver-tvtime 채널명 파싱 시 '멀티채널 재편성 합의' 컬럼.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_tv_bestsellers(
  min_runs int DEFAULT 2,        -- 30일 내 최소 방송회차 (1회성 노이즈 컷)
  min_sim float DEFAULT 0.20,    -- ggsan title trigram 최소 유사도
  result_limit int DEFAULT 150
)
RETURNS TABLE (
  keyword text,
  runs_7d int,
  runs_14d int,
  runs_30d int,
  prev_week_runs int,            -- 7~14일 전 방송회차 (가속도 분모)
  acceleration real,             -- (runs_7d+1)/(prev_week_runs+1)
  slot_diversity int,            -- 등장한 시간대 밴드 수 (1~5)
  slot_bands text[],             -- ['아침','프라임'] 등
  total_pushes_30d int,          -- 원본 row 수 (참고용)
  first_seen timestamptz,
  last_seen timestamptz,
  spark int[],                   -- 최근 14일 일별 방송회차 (스파크라인)
  -- ggsan 소싱 가용
  ggsan_goods_no text,
  ggsan_title text,
  ggsan_price_krw int,
  ggsan_cate_label text,
  ggsan_is_imminent boolean,
  ggsan_detail_url text,
  ggsan_sim real,
  bestseller_score real
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  -- 0) naver_tvtime 30일 원본 + 시간대 밴드 라벨링
  occ AS (
    SELECT
      keyword,
      collected_at::date AS d,
      COALESCE(NULLIF(category, ''), 'unknown') AS slot,
      collected_at,
      CASE
        WHEN category IS NULL OR category = '' THEN '미상'
        WHEN split_part(category, ':', 1)::int < 6  THEN '새벽'
        WHEN split_part(category, ':', 1)::int < 11 THEN '아침'
        WHEN split_part(category, ':', 1)::int < 17 THEN '낮'
        WHEN split_part(category, ':', 1)::int < 20 THEN '저녁'
        ELSE '프라임'
      END AS band
    FROM jimscanner_trends_keywords
    WHERE source = 'naver_tvtime'
      AND collected_at > now() - interval '30 days'
      AND category ~ '^[0-2]?[0-9]:[0-5][0-9]$'  -- 시간 슬롯 형식만
  ),
  -- 1) 방송회차 = DISTINCT (keyword, 날짜, 슬롯) — 스냅샷 중복 제거
  distinct_occ AS (
    SELECT DISTINCT keyword, d, slot, band FROM occ
  ),
  -- 2) 키워드별 rolling 집계
  agg AS (
    SELECT
      o.keyword,
      COUNT(*) FILTER (WHERE o.d >  (now() - interval '7 days')::date)::int  AS runs_7d,
      COUNT(*) FILTER (WHERE o.d >  (now() - interval '14 days')::date)::int AS runs_14d,
      COUNT(*)::int AS runs_30d,
      COUNT(*) FILTER (
        WHERE o.d >  (now() - interval '14 days')::date
          AND o.d <= (now() - interval '7 days')::date
      )::int AS prev_week_runs,
      COUNT(DISTINCT o.band)::int AS slot_diversity,
      ARRAY_AGG(DISTINCT o.band ORDER BY o.band) AS slot_bands
    FROM distinct_occ o
    GROUP BY o.keyword
  ),
  -- 3) 원본 row 수 + 등장 구간
  raw_stats AS (
    SELECT keyword, COUNT(*)::int AS total_pushes_30d,
           MIN(collected_at) AS first_seen, MAX(collected_at) AS last_seen
    FROM occ GROUP BY keyword
  ),
  -- 4) 최근 14일 일별 방송회차 스파크라인 (빈 날은 0)
  spark_days AS (
    SELECT keyword, d, COUNT(DISTINCT slot)::int AS c
    FROM distinct_occ
    WHERE d > (now() - interval '14 days')::date
    GROUP BY keyword, d
  ),
  spark AS (
    SELECT k.keyword,
      ARRAY_AGG(COALESCE(sd.c, 0) ORDER BY g.day) AS spark
    FROM (SELECT DISTINCT keyword FROM distinct_occ) k
    CROSS JOIN generate_series(
      (now() - interval '13 days')::date,
      now()::date,
      interval '1 day'
    ) AS g(day)
    LEFT JOIN spark_days sd ON sd.keyword = k.keyword AND sd.d = g.day::date
    GROUP BY k.keyword
  ),
  -- 5) ggsan 도매 최적 매칭 1건 (소싱 가용 여부)
  ggsan AS (
    SELECT a.keyword, gp.goods_no, gp.title, gp.price_krw, gp.cate_label,
           gp.is_imminent, gp.detail_url, gp.sim
    FROM agg a
    LEFT JOIN LATERAL (
      SELECT g.goods_no, g.title, g.price_krw, g.cate_label, g.is_imminent,
             g.detail_url, similarity(a.keyword, g.title)::real AS sim
      FROM jimscanner_ggsan_products g
      WHERE g.title % a.keyword
        AND similarity(a.keyword, g.title) >= min_sim
      ORDER BY similarity(a.keyword, g.title) DESC
      LIMIT 1
    ) gp ON true
  )
  SELECT
    a.keyword,
    a.runs_7d,
    a.runs_14d,
    a.runs_30d,
    a.prev_week_runs,
    ((a.runs_7d + 1)::real / (a.prev_week_runs + 1))::real AS acceleration,
    a.slot_diversity,
    a.slot_bands,
    r.total_pushes_30d,
    r.first_seen,
    r.last_seen,
    sp.spark,
    g.goods_no AS ggsan_goods_no,
    g.title AS ggsan_title,
    g.price_krw AS ggsan_price_krw,
    g.cate_label AS ggsan_cate_label,
    g.is_imminent AS ggsan_is_imminent,
    g.detail_url AS ggsan_detail_url,
    g.sim AS ggsan_sim,
    -- bestseller_score: 주간강도 × 가속도(상한3) × (1 + 다양성보너스)
    (
      (a.runs_7d * 1.0 + a.runs_14d * 0.3)
      * LEAST(((a.runs_7d + 1)::real / (a.prev_week_runs + 1)), 3.0)
      * (1 + 0.15 * a.slot_diversity)
    )::real AS bestseller_score
  FROM agg a
  JOIN raw_stats r ON r.keyword = a.keyword
  LEFT JOIN spark sp ON sp.keyword = a.keyword
  LEFT JOIN ggsan g ON g.keyword = a.keyword
  WHERE a.runs_30d >= min_runs
  ORDER BY bestseller_score DESC
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_tv_bestsellers(int, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_tv_bestsellers(int, float, int) TO service_role;
