-- ────────────────────────────────────────────────────────────
-- SERP 스냅샷 + 실판매량 역산 (Sell-through Velocity, 2026-06-04)
-- ────────────────────────────────────────────────────────────
-- 목적: 경쟁 쿠팡 리스팅의 리뷰수를 시점별로 스냅샷해
--   리뷰 증가량(Δreview/Δt)을 카테고리 평균 리뷰작성률(역수)로 보정,
--   '실제 일/월 판매수량·예상 월매출(₩)'을 역산한다.
-- 수집: scripts/collect-coupang-serp-snapshot.mjs (Playwright, 로컬 WSL/Windows)
-- 사용처: /admin/trend-radar/sell-through
-- 노출 정책: RLS enable + 정책 없음 = service-role 만 (기존 jimscanner_trends_* 패턴)
-- 관련: supabase/trends_v4_seller_tools.sql, supabase/ggsan_recommend_rpc.sql
-- ────────────────────────────────────────────────────────────

-- 1) SERP 스냅샷 (상위 N개 쿠팡 리스팅의 시점별 리뷰수/가격/순위)
CREATE TABLE IF NOT EXISTS jimscanner_trends_serp_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- canonical 상품으로 매핑(선택). 미매핑이면 NULL — 키워드 기준만으로도 동작.
  product_id uuid REFERENCES jimscanner_trends_products(id) ON DELETE SET NULL,

  keyword text NOT NULL,              -- 캡처 시 사용한 검색 키워드
  category_top text,                  -- 'health' | 'living' | 'digital' | NULL (리뷰작성률 보정 단위)

  coupang_item_id text NOT NULL,      -- 쿠팡 상품 id (productId/itemId)
  product_title text,
  rank int,                           -- SERP 노출 순위 (1=최상단)
  price int,                          -- 표시가(원)
  rating numeric,                     -- 평점 0.0~5.0
  review_count int NOT NULL DEFAULT 0,

  captured_at timestamptz NOT NULL DEFAULT now(),

  -- 동일 item 을 동일 시점에 중복 적재 방지
  UNIQUE (coupang_item_id, captured_at)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_serp_snapshot_item_at
  ON jimscanner_trends_serp_snapshot(coupang_item_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_serp_snapshot_kw_at
  ON jimscanner_trends_serp_snapshot(keyword, captured_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_serp_snapshot_product
  ON jimscanner_trends_serp_snapshot(product_id);

ALTER TABLE jimscanner_trends_serp_snapshot ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.


-- 2) 카테고리별 리뷰작성률 (구매 대비 리뷰가 남는 비율의 역수가 판매 배율)
--    예: 0.03 = 구매자 100명 중 3명이 리뷰 작성 → Δ리뷰 1건당 실판매 ~33개.
--    근거 데이터 누적 전에는 기본값 사용, 추후 운영자가 카테고리별로 보정.
CREATE TABLE IF NOT EXISTS jimscanner_trends_review_rate (
  category_top text PRIMARY KEY,
  review_rate numeric NOT NULL CHECK (review_rate > 0 AND review_rate <= 1),
  note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE jimscanner_trends_review_rate ENABLE ROW LEVEL SECURITY;

INSERT INTO jimscanner_trends_review_rate (category_top, review_rate, note) VALUES
  ('health',  0.030, '건기식·식품 — 리뷰 적립률 추정 3%'),
  ('living',  0.025, '생활·주방 — 추정 2.5%'),
  ('digital', 0.020, '디지털·가전 — 추정 2%'),
  ('_default', 0.025, '미분류 기본값 2.5%')
ON CONFLICT (category_top) DO NOTHING;


-- 3) Sell-through Velocity RPC
--    각 coupang_item_id 의 연속 두 스냅샷(최신, 그 직전) 차분으로 Δreview/Δday 산출,
--    카테고리 review_rate 역수로 실판매수량·월매출을 역산.
CREATE OR REPLACE FUNCTION jimscanner_serp_velocity(
  days_window int DEFAULT 30,
  result_limit int DEFAULT 200
)
RETURNS TABLE (
  coupang_item_id text,
  product_title text,
  keyword text,
  category_top text,
  rank int,
  price int,
  rating numeric,
  review_count int,
  prev_review_count int,
  delta_reviews int,
  delta_days numeric,
  review_rate numeric,
  daily_units numeric,
  monthly_units numeric,
  monthly_revenue numeric,
  first_captured_at timestamptz,
  last_captured_at timestamptz,
  snapshot_count int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH win AS (
    SELECT *
    FROM jimscanner_trends_serp_snapshot
    WHERE captured_at > now() - (days_window || ' days')::interval
  ),
  ranked AS (
    SELECT
      w.*,
      ROW_NUMBER() OVER (PARTITION BY w.coupang_item_id ORDER BY w.captured_at DESC) AS rn,
      COUNT(*)     OVER (PARTITION BY w.coupang_item_id) AS snapshot_count,
      MIN(w.captured_at) OVER (PARTITION BY w.coupang_item_id) AS first_captured_at
    FROM win w
  ),
  paired AS (
    -- 최신(rn=1) 과 직전(rn=2) 을 한 행으로
    SELECT
      cur.coupang_item_id,
      cur.product_title,
      cur.keyword,
      cur.category_top,
      cur.rank,
      cur.price,
      cur.rating,
      cur.review_count,
      prev.review_count AS prev_review_count,
      cur.captured_at   AS last_captured_at,
      prev.captured_at  AS prev_captured_at,
      cur.first_captured_at,
      cur.snapshot_count
    FROM ranked cur
    LEFT JOIN ranked prev
      ON prev.coupang_item_id = cur.coupang_item_id AND prev.rn = 2
    WHERE cur.rn = 1
  ),
  computed AS (
    SELECT
      p.*,
      COALESCE(rr.review_rate, dflt.review_rate, 0.025) AS review_rate,
      GREATEST(p.review_count - COALESCE(p.prev_review_count, p.review_count), 0) AS delta_reviews,
      GREATEST(
        EXTRACT(EPOCH FROM (p.last_captured_at - p.prev_captured_at)) / 86400.0,
        0
      ) AS delta_days
    FROM paired p
    LEFT JOIN jimscanner_trends_review_rate rr ON rr.category_top = p.category_top
    LEFT JOIN jimscanner_trends_review_rate dflt ON dflt.category_top = '_default'
  )
  SELECT
    c.coupang_item_id,
    c.product_title,
    c.keyword,
    c.category_top,
    c.rank,
    c.price,
    c.rating,
    c.review_count,
    c.prev_review_count,
    c.delta_reviews,
    ROUND(c.delta_days::numeric, 3) AS delta_days,
    c.review_rate,
    -- 일 판매수량 = (Δ리뷰 / Δ일) / 리뷰작성률
    CASE WHEN c.delta_days > 0
      THEN ROUND(((c.delta_reviews / c.delta_days) / c.review_rate)::numeric, 1)
      ELSE 0 END AS daily_units,
    CASE WHEN c.delta_days > 0
      THEN ROUND(((c.delta_reviews / c.delta_days) / c.review_rate * 30.0)::numeric, 0)
      ELSE 0 END AS monthly_units,
    CASE WHEN c.delta_days > 0 AND c.price IS NOT NULL
      THEN ROUND(((c.delta_reviews / c.delta_days) / c.review_rate * 30.0 * c.price)::numeric, 0)
      ELSE 0 END AS monthly_revenue,
    c.first_captured_at,
    c.last_captured_at,
    c.snapshot_count::int
  FROM computed c
  ORDER BY
    CASE WHEN c.delta_days > 0 AND c.price IS NOT NULL
      THEN (c.delta_reviews / c.delta_days) / c.review_rate * 30.0 * c.price
      ELSE 0 END DESC
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_serp_velocity(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_serp_velocity(int, int) TO service_role;
