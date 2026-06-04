-- ────────────────────────────────────────────────────────────
-- 자기 포트폴리오 잠식(카니발라이제이션) 게이트 RPC (V0, 2026-06-04)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/recommend, /admin/trend-radar/opportunity
-- 목적: 신규 발굴 후보(ggsan title / trends canonical_name)를
--       이미 등록·판매중인 자사 쿠팡 SKU(jimscanner_coupang_listings,
--       status APPROVED/SELLING)와 pg_trgm similarity 로 교차대조해
--       '자기잠식' 위험(중복도 %)·충돌 SKU·판매수·마진을 반환한다.
--
-- 입력:  candidate_titles  - 후보 상품명 배열 (recommend RPC 출력 title 등)
--        min_sim           - 잠식으로 간주할 최소 trgm 유사도 (기본 0.30)
-- 출력:  후보별 충돌 SKU 행 (1 후보 : N 충돌). 충돌 없는 후보는 행이 없음.
--
-- 근거: 60개 발굴 보드는 그린필드(자사 재고 0) 가정이라, 이미 파는 상품과
--       같은 수요를 두고 새 SKU 를 등록해 트래픽·광고비·노출을 분산시키는
--       손실을 점검하지 않는다. listings 에 판매수·마진이 쌓여 즉시 구현 가능.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_cannibalization_check(
  candidate_titles text[],
  min_sim float DEFAULT 0.30
)
RETURNS TABLE (
  candidate_title text,
  conflict_seller_product_id text,
  conflict_source_goods_no text,
  conflict_title text,
  similarity_pct int,
  conflict_status text,
  conflict_list_price_krw int,
  conflict_margin_pct numeric,
  conflict_sales_count int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH cand AS (
    SELECT DISTINCT t AS candidate_title
    FROM unnest(candidate_titles) AS t
    WHERE t IS NOT NULL AND length(btrim(t)) > 0
  ),
  -- 판매중·승인된 자사 SKU 만 잠식 대상
  live AS (
    SELECT
      l.seller_product_id,
      l.source_goods_no,
      l.registered_title,
      l.status,
      l.list_price_krw,
      l.estimated_margin_pct
    FROM jimscanner_coupang_listings l
    WHERE l.status IN ('APPROVED', 'SELLING')
      AND l.registered_title IS NOT NULL
      AND length(btrim(l.registered_title)) > 0
  ),
  -- SKU 별 누적 주문건수 (판매수 근사)
  sales AS (
    SELECT seller_product_id, COUNT(*)::int AS sales_count
    FROM jimscanner_coupang_orders
    WHERE seller_product_id IS NOT NULL
    GROUP BY seller_product_id
  )
  SELECT
    c.candidate_title,
    lv.seller_product_id::text,
    lv.source_goods_no,
    lv.registered_title,
    (similarity(c.candidate_title, lv.registered_title) * 100)::int AS similarity_pct,
    lv.status,
    lv.list_price_krw,
    lv.estimated_margin_pct,
    COALESCE(s.sales_count, 0) AS conflict_sales_count
  FROM cand c
  JOIN live lv
    ON similarity(c.candidate_title, lv.registered_title) >= min_sim
  LEFT JOIN sales s ON s.seller_product_id = lv.seller_product_id
  ORDER BY c.candidate_title, similarity(c.candidate_title, lv.registered_title) DESC;
$$;

-- 어드민 service-role 만 호출
REVOKE ALL ON FUNCTION jimscanner_cannibalization_check(text[], float) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_cannibalization_check(text[], float) TO service_role;
