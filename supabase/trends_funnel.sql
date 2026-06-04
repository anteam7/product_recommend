-- ────────────────────────────────────────────────────────────
-- 발굴→소싱→등록→판매 전환 퍼널 조인 RPC (2026-06-04)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/funnel 페이지
--
-- 배경: 발굴(jimscanner_trends_*)과 운영(jimscanner_coupang_listings/orders)이
--       DB상 외래키로 끊겨 있어 파이프라인 누수 지점이 불가시.
--       canonical_name 을 pg_trgm similarity() 로 ① ggsan 도매 상품명,
--       ② 쿠팡 등록 상품명(registered_title) 에 fuzzy 매칭해 각 발굴 상품이
--       소싱/등록/판매 단계 중 어디까지 진행됐는지 한 행으로 집계한다.
--
-- service_role 로만 호출 (어드민 한정) — SECURITY DEFINER + grant 명시
-- (기존 jimscanner_tv_ggsan_match 패턴과 동일)
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_trends_funnel_join(
  score_floor numeric DEFAULT 50,
  min_sim float DEFAULT 0.25,
  result_limit int DEFAULT 400
)
RETURNS TABLE (
  product_id uuid,
  canonical_name text,
  category_top text,
  final_score numeric,
  supplier_score numeric,
  has_supplier boolean,
  ggsan_goods_no text,
  ggsan_title text,
  ggsan_price_krw int,
  ggsan_sim real,
  listing_id uuid,
  listing_status text,
  listing_sold int,
  listing_margin_pct numeric,
  listing_sim real
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH latest AS (
    -- product 별 가장 최근 score row 만
    SELECT DISTINCT ON (s.product_id)
      s.product_id, s.final_score, s.supplier_score
    FROM jimscanner_trends_scores s
    ORDER BY s.product_id, s.computed_at DESC
  ),
  hot AS (
    SELECT p.id AS product_id, p.canonical_name, p.category_top,
           lt.final_score, lt.supplier_score
    FROM latest lt
    JOIN jimscanner_trends_products p ON p.id = lt.product_id
    WHERE lt.final_score >= score_floor
  )
  SELECT
    h.product_id,
    h.canonical_name,
    h.category_top,
    h.final_score,
    h.supplier_score,
    EXISTS (
      SELECT 1 FROM jimscanner_trends_supplier sup
      WHERE sup.product_id = h.product_id
    ) AS has_supplier,
    g.goods_no       AS ggsan_goods_no,
    g.title          AS ggsan_title,
    g.price_krw      AS ggsan_price_krw,
    g.sim            AS ggsan_sim,
    li.id            AS listing_id,
    li.status        AS listing_status,
    li.sold_count    AS listing_sold,
    li.margin_pct    AS listing_margin_pct,
    li.sim           AS listing_sim
  FROM hot h
  -- ① 발굴 → ggsan 도매 소싱 후보 (best fuzzy 매칭 1건)
  LEFT JOIN LATERAL (
    SELECT gp.goods_no, gp.title, gp.price_krw,
           similarity(h.canonical_name, gp.title)::real AS sim
    FROM jimscanner_ggsan_products gp
    WHERE gp.title % h.canonical_name        -- pg_trgm 인덱스 활용 (% operator)
    ORDER BY similarity(h.canonical_name, gp.title) DESC
    LIMIT 1
  ) g ON g.sim >= min_sim
  -- ② 발굴 → 쿠팡 등록 listing (best fuzzy 매칭 1건)
  LEFT JOIN LATERAL (
    SELECT cl.id, cl.status, cl.sold_count,
           cl.estimated_margin_pct AS margin_pct,
           similarity(h.canonical_name, cl.registered_title)::real AS sim
    FROM jimscanner_coupang_listings cl
    WHERE cl.registered_title % h.canonical_name
    ORDER BY similarity(h.canonical_name, cl.registered_title) DESC
    LIMIT 1
  ) li ON li.sim >= min_sim
  ORDER BY h.final_score DESC
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출 (anon/authenticated 차단)
REVOKE ALL ON FUNCTION jimscanner_trends_funnel_join(numeric, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_trends_funnel_join(numeric, float, int) TO service_role;
