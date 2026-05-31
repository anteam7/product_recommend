-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 휴면 후 재급등 '부활 상품' 발굴 (2026-05-31)
-- ─────────────────────────────────────────────────────────────
-- 목적: jimscanner_trends_scores 의 시계열(매 recompute 마다 새 row)을
--   product_id 별로 펼쳐 '다봉(multi-peak)' 패턴을 탐지한다.
--
--   ① 과거 1회 이상 피크(trend_score 가 PEAK_THRESHOLD 이상) →
--   ② ≥N주 임계 이하 휴면(dormancy gap) →
--   ③ 현재 재가속(최근 trend_score 기울기 양전환)
--   3박자를 만족하면 '부활 후보'.
--
-- 본 SQL 은 per-product 시계열 요약(prev_peak / dormancy 통계)을 노출하는 뷰를 만든다.
-- 정밀한 봉우리-걷기(peak walking) 와 N번째 부활 판정은 앱(page.tsx)에서
--   원시 시계열을 받아 계산한다 (RLS: service-role 만 read).
--
-- 노출 정책: 기반 테이블(jimscanner_trends_scores)이 RLS service-role 전용이므로
--   뷰도 동일하게 service-role(어드민)만 접근.
-- 관련: docs/trend-radar-upgrade-design.md, src/app/admin/(dashboard)/trend-radar/resurgence
-- ─────────────────────────────────────────────────────────────

-- 튜닝 상수 (앱과 동기화 — page.tsx RESURGENCE_PARAMS 참고)
--   PEAK_THRESHOLD     trend_score >= 55  → 피크로 인정
--   DORMANT_THRESHOLD  trend_score <= 30  → 휴면으로 인정
--   MIN_GAP_WEEKS      ≥ 3주 휴면해야 'gap' 인정
--   RECENT_WINDOW      최근 4 row 의 기울기로 재가속 판정

CREATE OR REPLACE VIEW jimscanner_trends_resurgence_v AS
WITH series AS (
  SELECT
    s.product_id,
    s.trend_score,
    s.final_score,
    s.computed_at,
    -- 시계열 내 위치
    row_number() OVER (PARTITION BY s.product_id ORDER BY s.computed_at) AS seq,
    count(*)     OVER (PARTITION BY s.product_id)                        AS n_points,
    first_value(s.computed_at) OVER (PARTITION BY s.product_id ORDER BY s.computed_at DESC) AS last_at
  FROM jimscanner_trends_scores s
),
agg AS (
  SELECT
    product_id,
    max(n_points)                                              AS n_points,
    max(last_at)                                               AS last_at,
    -- 전체 기간 중 최고 피크(현재 제외 위해 last 4 row 빼고 측정)
    max(trend_score) FILTER (WHERE seq <= n_points - 4)        AS prev_peak_trend,
    max(final_score) FILTER (WHERE seq <= n_points - 4)        AS prev_peak_final,
    -- 현재(최신) 값
    max(trend_score) FILTER (WHERE seq = n_points)             AS current_trend,
    max(final_score) FILTER (WHERE seq = n_points)             AS current_final,
    -- 휴면 깊이: 과거 구간 최저점
    min(trend_score) FILTER (WHERE seq <= n_points - 4)        AS trough_trend
  FROM series
  GROUP BY product_id
)
SELECT
  a.product_id,
  a.n_points,
  a.last_at,
  a.prev_peak_trend,
  a.prev_peak_final,
  a.current_trend,
  a.current_final,
  a.trough_trend,
  -- 거친 부활 후보 플래그 (앱에서 정밀 재판정)
  (a.prev_peak_trend >= 55
   AND a.trough_trend <= 30
   AND a.current_trend >= 40
   AND a.n_points >= 6) AS resurgence_candidate
FROM agg a
WHERE a.n_points >= 4;

COMMENT ON VIEW jimscanner_trends_resurgence_v IS
  '부활(휴면 후 재급등) 후보 거친 1차 필터. 정밀 다봉/N번째 판정은 앱에서 원시 시계열로 수행.';
