-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 발굴→등록 전환 깔때기 + 단계별 적체(aging) 뷰
-- (2026-06-01)
-- ─────────────────────────────────────────────────────────────
-- 운영자 워크플로(발굴→핀→소싱→등록→판매)의 단계 진입 시각을 product 단위로 좌조인.
--   ① 발굴   : jimscanner_trends_products.first_seen_at
--   ② 핀     : pinned 키워드(jimscanner_trends_keywords.pinned) → aliases → product
--   ③ 소싱   : jimscanner_trends_supplier (도매 매칭) 최초 수집 시각
--   ④ 등록   : jimscanner_coupang_listings.created_at
--              (supplier_source+supplier_product_id ↔ listings.source+source_goods_no 로 연결)
--   ⑤ 판매중 : listings.status = 'SELLING'
--
-- 한 product 가 아직 도달하지 못한 단계는 NULL → UI 에서 적체(stale) 측정에 사용.
-- read-only 뷰. RLS 는 base table 정책(service-role 전용) 상속.
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW jimscanner_trends_v4_funnel AS
WITH pinned_kw AS (
  -- pinned 키워드를 alias 로 product 에 연결 (대소문자 무시 매칭)
  SELECT a.product_id, MIN(k.collected_at) AS pinned_at
  FROM jimscanner_trends_aliases a
  JOIN jimscanner_trends_keywords k
    ON lower(k.keyword) = lower(a.alias)
   AND k.pinned = true
  GROUP BY a.product_id
),
sourced AS (
  -- product 별 최초 도매 매칭 + 대표 supplier 식별자(등록 단계 연결용)
  SELECT
    product_id,
    MIN(collected_at) AS sourced_at,
    (ARRAY_AGG(supplier_source     ORDER BY collected_at))[1] AS supplier_source,
    (ARRAY_AGG(supplier_product_id ORDER BY collected_at))[1] AS supplier_product_id
  FROM jimscanner_trends_supplier
  GROUP BY product_id
),
registered AS (
  -- 소싱된 supplier 식별자 ↔ 쿠팡 listings 연결 → 등록 시각 / 판매 상태
  SELECT
    s.product_id,
    MIN(l.created_at) AS registered_at,
    BOOL_OR(l.status = 'SELLING') AS is_selling,
    (ARRAY_AGG(l.status ORDER BY l.created_at DESC))[1] AS latest_status
  FROM sourced s
  JOIN jimscanner_coupang_listings l
    ON l.source = s.supplier_source
   AND l.source_goods_no = s.supplier_product_id
  GROUP BY s.product_id
)
SELECT
  p.id                         AS product_id,
  p.canonical_name,
  p.category_top,
  p.first_seen_at              AS discovered_at,
  pk.pinned_at,
  sc.sourced_at,
  sc.supplier_source,
  sc.supplier_product_id,
  rg.registered_at,
  COALESCE(rg.is_selling, false) AS is_selling,
  rg.latest_status
FROM jimscanner_trends_products p
LEFT JOIN pinned_kw   pk ON pk.product_id = p.id
LEFT JOIN sourced     sc ON sc.product_id = p.id
LEFT JOIN registered  rg ON rg.product_id = p.id;

-- UI 는 `SELECT * FROM jimscanner_trends_v4_funnel` 후 단계 카운트/적체/코호트를 앱에서 계산.
COMMENT ON VIEW jimscanner_trends_v4_funnel IS
  '발굴→핀→소싱→등록→판매 단계 진입 시각 (product 단위, 미도달 단계는 NULL). trend-radar/funnel 보드용.';
