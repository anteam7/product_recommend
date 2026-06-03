-- ────────────────────────────────────────────────────────────
-- 수요 반감기 × 소싱 리드타임 — 타임투마켓 도착가능성 게이트 (2026-06-04)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/time-to-market
--
-- 핵심 질문: "지금 소싱 주문 → 도착 시점에 트렌드 수요가 얼마나 남아있나?"
--
-- 위탁(consignment)은 재고 선매입이 없어 '수요 포착 → 주문 → 도착'이 본질.
-- 도매 lead_time_days 안에 수요가 꺼지면 도착 즉시 사장 재고가 된다.
--
-- 입력 신호:
--   1) jimscanner_trends_scores 시계열 (product_id별 final_score / computed_at 추이)
--      → 상승 후 감쇠율을 지수적합해 '수요 반감기(half_life_days)' 추정
--   2) jimscanner_trends_supplier.lead_time_days (현재 어느 보드도 미사용)
--      → product별 최단 도매 리드타임
--   3) reg_days 상수 (~2일, 쿠팡 등록·승인 소요)
--
-- 산출(per-product):
--   half_life_days          수요 반감기 (피크 대비 현재까지의 지수 감쇠율 → ln2/decay)
--   residual_life_days      현재 수요가 floor_score로 떨어질 때까지 남은 일수
--   best_lead_time          최단 도매 리드타임 (supplier 없으면 NULL)
--   arrival_residual_ratio  도착 시점(=lead+reg)에 남는 현재 수요 비율 exp(-decay·total)
--   verdict                 'ample'(여유) | 'safe'(안전) | 'late'(늦음) | 'unknown'(리드타임 미상)
--
-- 감쇠 모델: score(t) = peak · exp(-decay·(t - peak_at))
--   decay = ln(peak/current) / days_since_peak   (현재 < 피크, 0.5일 이상 경과 시)
--   상승/평탄 구간(현재 ≥ 피크)은 감쇠 미정의 → 잔존수명 open-ended, 도착비율 1.0
--
-- 노출 정책: service-role 전용 (기존 trends_* 패턴 동일)
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_trends_timetomarket(
  reg_days      int DEFAULT 2,     -- 등록·승인 소요 상수 (일)
  default_lead  int DEFAULT 7,     -- supplier lead_time_days 미수집 시 가정 리드타임
  floor_score   numeric DEFAULT 20, -- '수요 꺼짐' 임계 (이하면 사실상 사장)
  lookback_days int DEFAULT 120,   -- 시계열 조회 윈도우
  min_points    int DEFAULT 2      -- 반감기 추정 최소 관측 점 수
)
RETURNS TABLE (
  product_id uuid,
  canonical_name text,
  category_top text,
  current_score numeric,
  peak_score numeric,
  peak_at timestamptz,
  days_since_peak numeric,
  half_life_days numeric,
  residual_life_days numeric,
  best_lead_time int,
  lead_is_assumed boolean,
  total_time_days int,
  arrival_residual_ratio numeric,
  verdict text,
  points int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH series AS (
    SELECT
      s.product_id,
      s.final_score::numeric AS score,
      s.computed_at,
      COUNT(*)  OVER (PARTITION BY s.product_id) AS pts
    FROM jimscanner_trends_scores s
    WHERE s.computed_at > now() - (lookback_days || ' days')::interval
  ),
  agg AS (
    SELECT
      product_id,
      MAX(pts)::int AS points,
      MAX(score) AS peak_score,
      (ARRAY_AGG(computed_at ORDER BY score DESC, computed_at ASC))[1] AS peak_at,
      (ARRAY_AGG(score       ORDER BY computed_at DESC))[1] AS current_score,
      (ARRAY_AGG(computed_at ORDER BY computed_at DESC))[1] AS current_at
    FROM series
    GROUP BY product_id
  ),
  calc AS (
    SELECT
      a.*,
      GREATEST(EXTRACT(EPOCH FROM (a.current_at - a.peak_at)) / 86400.0, 0)::numeric AS days_since_peak
    FROM agg a
    WHERE a.points >= min_points
  ),
  -- 최단 도매 리드타임 (수집된 supplier 중 lead_time_days 보유 행)
  lead AS (
    SELECT product_id, MIN(lead_time_days)::int AS best_lead_time
    FROM jimscanner_trends_supplier
    WHERE lead_time_days IS NOT NULL
    GROUP BY product_id
  )
  SELECT
    c.product_id,
    p.canonical_name,
    p.category_top,
    round(c.current_score, 1) AS current_score,
    round(c.peak_score, 1)    AS peak_score,
    c.peak_at,
    round(c.days_since_peak, 1) AS days_since_peak,
    -- 반감기: 감쇠 중일 때만 정의
    CASE WHEN d.decay_rate IS NOT NULL
         THEN round((ln(2) / d.decay_rate)::numeric, 1) END AS half_life_days,
    -- 잔존수명: 현재 → floor_score 까지 남은 일수 (상승/평탄은 NULL = open-ended)
    CASE
      WHEN c.current_score <= floor_score THEN 0
      WHEN d.decay_rate IS NOT NULL
        THEN round((ln(c.current_score / floor_score) / d.decay_rate)::numeric, 1)
      ELSE NULL
    END AS residual_life_days,
    l.best_lead_time,
    (l.best_lead_time IS NULL) AS lead_is_assumed,
    (COALESCE(l.best_lead_time, default_lead) + reg_days)::int AS total_time_days,
    -- 도착 시점 잔존 수요 비율 = exp(-decay · total)  (상승/평탄 → 1.0)
    CASE
      WHEN d.decay_rate IS NULL THEN 1.0
      ELSE round(LEAST(1.0, GREATEST(0.0,
        exp(-d.decay_rate * (COALESCE(l.best_lead_time, default_lead) + reg_days))
      ))::numeric, 3)
    END AS arrival_residual_ratio,
    -- 게이트 판정
    CASE
      WHEN c.current_score <= floor_score THEN 'late'
      WHEN d.decay_rate IS NOT NULL
           AND (COALESCE(l.best_lead_time, default_lead) + reg_days)
               > (ln(c.current_score / floor_score) / d.decay_rate)
        THEN 'late'
      WHEN d.decay_rate IS NULL THEN
        CASE WHEN l.best_lead_time IS NULL THEN 'unknown' ELSE 'ample' END
      WHEN exp(-d.decay_rate * (COALESCE(l.best_lead_time, default_lead) + reg_days)) >= 0.7
        THEN CASE WHEN l.best_lead_time IS NULL THEN 'unknown' ELSE 'ample' END
      WHEN exp(-d.decay_rate * (COALESCE(l.best_lead_time, default_lead) + reg_days)) >= 0.4
        THEN CASE WHEN l.best_lead_time IS NULL THEN 'unknown' ELSE 'safe' END
      ELSE 'late'
    END AS verdict,
    c.points
  FROM calc c
  JOIN jimscanner_trends_products p ON p.id = c.product_id
  LEFT JOIN lead l ON l.product_id = c.product_id
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN c.current_score < c.peak_score
       AND c.days_since_peak > 0.5
       AND c.current_score > 0
      THEN ln(c.peak_score / c.current_score) / c.days_since_peak
      ELSE NULL
    END AS decay_rate
  ) d
  ORDER BY
    -- 늦음(차단) → 안전 → 여유 → 미상 순, 동급은 current_score 높은 것 먼저
    CASE
      WHEN c.current_score <= floor_score THEN 0
      WHEN d.decay_rate IS NOT NULL
           AND (COALESCE(l.best_lead_time, default_lead) + reg_days)
               > (ln(c.current_score / floor_score) / d.decay_rate) THEN 0
      ELSE 1
    END ASC,
    c.current_score DESC;
$$;

-- 어드민 service-role 만 호출
REVOKE ALL ON FUNCTION jimscanner_trends_timetomarket(int, int, numeric, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_trends_timetomarket(int, int, numeric, int, int) TO service_role;
