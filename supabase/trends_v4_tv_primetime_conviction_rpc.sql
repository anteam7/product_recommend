-- ────────────────────────────────────────────────────────────
-- TV 편성 골든타임 가중 — MD 확신도 RPC (PR-TVPRIME-1, 2026-05-29)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/tv-primetime 페이지
--
-- 배경: collect-naver-tvtime 가 각 홈쇼핑 슬롯의 방영 시각(HH:MM)을
--       jimscanner_trends_keywords.category 에 적재하지만 어떤 보드도
--       이 시간 차원을 점수화하지 않았다.
--
-- 골든타임 가중치 (홈쇼핑 MD 의 슬롯 배정 = 검증된 고확신 수요 신호):
--   18~23시(프라임)  = 1.00
--   07~17시(주간)    = 0.50
--   00~06시(새벽)    = 0.15
--
-- product(keyword) 별 집계:
--   conviction   = ∑(슬롯 가중치)  → MD 확신도
--   prime_share  = 프라임 슬롯 / 전체 슬롯
--   repeat_days  = 서로 다른 편성 일수 (반복 편성도)
--   top_slot     = 최빈 방영 시각 (다음 방영 카운트다운용)
--
-- service_role 로만 호출 (어드민 한정) — SECURITY DEFINER + grant 명시
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_tv_primetime_conviction(
  days_window int DEFAULT 14
)
RETURNS TABLE (
  keyword text,
  slot_count int,
  conviction real,
  prime_count int,
  prime_share real,
  repeat_days int,
  distinct_slots int,
  first_seen timestamptz,
  last_seen timestamptz,
  top_slot text,
  top_slot_hour int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH weighted AS (
    SELECT
      k.keyword,
      k.collected_at,
      k.category AS slot,
      (substring(k.category from '^([0-9]{1,2}):')::int) AS hr,
      CASE
        WHEN (substring(k.category from '^([0-9]{1,2}):')::int) BETWEEN 18 AND 23 THEN 1.0
        WHEN (substring(k.category from '^([0-9]{1,2}):')::int) BETWEEN 0 AND 6 THEN 0.15
        ELSE 0.5
      END AS w
    FROM jimscanner_trends_keywords k
    WHERE k.source = 'naver_tvtime'
      AND k.collected_at > now() - (days_window || ' days')::interval
      AND k.category ~ '^[0-9]{1,2}:[0-5][0-9]$'
  ),
  top_slots AS (
    SELECT
      keyword,
      slot,
      (substring(slot from '^([0-9]{1,2}):')::int) AS slot_hour,
      ROW_NUMBER() OVER (
        PARTITION BY keyword
        ORDER BY COUNT(*) DESC, slot
      ) AS rn
    FROM weighted
    GROUP BY keyword, slot
  )
  SELECT
    w.keyword,
    COUNT(*)::int AS slot_count,
    SUM(w.w)::real AS conviction,
    SUM(CASE WHEN w.hr BETWEEN 18 AND 23 THEN 1 ELSE 0 END)::int AS prime_count,
    (SUM(CASE WHEN w.hr BETWEEN 18 AND 23 THEN 1 ELSE 0 END)::real
      / NULLIF(COUNT(*), 0))::real AS prime_share,
    COUNT(DISTINCT date_trunc('day', w.collected_at))::int AS repeat_days,
    COUNT(DISTINCT w.slot)::int AS distinct_slots,
    MIN(w.collected_at) AS first_seen,
    MAX(w.collected_at) AS last_seen,
    ts.slot AS top_slot,
    ts.slot_hour AS top_slot_hour
  FROM weighted w
  LEFT JOIN top_slots ts ON ts.keyword = w.keyword AND ts.rn = 1
  GROUP BY w.keyword, ts.slot, ts.slot_hour
  ORDER BY conviction DESC, prime_count DESC
  LIMIT 300;
$$;

-- 어드민 service-role 만 호출 (anon/authenticated 차단)
REVOKE ALL ON FUNCTION jimscanner_tv_primetime_conviction(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_tv_primetime_conviction(int) TO service_role;
