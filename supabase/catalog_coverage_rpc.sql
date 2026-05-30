-- ────────────────────────────────────────────────────────────
-- 내 카탈로그 커버리지 · 자기잠식 맵 RPC (2026-05-30)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/coverage 페이지
--
-- 발굴 파이프라인(동의어 클러스터 = 외부 수요 강도) 위에
-- 내가 이미 쿠팡에 올린 카탈로그(jimscanner_coupang_listings.registered_title)와
-- 실판매(jimscanner_coupang_orders)를 오버레이한다.
--
-- 산출 (앱에서 태그로 분류):
--   (A) 커버리지 공백  — 수요 상위 클러스터인데 owned=0 → 확장 1순위
--   (B) 자기잠식 경보  — owned>0 이지만 검증판매(orders)=0 → 신규 후보가 기존 SKU 노출/바이박스 잠식
--   (C) 카탈로그 ROI   — 이미 파는 클러스터 + orders 실판매 → 검증된 카테고리 인접 확장
--
-- 매칭은 trends_v4_tv_ggsan_match_rpc.sql 의 pg_trgm % 퍼지매칭 패턴 재사용:
--   listing.registered_title % cluster.canonical_label (+ member_terms similarity 보강)
-- 실판매는 listing.seller_product_id ↔ orders.seller_product_id 조인.
-- service_role 로만 호출 (어드민 한정) — SECURITY DEFINER + grant 명시.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_catalog_coverage(
  min_sim float DEFAULT 0.20,
  result_limit int DEFAULT 300
)
RETURNS TABLE (
  cluster_id uuid,
  canonical text,
  category_hint text,
  total_frequency int,
  member_count int,
  owned_count int,
  selling_count int,
  owned_titles text[],
  order_qty int,
  order_revenue numeric,
  max_sim real
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  -- 1) 클러스터 ↔ 내 listings 퍼지 매칭
  --    canonical_label 또는 member_terms 중 하나라도 registered_title 과 유사하면 보유로 간주.
  WITH matched AS (
    SELECT DISTINCT ON (c.id, l.seller_product_id)
      c.id AS cluster_id,
      l.seller_product_id,
      l.registered_title,
      l.status,
      GREATEST(
        similarity(l.registered_title, c.canonical_label),
        COALESCE(
          (SELECT MAX(similarity(l.registered_title, t))
             FROM unnest(c.member_terms) AS t),
          0
        )
      ) AS sim
    FROM jimscanner_synonym_clusters c
    JOIN jimscanner_coupang_listings l
      ON l.registered_title % c.canonical_label
    WHERE l.seller_product_id IS NOT NULL
      AND GREATEST(
            similarity(l.registered_title, c.canonical_label),
            COALESCE(
              (SELECT MAX(similarity(l.registered_title, t))
                 FROM unnest(c.member_terms) AS t),
              0
            )
          ) >= min_sim
  ),
  agg AS (
    SELECT
      m.cluster_id,
      COUNT(DISTINCT m.seller_product_id)::int AS owned_count,
      COUNT(DISTINCT m.seller_product_id)
        FILTER (WHERE m.status IN ('SELLING', 'APPROVED'))::int AS selling_count,
      (array_agg(DISTINCT m.registered_title))[1:5] AS owned_titles,
      MAX(m.sim)::real AS max_sim
    FROM matched m
    GROUP BY m.cluster_id
  ),
  -- 2) 매칭된 내 SKU 의 실판매(orders) 집계 → ROI 가중
  ord AS (
    SELECT
      m.cluster_id,
      COALESCE(SUM(o.shipping_count), 0)::int AS order_qty,
      COALESCE(SUM(o.order_price), 0)::numeric AS order_revenue
    FROM (SELECT DISTINCT cluster_id, seller_product_id FROM matched) m
    JOIN jimscanner_coupang_orders o
      ON o.seller_product_id = m.seller_product_id
    GROUP BY m.cluster_id
  )
  SELECT
    c.id,
    c.canonical_label,
    c.category_hint,
    c.total_frequency,
    c.member_count,
    COALESCE(a.owned_count, 0),
    COALESCE(a.selling_count, 0),
    COALESCE(a.owned_titles, '{}'::text[]),
    COALESCE(od.order_qty, 0),
    COALESCE(od.order_revenue, 0),
    COALESCE(a.max_sim, 0)::real
  FROM jimscanner_synonym_clusters c
  LEFT JOIN agg a  ON a.cluster_id = c.id
  LEFT JOIN ord od ON od.cluster_id = c.id
  ORDER BY c.total_frequency DESC
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출 (anon/authenticated 차단)
REVOKE ALL ON FUNCTION jimscanner_catalog_coverage(float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_catalog_coverage(float, int) TO service_role;
