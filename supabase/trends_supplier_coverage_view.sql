-- ─────────────────────────────────────────────────────────────
-- 도매 공급원 커버리지 & 듀얼소싱 차익 뷰
-- ─────────────────────────────────────────────────────────────
-- jimscanner_trends_supplier(product_id별 N row)를 집계해
--   (a) 공급원 개수, (b) 단일출처/ggsan-only 플래그,
--   (c) 도매처 간 price_krw min/median/max + 스프레드율(차익)
-- 을 product_id 1 row 로 산출.
--
-- UI: /admin/trend-radar/supply-coverage (server component, read-only)
-- 적용: psql + service-role (DDL). generated 타입 미반영 → 코드에서 `as never` 캐스팅.
-- 관련: supabase/trends_v4_seller_tools.sql (원본 supplier 테이블)
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW jimscanner_trends_supplier_coverage AS
WITH latest_supplier AS (
  -- 같은 도매처(supplier_source)의 가장 최근 수집 row 만 사용 (시계열 중복 제거)
  SELECT DISTINCT ON (s.product_id, s.supplier_source)
    s.product_id,
    s.supplier_source,
    s.price_krw,
    s.title,
    s.supplier_url,
    s.inventory_status,
    s.collected_at
  FROM jimscanner_trends_supplier s
  ORDER BY s.product_id, s.supplier_source, s.collected_at DESC
),
agg AS (
  SELECT
    product_id,
    COUNT(*)                                                  AS supplier_count,
    COUNT(*) FILTER (WHERE supplier_source = 'ggsan')         AS ggsan_count,
    bool_or(supplier_source <> 'ggsan')                       AS has_non_ggsan,
    MIN(price_krw) FILTER (WHERE price_krw IS NOT NULL AND price_krw > 0) AS price_min,
    MAX(price_krw) FILTER (WHERE price_krw IS NOT NULL AND price_krw > 0) AS price_max,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY price_krw)
      FILTER (WHERE price_krw IS NOT NULL AND price_krw > 0)  AS price_median,
    array_agg(DISTINCT supplier_source ORDER BY supplier_source) AS sources
  FROM latest_supplier
  GROUP BY product_id
)
SELECT
  a.product_id,
  a.supplier_count,
  (a.supplier_count <= 1)                              AS is_single_source,
  (a.ggsan_count > 0 AND NOT a.has_non_ggsan)          AS ggsan_only,
  a.price_min,
  a.price_median,
  a.price_max,
  -- 더 싼 도매처로 전환 시 절감되는 매입가 (차익 ₩)
  CASE
    WHEN a.price_min IS NOT NULL AND a.price_max IS NOT NULL
    THEN (a.price_max - a.price_min)
    ELSE NULL
  END                                                  AS spread_krw,
  -- 스프레드율 = (max - min) / min  (0.25 = 최고가 대비 25% 더 비쌈)
  CASE
    WHEN a.price_min IS NOT NULL AND a.price_min > 0 AND a.price_max IS NOT NULL
    THEN round(((a.price_max - a.price_min) / a.price_min)::numeric, 4)
    ELSE NULL
  END                                                  AS spread_pct,
  a.sources
FROM agg a;

COMMENT ON VIEW jimscanner_trends_supplier_coverage IS
  '후보별 도매 공급원 커버리지·단일출처 리스크·도매처 간 가격 스프레드(차익) 집계. supply-coverage 보드용.';
