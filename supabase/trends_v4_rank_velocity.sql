-- ────────────────────────────────────────────────────────────
-- 순위 상승 속도(Rank Velocity) 뷰 — 2026-06-02
-- ────────────────────────────────────────────────────────────
-- 랭킹형 소스(musinsa_best / naver_shopping_hot / ppomppu_main /
-- natepan_ranking / dcinside_realtime / naver_tvtime 등)는
-- jimscanner_trends_keywords.rank 에 하루 2회 순위 스냅샷이 쌓인다.
-- 절대 점수/볼륨만 쓰던 기존 보드와 달리, 본 뷰는 '순위의 가속'을 본다.
--
-- (keyword, source, day) 별 MIN(rank) 로 일자 베스트 순위를 만든 뒤
--   · slope_per_day : rank ~ day 선형회귀 기울기 (음수 = 순위 상승 중)
--   · velocity      : -slope (양수 = 빠르게 상승)
--   · jump          : first_rank - current_rank (양수 = 진입 후 상승폭)
-- 를 (keyword, source) 단위로 집계한다.
--
-- 사용처: /admin/trend-radar/rank-velocity 페이지 (read-only 어드민)
-- 노출 정책: 기존 jimscanner_trends_* 패턴과 동일하게 service_role 만 접근.
--   (뷰는 security_invoker=off 기본 → 소유자 권한으로 base 테이블 RLS 우회,
--    service_role 역시 RLS 우회. anon/authenticated 는 GRANT 로 차단.)
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW jimscanner_trends_rank_velocity AS
WITH daily AS (
  -- 하루(KST) 안에서 여러 스냅샷이 있으면 그 날의 '베스트(가장 작은) 순위'를 채택
  SELECT
    k.keyword,
    k.source,
    (k.collected_at AT TIME ZONE 'Asia/Seoul')::date AS day,
    MIN(k.rank) AS best_rank
  FROM jimscanner_trends_keywords k
  WHERE k.rank IS NOT NULL
    AND k.collected_at >= now() - interval '21 days'
  GROUP BY k.keyword, k.source, (k.collected_at AT TIME ZONE 'Asia/Seoul')::date
),
agg AS (
  SELECT
    d.keyword,
    d.source,
    COUNT(*)::int                                       AS days_present,
    MIN(d.day)                                          AS first_day,
    MAX(d.day)                                          AS last_day,
    (array_agg(d.best_rank ORDER BY d.day ASC))[1]      AS first_rank,
    (array_agg(d.best_rank ORDER BY d.day DESC))[1]     AS current_rank,
    MIN(d.best_rank)::int                               AS peak_rank,
    -- rank 를 day 인덱스(일 단위)에 회귀. 순위가 내려가면(=상승) 음의 기울기.
    regr_slope(d.best_rank, EXTRACT(EPOCH FROM d.day) / 86400.0) AS slope_per_day
  FROM daily d
  GROUP BY d.keyword, d.source
)
SELECT
  a.keyword,
  a.source,
  a.days_present,
  a.first_day,
  a.last_day,
  a.first_rank,
  a.current_rank,
  a.peak_rank,
  (a.first_rank - a.current_rank)::int           AS jump,            -- 양수 = 진입 후 상승
  ROUND(COALESCE(a.slope_per_day, 0)::numeric, 3) AS slope_per_day,  -- 음수 = 상승 중
  ROUND((-COALESCE(a.slope_per_day, 0))::numeric, 3) AS velocity,    -- 양수 = 빠르게 상승
  -- 신규 진입(최근 7일 내 첫 등장) 여부
  (a.first_day >= ((now() AT TIME ZONE 'Asia/Seoul')::date - 7)) AS is_new_entry
FROM agg a;

-- 어드민 service-role 만 (anon/authenticated 차단)
REVOKE ALL ON jimscanner_trends_rank_velocity FROM PUBLIC;
GRANT SELECT ON jimscanner_trends_rank_velocity TO service_role;
