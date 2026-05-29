-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 수집원 알파 백테스트 (2026-05-30)
-- ─────────────────────────────────────────────────────────────
-- 각 수집 소스를 '예측 도구'로 평가한다.
--   ① precision(적중률)  : 그 소스가 잡은 상품 중 위너 비율
--   ② recall(커버리지)   : 전체 위너 중 그 소스가 잡은 비율
--   ③ median lead days   : 임계 돌파일 대비 그 소스의 최초 포착일 선행 일수(중앙값)
--
-- '위너' = jimscanner_trends_scores.final_score 가 임계(기본 70)를 한 번이라도 넘긴 상품.
-- '돌파일' = 그 상품이 처음 임계를 넘긴 computed_at.
-- '소스 최초 포착일' = jimscanner_trends_aliases.created_at 의 (source, product) 최소값.
--   lead_days = 돌파일 - 소스 최초 포착일 (양수 = 임계 돌파 전에 미리 잡음).
--
-- 노출 정책: 기존 trends_v4 패턴과 동일. service-role 만 접근(RLS), RPC 는 어드민에서 read-only 호출.
-- 관련 UI: src/app/admin/(dashboard)/trend-radar/sources/page.tsx
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_trends_source_backtest(score_threshold numeric DEFAULT 70)
RETURNS TABLE (
  source text,
  products_captured int,
  winners_captured int,
  precision numeric,
  recall numeric,
  median_lead_days numeric,
  early_winners int,        -- 임계 돌파 전에(lead_days > 0) 잡은 위너 수
  lead_days_samples int[]   -- 위너별 선행일수 표본 (분포 차트용)
)
LANGUAGE sql
STABLE
AS $$
  WITH winners AS (
    -- 임계를 한 번이라도 넘긴 상품 + 최초 돌파 시각
    SELECT s.product_id,
           MIN(s.computed_at) FILTER (WHERE s.final_score >= score_threshold) AS crossed_at
    FROM jimscanner_trends_scores s
    GROUP BY s.product_id
    HAVING bool_or(s.final_score >= score_threshold)
  ),
  tot AS (
    SELECT count(*)::numeric AS total_winners FROM winners
  ),
  src_cap AS (
    -- (소스, 상품) 별 최초 포착 시각
    SELECT a.source, a.product_id, MIN(a.created_at) AS captured_at
    FROM jimscanner_trends_aliases a
    WHERE a.source IS NOT NULL
    GROUP BY a.source, a.product_id
  ),
  joined AS (
    SELECT sc.source,
           sc.product_id,
           (w.product_id IS NOT NULL) AS is_winner,
           CASE WHEN w.product_id IS NOT NULL
                THEN EXTRACT(EPOCH FROM (w.crossed_at - sc.captured_at)) / 86400.0
           END AS lead_days
    FROM src_cap sc
    LEFT JOIN winners w ON w.product_id = sc.product_id
  )
  SELECT
    j.source,
    COUNT(*)::int                                                        AS products_captured,
    COUNT(*) FILTER (WHERE j.is_winner)::int                             AS winners_captured,
    ROUND(COUNT(*) FILTER (WHERE j.is_winner)::numeric
          / NULLIF(COUNT(*), 0), 4)                                      AS precision,
    ROUND(COUNT(*) FILTER (WHERE j.is_winner)::numeric
          / NULLIF((SELECT total_winners FROM tot), 0), 4)               AS recall,
    ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY j.lead_days)
          FILTER (WHERE j.is_winner)::numeric, 2)                        AS median_lead_days,
    COUNT(*) FILTER (WHERE j.is_winner AND j.lead_days > 0)::int         AS early_winners,
    COALESCE(
      array_agg(ROUND(j.lead_days)::int)
        FILTER (WHERE j.is_winner AND j.lead_days IS NOT NULL),
      '{}'::int[]
    )                                                                    AS lead_days_samples
  FROM joined j
  GROUP BY j.source
  ORDER BY precision DESC NULLS LAST, winners_captured DESC;
$$;

-- service_role 는 RLS/권한을 우회하지만, 일관성을 위해 명시적 grant.
GRANT EXECUTE ON FUNCTION jimscanner_trends_source_backtest(numeric) TO service_role;
