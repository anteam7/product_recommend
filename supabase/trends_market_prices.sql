-- ─────────────────────────────────────────────────────────────
-- 경쟁 가격대 화이트스페이스 — 시장 스캔 리스팅 적재 (2026-05-31)
-- ─────────────────────────────────────────────────────────────
-- coupang-market-prices-cdp.mjs 가 키워드별로 산출하는 경쟁 리스팅을
-- 1회성 콘솔이 아니라 시계열로 누적한다. product 별 개당가 분포를
-- 가격밴드로 binning 해 '수요·매출은 몰리는데 리스팅은 얇은' 화이트스페이스
-- 밴드를 자동 탐지하기 위한 원천 테이블.
--
-- product_id: ggsan goods_no (jimscanner_ggsan_products.goods_no) 또는 trends product id (text 호환)
-- 노출 정책: RLS enable + 정책 정의 X = service-role 만 접근 (기존 trends_* 패턴 동일)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_market_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  product_id text NOT NULL,            -- ggsan goods_no (스캔 대상) — 경쟁 리스팅이 아니라 '우리 후보' 식별자
  keyword text NOT NULL,               -- 시장 스캔에 쓴 검색 쿼리

  unit_price numeric NOT NULL,         -- 개당(박스당) 정규화가 — pack-normalize.normalizePrice
  pack_count int NOT NULL DEFAULT 1,   -- 묶음 수량
  list_price numeric,                  -- 쿠팡 표시가(묶음 합계) 원본
  est_monthly_revenue numeric,         -- 추정 월매출 (없으면 NULL)
  rocket boolean NOT NULL DEFAULT false,

  listing_name text,
  listing_href text,

  scanned_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_market_prices_product_at
  ON jimscanner_trends_market_prices(product_id, scanned_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_market_prices_keyword_at
  ON jimscanner_trends_market_prices(keyword, scanned_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_market_prices_scanned_at
  ON jimscanner_trends_market_prices(scanned_at DESC);

ALTER TABLE jimscanner_trends_market_prices ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.
