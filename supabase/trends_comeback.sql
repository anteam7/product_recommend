-- ─────────────────────────────────────────────────────────────
-- 재출현(컴백) 신뢰 레이더 — jimscanner_trends_comeback VIEW (2026-06-04)
-- ─────────────────────────────────────────────────────────────
-- 목적: 각 product 의 score 시계열(jimscanner_trends_scores.computed_at)에서
--   '활성 → 휴면(N일 무신호) → 재활성' 갭을 윈도우 함수로 검출.
--   1회성 신규 시드와 달리 "전에도 떴다 다시 뜬" 상품 = 검증된 반복 수요 →
--   위탁 등록 후 폐기 위험이 낮음.
--
-- 산출 지표:
--   ① comeback_cycles      이전 버스트 사이클(휴면→재활성) 횟수
--   ② avg_dormancy_days    평균 재출현 간격(휴면 일수)
--   ③ last_dormancy_days   직전 휴면기간
--   ④ comeback_type        cyclical(반복형) / returning(복귀형) / one_off(우발형)
--
-- 정의:
--   - "활성일(active day)" = 해당 일자에 trend_score >= ACTIVE_THRESHOLD(40) 인 score row 존재
--   - "휴면 갭" = 연속 활성일 사이 간격 >= DORMANCY_DAYS(14일)
--   - "컴백" = 휴면 갭 직후의 재활성 발생
--
-- 노출 정책: service-role 만 (기존 jimscanner_trends_* 패턴, 어드민 read-only).
-- 관련 UI: /admin/trend-radar/comeback , opportunity 보드 'comeback' 칩.
-- ─────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS jimscanner_trends_comeback;

CREATE VIEW jimscanner_trends_comeback AS
WITH active_days AS (
  -- 활성으로 본 일자 (중복 제거)
  SELECT DISTINCT
    product_id,
    date_trunc('day', computed_at) AS day
  FROM jimscanner_trends_scores
  WHERE trend_score >= 40
),
gapped AS (
  SELECT
    product_id,
    day,
    LAG(day) OVER (PARTITION BY product_id ORDER BY day) AS prev_day
  FROM active_days
),
intervals AS (
  SELECT
    product_id,
    day,
    prev_day,
    CASE
      WHEN prev_day IS NOT NULL
      THEN (day::date - prev_day::date)
      ELSE NULL
    END AS gap_days
  FROM gapped
),
comebacks AS (
  -- 휴면(>=14일) 직후 재활성 = 한 번의 컴백 사이클
  SELECT
    product_id,
    day        AS comeback_at,
    gap_days   AS dormancy_days
  FROM intervals
  WHERE gap_days >= 14
),
agg AS (
  SELECT
    product_id,
    COUNT(*)                                                          AS comeback_cycles,
    ROUND(AVG(dormancy_days)::numeric, 1)                             AS avg_dormancy_days,
    MAX(comeback_at)                                                  AS last_comeback_at,
    (ARRAY_AGG(dormancy_days ORDER BY comeback_at DESC))[1]           AS last_dormancy_days
  FROM comebacks
  GROUP BY product_id
),
span AS (
  SELECT
    product_id,
    MIN(day)   AS first_active_at,
    MAX(day)   AS last_active_at,
    COUNT(*)   AS active_days
  FROM active_days
  GROUP BY product_id
),
recent AS (
  SELECT DISTINCT ON (product_id)
    product_id,
    trend_score   AS current_trend_score,
    final_score   AS current_final_score,
    computed_at   AS latest_at
  FROM jimscanner_trends_scores
  ORDER BY product_id, computed_at DESC
)
SELECT
  p.id                                  AS product_id,
  p.canonical_name,
  p.category_top,
  p.category_mid,
  p.first_seen_at,
  p.last_seen_at,
  a.comeback_cycles,
  a.avg_dormancy_days,
  a.last_dormancy_days,
  a.last_comeback_at,
  s.first_active_at,
  s.last_active_at,
  s.active_days,
  r.current_trend_score,
  r.current_final_score,
  r.latest_at,
  -- 현재 활성 여부 (가장 최근 score 가 활성 임계 이상)
  (r.current_trend_score >= 40)         AS is_currently_active,
  -- 분류:
  --   cyclical  : 2회 이상 컴백 + 현재 활성 + 직전 휴면이 평균 휴면 주기와 정합(0.5~1.8배)
  --   returning : 1회 이상 컴백 + 현재 활성 (복귀 중)
  --   one_off   : 컴백 이력은 있으나 현재 휴면 (우발형)
  CASE
    WHEN a.comeback_cycles >= 2
     AND r.current_trend_score >= 40
     AND a.last_dormancy_days BETWEEN a.avg_dormancy_days * 0.5 AND a.avg_dormancy_days * 1.8
      THEN 'cyclical'
    WHEN a.comeback_cycles >= 1 AND r.current_trend_score >= 40
      THEN 'returning'
    ELSE 'one_off'
  END                                   AS comeback_type
FROM jimscanner_trends_products p
JOIN agg  a ON a.product_id = p.id
JOIN span s ON s.product_id = p.id
LEFT JOIN recent r ON r.product_id = p.id
WHERE a.comeback_cycles >= 1
ORDER BY
  a.comeback_cycles DESC,
  (r.current_trend_score >= 40) DESC NULLS LAST,
  a.last_comeback_at DESC NULLS LAST;

COMMENT ON VIEW jimscanner_trends_comeback IS
  '재출현(컴백) 레이더: score 시계열에서 활성→휴면(>=14일)→재활성 갭을 검출해 반복 수요 상품을 발굴. UI: /admin/trend-radar/comeback';
