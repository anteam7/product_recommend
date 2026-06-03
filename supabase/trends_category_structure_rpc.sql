-- ─────────────────────────────────────────────────────────────
-- 수요 집중도(HHI) 시장구조 RPC — 파편화 카테고리 진입기회 발굴
-- (2026-06-03)
-- ─────────────────────────────────────────────────────────────
-- category_mid 단위로 산업조직론의 HHI(허핀달-허시먼 지수) / CR3(상위3 집중도)를
-- demand-share 에 적용해 '승자독식 vs 파편화' 시장구조를 진단한다.
--
-- 수요지표: 각 상품의 최신 trend_score 를 점유율로 환산.
--   share_i = trend_score_i / Σ trend_score   (카테고리 내)
--   HHI     = Σ (share_i)^2        ... 0(완전 파편화) ~ 1(완전 독점), ×10000 정규화
--   CR3     = 상위 3개 share 합     ... 0 ~ 1
--   모멘텀  = 카테고리 내 상품별 (최신 trend_score − 직전 trend_score) 평균 (Δ)
--
-- service-role 만 호출 (기존 jimscanner_trends_* 패턴과 동일, 정책 없음).
-- generated 타입 미반영 — 호출부는 `as never` / `as any` 캐스팅.
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_trends_category_structure(
  min_products int DEFAULT 2
)
RETURNS TABLE (
  category_mid   text,
  category_top   text,
  product_count  int,
  demand_total   numeric,   -- 카테고리 수요 총량 (Σ trend_score)
  hhi            numeric,   -- 0~10000 (낮을수록 파편화)
  cr3            numeric,   -- 0~100 (%, 상위3 집중도)
  trend_momentum numeric    -- 평균 trend Δ (최신 − 직전)
)
LANGUAGE sql
STABLE
AS $$
  WITH latest AS (
    -- 상품별 최신 score
    SELECT DISTINCT ON (s.product_id)
      s.product_id, s.trend_score, s.computed_at
    FROM jimscanner_trends_scores s
    ORDER BY s.product_id, s.computed_at DESC
  ),
  prev AS (
    -- 상품별 직전(2번째 최신) score
    SELECT DISTINCT ON (s.product_id)
      s.product_id, s.trend_score
    FROM jimscanner_trends_scores s
    JOIN latest l
      ON l.product_id = s.product_id AND s.computed_at < l.computed_at
    ORDER BY s.product_id, s.computed_at DESC
  ),
  prod AS (
    SELECT
      p.id,
      p.category_mid,
      p.category_top,
      l.trend_score AS score,
      (l.trend_score - COALESCE(pv.trend_score, l.trend_score)) AS delta
    FROM jimscanner_trends_products p
    JOIN latest l ON l.product_id = p.id
    LEFT JOIN prev pv ON pv.product_id = p.id
    WHERE p.category_mid IS NOT NULL
      AND p.category_mid <> ''
      AND l.trend_score > 0
  ),
  cat AS (
    SELECT
      category_mid,
      -- 카테고리 대표 top (최빈) 은 단순히 max 로 (대부분 동일)
      MAX(category_top) AS category_top,
      COUNT(*)::int     AS product_count,
      SUM(score)        AS demand_total,
      AVG(delta)        AS trend_momentum
    FROM prod
    GROUP BY category_mid
  ),
  shares AS (
    SELECT
      pr.category_mid,
      pr.score / NULLIF(c.demand_total, 0) AS share,
      ROW_NUMBER() OVER (
        PARTITION BY pr.category_mid ORDER BY pr.score DESC
      ) AS rnk
    FROM prod pr
    JOIN cat c ON c.category_mid = pr.category_mid
  ),
  hhi AS (
    SELECT
      category_mid,
      SUM(share * share)                                    AS hhi_frac,
      SUM(share) FILTER (WHERE rnk <= 3)                    AS cr3_frac
    FROM shares
    GROUP BY category_mid
  )
  SELECT
    c.category_mid,
    c.category_top,
    c.product_count,
    ROUND(c.demand_total, 1)            AS demand_total,
    ROUND(h.hhi_frac * 10000, 0)        AS hhi,
    ROUND(h.cr3_frac * 100, 1)          AS cr3,
    ROUND(c.trend_momentum, 1)          AS trend_momentum
  FROM cat c
  JOIN hhi h ON h.category_mid = c.category_mid
  WHERE c.product_count >= min_products
  ORDER BY c.demand_total DESC;
$$;
