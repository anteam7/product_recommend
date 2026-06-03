-- ────────────────────────────────────────────────────────────
-- JTBD 수요-공급 갭 보드 — intent_label 활성화 (2026-06-03)
-- ────────────────────────────────────────────────────────────
-- 휴면 컬럼 jimscanner_trends_products.intent_label 을 1차 축으로
-- 수요(Σfinal_score)·공급(supplier_score)을 집계하는 RPC.
-- 카테고리(분류)가 아니라 '기능적 수요(JTBD)' 축이라
-- 분류 미완(308건) 상품도 intent_label 만 있으면 집계된다.
--
-- 노출 정책: 다른 jimscanner_trends_* 와 동일하게 service_role 전용.
-- UI: /admin/trend-radar/jtbd (page.tsx 는 RPC 부재 시 JS 집계로 폴백).
-- ────────────────────────────────────────────────────────────

-- intent_label 집계용 인덱스 (NULL 제외)
CREATE INDEX IF NOT EXISTS jimscanner_trends_products_intent
  ON jimscanner_trends_products(intent_label)
  WHERE intent_label IS NOT NULL;

-- 최신 score × intent_label 집계 RPC.
-- product_id 별 최신 score 1건만 사용 (DISTINCT ON computed_at DESC).
CREATE OR REPLACE FUNCTION jimscanner_trends_jtbd_gaps()
RETURNS TABLE (
  intent_label      text,
  product_count     int,
  demand_weight     numeric,   -- Σ final_score
  trend_median      numeric,   -- median trend_score
  supplier_avg      numeric,   -- avg supplier_score (공급 충족도)
  ggsan_match_ratio numeric    -- supplier_score > 0 비율 (0~1)
)
LANGUAGE sql
STABLE
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (s.product_id)
      s.product_id,
      s.trend_score,
      s.supplier_score,
      s.final_score
    FROM jimscanner_trends_scores s
    ORDER BY s.product_id, s.computed_at DESC
  )
  SELECT
    p.intent_label,
    COUNT(*)::int                                                   AS product_count,
    COALESCE(SUM(l.final_score), 0)::numeric                        AS demand_weight,
    COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY l.trend_score), 0)::numeric AS trend_median,
    COALESCE(AVG(l.supplier_score), 0)::numeric                     AS supplier_avg,
    COALESCE(AVG((l.supplier_score > 0)::int), 0)::numeric          AS ggsan_match_ratio
  FROM latest l
  JOIN jimscanner_trends_products p ON p.id = l.product_id
  WHERE p.intent_label IS NOT NULL AND p.intent_label <> ''
  GROUP BY p.intent_label
  ORDER BY demand_weight DESC;
$$;

REVOKE ALL ON FUNCTION jimscanner_trends_jtbd_gaps() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_trends_jtbd_gaps() TO service_role;
