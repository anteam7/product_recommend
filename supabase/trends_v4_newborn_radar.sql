-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 신생 신호 콜드스타트 조기포착 (PR-NEWBORN, 2026-06-02)
-- ─────────────────────────────────────────────────────────────
-- 문제: jimscanner_trends_scores 는 30일 누적 + 일 1회 recompute 라
--   방금 처음 등장한 토큰은 final_score=0 또는 history 부재로 radar 상위에
--   "구조적으로" 못 올라온다(콜드스타트 사각지대).
--
-- 해법: 점수(score) 대신 '나이(age)' 차원으로 발굴 윈도우를 연다.
--   first_seen_at 이 24~72h 이내인 '신생 토큰'만 골라 3축으로 '떡잎 등급' 부여:
--     (a) 등장 후 재언급 가속  — 첫 6h vs 다음 24h 언급 빈도 비율
--     (b) 교차소스 폭          — alias 매칭 keyword 의 distinct source 수
--     (c) ggsan 즉시 소싱 가능 — canonical_name ↔ ggsan title trgm 유사도
--   노이즈(1회성 단발)는 'noise' 로 강등 → UI 회색 처리.
--
-- 호출: src/app/admin/trend-radar/newborn/page.tsx (read-only, service-role)
-- 의존: pg_trgm (trends_v4_ggsan.sql 에서 이미 CREATE EXTENSION)
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_trends_newborn(
  hours_min     int DEFAULT 0,    -- 하한 (예: 0 = 방금 등장한 것 포함)
  hours_max     int DEFAULT 72,   -- 상한 (예: 72 = 첫 등장 후 3일 이내)
  result_limit  int DEFAULT 120,
  ggsan_min_sim numeric DEFAULT 0.30
)
RETURNS TABLE (
  product_id      uuid,
  canonical_name  text,
  category_top    text,
  first_seen_at   timestamptz,
  age_hours       numeric,
  alias_count     int,
  source_breadth  int,
  mentions_early  int,
  mentions_late   int,
  accel_ratio     numeric,
  ggsan_available boolean,
  ggsan_best_sim  numeric,
  ggsan_min_price integer,
  sprout_grade    text
)
LANGUAGE sql
STABLE
AS $$
  WITH newborn AS (
    SELECT
      p.id,
      p.canonical_name,
      p.category_top,
      p.first_seen_at,
      p.alias_count,
      ROUND(EXTRACT(EPOCH FROM (now() - p.first_seen_at)) / 3600.0, 1) AS age_hours
    FROM jimscanner_trends_products p
    WHERE p.first_seen_at <= now() - make_interval(hours => hours_min)
      AND p.first_seen_at >= now() - make_interval(hours => hours_max)
  ),
  -- alias 텍스트 (keyword 타입 위주) — 재언급/교차소스 측정 키
  alias_keys AS (
    SELECT a.product_id, a.alias
    FROM jimscanner_trends_aliases a
    JOIN newborn n ON n.id = a.product_id
  ),
  -- alias 와 매칭되는 원시 키워드 수집 시각/소스
  mentions AS (
    SELECT
      ak.product_id,
      k.source,
      k.collected_at,
      n.first_seen_at
    FROM alias_keys ak
    JOIN jimscanner_trends_keywords k ON k.keyword = ak.alias
    JOIN newborn n ON n.id = ak.product_id
  ),
  agg AS (
    SELECT
      m.product_id,
      COUNT(DISTINCT m.source) AS source_breadth,
      COUNT(*) FILTER (
        WHERE m.collected_at <  m.first_seen_at + interval '6 hours'
      ) AS mentions_early,
      COUNT(*) FILTER (
        WHERE m.collected_at >= m.first_seen_at + interval '6 hours'
          AND m.collected_at <  m.first_seen_at + interval '30 hours'
      ) AS mentions_late
    FROM mentions m
    GROUP BY m.product_id
  ),
  -- ggsan 즉시 소싱 가능 여부 (canonical_name ↔ ggsan title trgm)
  ggsan AS (
    SELECT
      n.id AS product_id,
      MAX(similarity(n.canonical_name, g.title)) AS best_sim,
      MIN(g.price_krw) FILTER (
        WHERE similarity(n.canonical_name, g.title) >= ggsan_min_sim
      ) AS min_price
    FROM newborn n
    JOIN jimscanner_ggsan_products g
      ON g.title % n.canonical_name
     AND g.status <> 'removed'
    GROUP BY n.id
  )
  SELECT
    n.id            AS product_id,
    n.canonical_name,
    n.category_top,
    n.first_seen_at,
    n.age_hours,
    n.alias_count,
    COALESCE(a.source_breadth, 0)                       AS source_breadth,
    COALESCE(a.mentions_early, 0)                       AS mentions_early,
    COALESCE(a.mentions_late, 0)                        AS mentions_late,
    -- 가속비: (후기 시간당 빈도) / (초기 시간당 빈도)
    --   초기 6h, 후기 24h 기준 정규화. 초기 0건이면 후기 존재만으로 큰 가속(=후기/1).
    CASE
      WHEN COALESCE(a.mentions_early, 0) = 0
        THEN COALESCE(a.mentions_late, 0)::numeric
      ELSE ROUND(
        (COALESCE(a.mentions_late, 0) / 24.0) /
        (a.mentions_early / 6.0), 2)
    END                                                 AS accel_ratio,
    (gg.best_sim >= ggsan_min_sim)                      AS ggsan_available,
    ROUND(COALESCE(gg.best_sim, 0)::numeric, 3)         AS ggsan_best_sim,
    gg.min_price                                        AS ggsan_min_price,
    -- 떡잎 등급
    CASE
      -- 노이즈: 재언급 전무 + alias 단발 + 단일 소스 → 1회성 단발
      WHEN COALESCE(a.mentions_late, 0) = 0
       AND n.alias_count <= 1
       AND COALESCE(a.source_breadth, 0) <= 1
        THEN 'noise'
      -- A: 가속 + 교차소스 + 즉시 소싱 (선점 0순위)
      WHEN COALESCE(a.mentions_late, 0) > COALESCE(a.mentions_early, 0)
       AND COALESCE(a.source_breadth, 0) >= 2
       AND COALESCE(gg.best_sim, 0) >= ggsan_min_sim
        THEN 'A'
      -- B: 가속 또는 교차소스 둘 중 하나 충족
      WHEN COALESCE(a.mentions_late, 0) > COALESCE(a.mentions_early, 0)
        OR COALESCE(a.source_breadth, 0) >= 2
        THEN 'B'
      ELSE 'C'
    END                                                 AS sprout_grade
  FROM newborn n
  LEFT JOIN agg   a  ON a.product_id  = n.id
  LEFT JOIN ggsan gg ON gg.product_id = n.id
  ORDER BY
    -- noise 는 항상 맨 아래, 그 위는 (등급, 가속, 신선도) 순
    (CASE WHEN sprout_grade = 'noise' THEN 1 ELSE 0 END),
    (CASE sprout_grade WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 ELSE 3 END),
    accel_ratio DESC,
    n.first_seen_at DESC
  LIMIT result_limit;
$$;

-- service-role 만 호출 (어드민). anon 권한 부여 안 함.
REVOKE ALL ON FUNCTION jimscanner_trends_newborn(int, int, int, numeric) FROM PUBLIC;
