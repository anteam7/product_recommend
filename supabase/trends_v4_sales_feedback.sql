-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 실판매 ROI 피드백 (origin_signal 코호트)
-- ─────────────────────────────────────────────────────────────
-- 목적: 발행 SKU(jimscanner_coupang_listings)를 ①발굴 당시 트리거 시그널과
--   ②trends 점수대로 태깅하고, coupang-orders 실데이터(판매수량·실수익·매입원가)와
--   조인해 "어떤 발굴 채널이 실제 흑자로 전환되는가"를 코호트로 측정한다.
--
-- 정책: 기존 jimscanner_* 패턴 그대로 RLS enable + 정책 X = service-role 만 접근.
-- 관련 UI: src/app/admin/(dashboard)/trend-radar/sales-feedback/page.tsx
-- 관련 문서: platform_direction.md 섹션 4, docs/architecture.md
-- ─────────────────────────────────────────────────────────────


-- 1) 발행 SKU 에 발굴 출처(시그널)·점수대 태깅 컬럼 추가
--    origin_signal: 발굴을 견인한 트리거 채널 (역추적 가능한 단일 라벨)
--      'tv' | 'search_surge' | 'hotdeal' | 'wholesale_new' | 'stl_season'
--      | 'naver_hot' | 'manual' | NULL(미태깅)
--    origin_meta: classify/score 메타 역추적용 (어떤 소스가 견인했는지, 점수 스냅샷)
--      예: { "trend_score": 78, "final_score": 71, "score_band": "high",
--            "trends_product_id": "uuid", "drivers": ["tv","naver_hot"] }
ALTER TABLE jimscanner_coupang_listings
  ADD COLUMN IF NOT EXISTS origin_signal text,
  ADD COLUMN IF NOT EXISTS origin_meta jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS jimscanner_coupang_listings_origin_signal
  ON jimscanner_coupang_listings(origin_signal);

COMMENT ON COLUMN jimscanner_coupang_listings.origin_signal IS
  '발굴 당시 트리거 시그널 (tv/search_surge/hotdeal/wholesale_new/stl_season/naver_hot/manual). 발행 시점에 기록.';
COMMENT ON COLUMN jimscanner_coupang_listings.origin_meta IS
  'classify/score 메타 역추적: trends_product_id, score_band, drivers 등.';


-- 2) SKU ↔ order 실적 집계 RPC
--    seller_product_id 별로 주문 실데이터를 집계해 실수익 P&L 을 반환.
--    실수익 = 매출(order_price) − 매입원가(purchase_total_cost)
--             − 판매수수료(10.6%) − 부가세(÷11). 취소(CANCELLED) 제외.
--    p_since_days = 0 이면 전체 기간.
CREATE OR REPLACE FUNCTION jimscanner_coupang_sku_pnl(p_since_days int DEFAULT 0)
RETURNS TABLE (
  seller_product_id bigint,
  order_count       bigint,
  units             bigint,
  revenue           numeric,
  cost              numeric,
  fee               numeric,
  vat               numeric,
  net               numeric,
  cost_missing      bigint,
  first_order_at    timestamptz,
  last_order_at     timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    o.seller_product_id,
    count(*)                                                  AS order_count,
    coalesce(sum(o.shipping_count), 0)                        AS units,
    coalesce(sum(o.order_price), 0)                           AS revenue,
    coalesce(sum(o.purchase_total_cost), 0)                   AS cost,
    coalesce(sum(round(o.order_price * 0.106)), 0)            AS fee,
    coalesce(sum(round(o.order_price / 11.0)), 0)             AS vat,
    coalesce(sum(
      coalesce(o.order_price, 0)
      - coalesce(o.purchase_total_cost, 0)
      - round(coalesce(o.order_price, 0) * 0.106)
      - round(coalesce(o.order_price, 0) / 11.0)
    ), 0)                                                     AS net,
    count(*) FILTER (WHERE o.purchase_total_cost IS NULL)     AS cost_missing,
    min(o.ordered_at)                                         AS first_order_at,
    max(o.ordered_at)                                         AS last_order_at
  FROM jimscanner_coupang_orders o
  WHERE o.purchase_status <> 'CANCELLED'
    AND o.seller_product_id IS NOT NULL
    AND (p_since_days <= 0 OR o.ordered_at >= now() - (p_since_days || ' days')::interval)
  GROUP BY o.seller_product_id;
$$;

COMMENT ON FUNCTION jimscanner_coupang_sku_pnl(int) IS
  'seller_product_id 별 실수익 P&L 집계 (매출/매입/수수료/부가세/실수익/판매수량). sales-feedback 코호트의 데이터 소스.';
