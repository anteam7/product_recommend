-- ────────────────────────────────────────────────────────────
-- 발행 SKU 리프라이싱 코크핏 (PR-REPRICE-1, 2026-05-29)
-- ────────────────────────────────────────────────────────────
-- 목적: 발행된 listings 의 가격 경쟁력을 시계열로 추적 → 바이박스 방어·마진 헤드룸 관리.
-- 기존 coupang-market-prices.mjs 는 ggsan raw_payload.market_price 에 1회성 스냅샷만 저장 → 시계열 부재.
-- 본 스키마로 시세를 누적하고, v_repricing_signals 뷰가 [원가·내 현재가·최신 시세·추세] 를 SKU 단위로 조인한다.
-- 실제 DB 적용은 사람이 psql 로 수행. 코드는 적용 후 상태를 가정 (page 는 `as any` 캐스팅).
-- ────────────────────────────────────────────────────────────

-- 1) 경쟁 시세 시계열 (collector 주기 실행 → 누적)
CREATE TABLE IF NOT EXISTS jimscanner_coupang_market_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goods_no text NOT NULL,                  -- ggsan goodsNo (= listings.source_goods_no)
  observed_at timestamptz NOT NULL DEFAULT now(),
  competitor_min integer,                  -- 자연검색 상위 N 최저가
  competitor_median integer,               -- 중앙값 (시세 추정치)
  competitor_p25 integer,                  -- 하위 25% (공격적 경쟁선)
  sample_count integer DEFAULT 0,          -- 수집 표본 수
  my_list_price integer,                   -- 관측 시점 내 등록가 (스냅샷)
  my_is_winner boolean,                    -- 내 가격 <= 경쟁최저 → 바이박스 우위 추정
  query text,                              -- 사용한 검색어
  raw jsonb                                -- 원본 표본 (디버깅)
);

CREATE INDEX IF NOT EXISTS jimscanner_coupang_mph_goods_at
  ON jimscanner_coupang_market_price_history(goods_no, observed_at DESC);

ALTER TABLE jimscanner_coupang_market_price_history ENABLE ROW LEVEL SECURITY;
-- service-role(어드민) 전용. 별도 정책 없음 → 익명 접근 차단.


-- 2) SKU별 리프라이싱 시그널 뷰
--    listings(내 현재가·status) × ggsan_products(원가 → 마진 플로어) × 최신 시세 history
--    × 14일 주문 여부(dead 판정)
CREATE OR REPLACE VIEW v_repricing_signals AS
WITH latest_price AS (
  -- goods_no 별 최신 시세 1건
  SELECT DISTINCT ON (goods_no)
    goods_no, observed_at, competitor_min, competitor_median, competitor_p25,
    sample_count, my_is_winner
  FROM jimscanner_coupang_market_price_history
  ORDER BY goods_no, observed_at DESC
),
trend7 AS (
  -- 7일 전 대비 median 추세
  SELECT DISTINCT ON (goods_no)
    goods_no, competitor_median AS median_7d_ago
  FROM jimscanner_coupang_market_price_history
  WHERE observed_at <= now() - interval '7 days'
  ORDER BY goods_no, observed_at DESC
),
orders14 AS (
  -- 14일 내 주문 건수 (dead SKU 판정)
  SELECT source_goods_no AS goods_no, count(*) AS orders_14d
  FROM jimscanner_coupang_orders
  WHERE ordered_at >= now() - interval '14 days'
  GROUP BY source_goods_no
)
SELECT
  l.id                          AS listing_id,
  l.source_goods_no             AS goods_no,
  l.registered_title,
  l.brand,
  l.status,
  l.displayable,
  l.seller_product_id,
  l.product_id,
  l.list_price_krw              AS my_price,
  l.msp_price_krw,
  l.dome_price_krw,
  -- 마진 플로어: MSP 우선, 없으면 도매가+배송을 0.65 로 나눈 35% 마진선
  GREATEST(
    COALESCE(l.msp_price_krw, 0),
    CEIL((COALESCE(l.dome_price_krw, 0) + 6000) / 0.65 / 100) * 100
  )::integer                    AS margin_floor,
  lp.competitor_min,
  lp.competitor_median,
  lp.competitor_p25,
  lp.sample_count,
  lp.observed_at                AS price_observed_at,
  t.median_7d_ago,
  CASE
    WHEN t.median_7d_ago IS NULL OR lp.competitor_median IS NULL THEN NULL
    ELSE round(((lp.competitor_median - t.median_7d_ago)::numeric / NULLIF(t.median_7d_ago, 0)) * 100, 1)
  END                           AS median_trend_pct_7d,
  -- 바이박스 상실: 내 가격이 경쟁최저 * 1.0 보다 높음
  CASE
    WHEN lp.competitor_min IS NULL OR l.list_price_krw IS NULL THEN false
    ELSE l.list_price_krw > lp.competitor_min
  END                           AS buybox_lost,
  -- 권장가 = clamp(경쟁최저 - α, [마진플로어, 경쟁최저])
  --   α = 경쟁최저의 1% (최소 100원), 100원 단위 올림
  CASE
    WHEN lp.competitor_min IS NULL THEN NULL
    ELSE GREATEST(
      GREATEST(COALESCE(l.msp_price_krw, 0),
               CEIL((COALESCE(l.dome_price_krw, 0) + 6000) / 0.65 / 100) * 100)::integer,
      CEIL((lp.competitor_min - GREATEST(round(lp.competitor_min * 0.01), 100)) / 100.0) * 100
    )
  END                           AS recommended_price,
  COALESCE(o.orders_14d, 0)     AS orders_14d
FROM jimscanner_coupang_listings l
LEFT JOIN latest_price lp ON lp.goods_no = l.source_goods_no
LEFT JOIN trend7 t        ON t.goods_no  = l.source_goods_no
LEFT JOIN orders14 o      ON o.goods_no  = l.source_goods_no
WHERE l.status IN ('APPROVED', 'SELLING', 'STOPPED', 'PENDING_APPROVAL', 'TEMPORARY_SAVE');

-- NOTE: jimscanner_coupang_orders.ordered_at / source_goods_no 컬럼명이 다르면 orders14 CTE 조정 필요.
