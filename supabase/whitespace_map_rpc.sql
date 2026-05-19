-- ────────────────────────────────────────────────────────────
-- Whitespace Category Map RPC (PR-WHITESPACE-1, 2026-05-20)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/whitespace
-- 목적: ggsan cate_cd × canonical category_top 2D 매트릭스 셀당
--       (공급 SKU 수, 수요 평균 점수, 우리 핀 수, 마진 중앙값) 산출.
-- 공급↑ × 수요↑ × 우리 핀=0 셀이 진입 화이트스페이스.
-- opportunity_score = supply_norm × demand_norm × (1 - coverage)
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_whitespace_map(
  min_sim float DEFAULT 0.20
)
RETURNS TABLE (
  cate_cd text,
  cate_label text,
  category_top text,
  supply_count int,
  demand_score numeric,
  pin_count int,
  median_price int,
  opportunity_score numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  -- 1) 각 ggsan 상품에 대해 best-match canonical 의 category_top 추정.
  --    매칭 안되면 'unmatched' 로 분류해서 셀 자체는 보존.
  ggsan_canon AS (
    SELECT
      gp.goods_no,
      gp.cate_cd,
      gp.cate_label,
      gp.price_krw,
      gp.title,
      COALESCE(
        (
          SELECT p.category_top
          FROM jimscanner_trends_aliases a
          JOIN jimscanner_trends_products p ON p.id = a.product_id
          WHERE gp.title % a.alias
            AND similarity(gp.title, a.alias) >= min_sim
          ORDER BY similarity(gp.title, a.alias) DESC
          LIMIT 1
        ),
        'unmatched'
      ) AS category_top
    FROM jimscanner_ggsan_products gp
    WHERE COALESCE(gp.status, 'active') <> 'removed'
      AND gp.cate_cd IS NOT NULL
  ),
  -- 2) canonical 별 최신 점수
  latest_scores AS (
    SELECT DISTINCT ON (product_id)
      product_id, final_score
    FROM jimscanner_trends_scores
    ORDER BY product_id, computed_at DESC
  ),
  -- 3) category_top 별 수요 평균
  demand_per_cat AS (
    SELECT
      p.category_top,
      AVG(ls.final_score)::numeric AS demand_score
    FROM jimscanner_trends_products p
    JOIN latest_scores ls ON ls.product_id = p.id
    GROUP BY p.category_top
  ),
  -- 4) 핀 키워드 → ggsan 상품 trigram 매칭 → 셀에 귀속
  pin_matches AS (
    SELECT DISTINCT
      pn.keyword,
      gc.cate_cd,
      gc.category_top
    FROM jimscanner_trends_pins pn
    JOIN ggsan_canon gc
      ON gc.title % pn.keyword
     AND similarity(pn.keyword, gc.title) >= min_sim
  ),
  pin_counts AS (
    SELECT cate_cd, category_top, COUNT(*)::int AS pin_count
    FROM pin_matches
    GROUP BY cate_cd, category_top
  ),
  -- 5) 셀 별 공급량 + 가격 중앙값
  cells AS (
    SELECT
      gc.cate_cd,
      MAX(gc.cate_label) AS cate_label,
      gc.category_top,
      COUNT(*)::int AS supply_count,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY gc.price_krw)::int AS median_price
    FROM ggsan_canon gc
    GROUP BY gc.cate_cd, gc.category_top
  )
  SELECT
    c.cate_cd,
    c.cate_label,
    c.category_top,
    c.supply_count,
    COALESCE(d.demand_score, 0)::numeric AS demand_score,
    COALESCE(pc.pin_count, 0)::int AS pin_count,
    c.median_price,
    (
      LEAST(c.supply_count::numeric / 50.0, 1.0)
      * (COALESCE(d.demand_score, 0)::numeric / 100.0)
      * (1.0 - LEAST(
          COALESCE(pc.pin_count, 0)::numeric / GREATEST(c.supply_count::numeric, 1.0),
          1.0
        ))
    )::numeric AS opportunity_score
  FROM cells c
  LEFT JOIN demand_per_cat d ON d.category_top = c.category_top
  LEFT JOIN pin_counts pc
    ON pc.cate_cd = c.cate_cd
   AND pc.category_top = c.category_top
  ORDER BY opportunity_score DESC, c.supply_count DESC;
$$;

REVOKE ALL ON FUNCTION jimscanner_whitespace_map(float) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_whitespace_map(float) TO service_role;


-- ────────────────────────────────────────────────────────────
-- 드릴다운 RPC: 특정 (cate_cd, category_top) 셀 안의 미진입 SKU 후보
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_whitespace_cell_skus(
  in_cate_cd text,
  in_category_top text,
  min_sim float DEFAULT 0.20,
  result_limit int DEFAULT 30
)
RETURNS TABLE (
  goods_no text,
  title text,
  cate_label text,
  price_krw int,
  is_imminent boolean,
  image_url text,
  detail_url text,
  matched_category_top text,
  pinned boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH gc AS (
    SELECT
      gp.goods_no,
      gp.title,
      gp.cate_label,
      gp.cate_cd,
      gp.price_krw,
      gp.is_imminent,
      gp.image_url,
      gp.detail_url,
      COALESCE(
        (
          SELECT p.category_top
          FROM jimscanner_trends_aliases a
          JOIN jimscanner_trends_products p ON p.id = a.product_id
          WHERE gp.title % a.alias
            AND similarity(gp.title, a.alias) >= min_sim
          ORDER BY similarity(gp.title, a.alias) DESC
          LIMIT 1
        ),
        'unmatched'
      ) AS matched_category_top
    FROM jimscanner_ggsan_products gp
    WHERE COALESCE(gp.status, 'active') <> 'removed'
      AND gp.cate_cd = in_cate_cd
  ),
  pin_hits AS (
    SELECT DISTINCT gc.goods_no
    FROM gc
    JOIN jimscanner_trends_pins pn
      ON gc.title % pn.keyword
     AND similarity(pn.keyword, gc.title) >= min_sim
  )
  SELECT
    gc.goods_no,
    gc.title,
    gc.cate_label,
    gc.price_krw,
    gc.is_imminent,
    gc.image_url,
    gc.detail_url,
    gc.matched_category_top,
    (ph.goods_no IS NOT NULL) AS pinned
  FROM gc
  LEFT JOIN pin_hits ph ON ph.goods_no = gc.goods_no
  WHERE gc.matched_category_top = in_category_top
  ORDER BY (ph.goods_no IS NULL) DESC, gc.is_imminent DESC, gc.price_krw NULLS LAST
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_whitespace_cell_skus(text, text, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_whitespace_cell_skus(text, text, float, int) TO service_role;
