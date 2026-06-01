-- ─────────────────────────────────────────────────────────────
-- 트렌드 생존곡선 — 카테고리별 소싱 깊이 캘리브레이터 (2026-06-01)
-- ─────────────────────────────────────────────────────────────
-- 목적: 신규 발굴 상품을 first_seen_at 주차 코호트로 묶어
--   '카테고리별로 트렌드가 보통 몇 주 살아있나' (median lifespan) 와
--   주차별 생존율(카플란-마이어식)을 산출 → MSP 수량단계·번들 깊이·재고 베팅 base-rate.
--
-- 데이터: jimscanner_trends_products(first_seen_at, category_top)
--        × jimscanner_trends_scores(final_score 시계열)
--
-- '활성(살아있음)' 판정: 해당 주차에 final_score >= min_score 인 score row 가 1개 이상.
-- 센서링: 코호트가 최근이라 t주를 아직 관측 못 한 상품은 해당 offset 의 분모에서 제외
--   (관측 가능한 코호트만으로 생존율 추정 — 우측 절단 보정).
--
-- 노출 정책: 기존 jimscanner_trends_* 와 동일하게 service-role(어드민)만.
-- 적용: psql + PGPASSWORD (docs/database.md). 적용 후 `npm run gen:types` 시 `as never` 캐스팅 제거.
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_trends_survival_curve(
  min_score numeric DEFAULT 50,
  max_weeks int DEFAULT 16
)
RETURNS TABLE (
  category_top  text,
  week_offset   int,
  at_risk       int,   -- 해당 offset 까지 관측 가능한(절단 안 된) 코호트 상품 수
  survived      int,   -- 그중 offset t 시점에 아직 활성인 상품 수
  survival_rate numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH prod AS (
    SELECT
      p.id,
      p.category_top,
      date_trunc('week', p.first_seen_at) AS cohort_week,
      -- 이 코호트가 지금까지 관측 가능한 최대 주차 offset (우측 절단 경계)
      floor(
        extract(epoch FROM (date_trunc('week', now()) - date_trunc('week', p.first_seen_at))) / 604800
      )::int AS max_observable_offset
    FROM jimscanner_trends_products p
  ),
  -- 상품이 '활성'이었던 주차 offset 집합 (final_score >= min_score)
  active_weeks AS (
    SELECT DISTINCT
      s.product_id,
      floor(
        extract(epoch FROM (date_trunc('week', s.computed_at) - p.cohort_week)) / 604800
      )::int AS week_offset
    FROM jimscanner_trends_scores s
    JOIN prod p ON p.id = s.product_id
    WHERE s.final_score >= min_score
  ),
  lifespan AS (
    SELECT
      p.id,
      p.category_top,
      p.max_observable_offset,
      COALESCE(MAX(aw.week_offset), -1) AS last_active_offset  -- -1 = 한 번도 활성 아님
    FROM prod p
    LEFT JOIN active_weeks aw ON aw.product_id = p.id
    GROUP BY p.id, p.category_top, p.max_observable_offset
  ),
  offsets AS (
    SELECT generate_series(0, GREATEST(max_weeks, 0)) AS week_offset
  )
  SELECT
    l.category_top,
    o.week_offset,
    COUNT(*) FILTER (WHERE l.max_observable_offset >= o.week_offset)::int AS at_risk,
    COUNT(*) FILTER (
      WHERE l.max_observable_offset >= o.week_offset
        AND l.last_active_offset >= o.week_offset
    )::int AS survived,
    ROUND(
      COALESCE(
        COUNT(*) FILTER (
          WHERE l.max_observable_offset >= o.week_offset
            AND l.last_active_offset >= o.week_offset
        )::numeric
        / NULLIF(COUNT(*) FILTER (WHERE l.max_observable_offset >= o.week_offset), 0),
        0
      ),
      4
    ) AS survival_rate
  FROM lifespan l
  CROSS JOIN offsets o
  GROUP BY l.category_top, o.week_offset
  HAVING COUNT(*) FILTER (WHERE l.max_observable_offset >= o.week_offset) > 0
  ORDER BY l.category_top, o.week_offset;
$$;

COMMENT ON FUNCTION jimscanner_trends_survival_curve(numeric, int) IS
  '카테고리별 트렌드 생존곡선 (KM식, 우측절단 보정). 어드민 survival 보드 + 잔존수명 배지용.';
