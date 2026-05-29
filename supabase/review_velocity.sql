-- ─────────────────────────────────────────────────────────────
-- 리뷰 증가속도 → 실판매 추정 (Review Velocity Sales Proxy, 2026-05-30)
-- ─────────────────────────────────────────────────────────────
-- 배경: 쿠팡/네이버는 실판매량을 숨기지만 '리뷰 누적수'는 판매의 공인 프록시다.
--   검색량(soft signal) 대신 리뷰 증가분(hard signal)으로 위너를 사전 검증한다.
--
-- 파이프라인:
--   ① WSL collector(scripts/collect-review-velocity.mjs)가 canonical 상품별
--      경쟁 SKU 의 누적 리뷰수를 주기 스냅샷으로 적재
--   ② RPC(jimscanner_review_velocity_board)가 일간 리뷰 증가분(Δreview/day)을 계산
--   ③ 리뷰작성률 가정(구매자의 1~3%)을 역산해 '추정 일판매량 밴드(하한~상한)' 산출
--   ④ trend-radar/review-velocity 보드가 ① 추정 실판매↑ × ② ggsan 소싱가↓ 사분면 랭킹
--
-- 노출 정책: 기존 jimscanner_trends_* 패턴과 동일 — RLS enable + 정책 X = service-role 만.
-- ─────────────────────────────────────────────────────────────

-- pg_trgm (ggsan title 매칭용) — 이미 trends_v4_ggsan.sql 에서 생성됐을 수 있음
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1) 리뷰 속도 스냅샷 (시계열 — 매 수집마다 새 row, Δ는 RPC 가 계산)
CREATE TABLE IF NOT EXISTS jimscanner_review_velocity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  marketplace text NOT NULL,             -- 'coupang' | 'naver' | 'gmarket' 등
  competitor_sku text NOT NULL,          -- 마켓 내 상품 ID (쿠팡 productId, 네이버 nvMid 등)

  review_count int NOT NULL,             -- 관측 시점 누적 리뷰수
  rating_avg numeric,                    -- 평균 평점 (0~5, 옵션)
  sku_title text,                        -- 경쟁 SKU 제목 (디버깅·UI 표시용)
  sku_price_krw int,                     -- 경쟁 SKU 판매가 (옵션)
  serp_rank int,                         -- SERP 상위 노출 순위 (옵션)
  raw_payload jsonb,                     -- 원천 응답 (재파싱용)

  observed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_review_velocity_product_at
  ON jimscanner_review_velocity(product_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_review_velocity_sku_at
  ON jimscanner_review_velocity(marketplace, competitor_sku, observed_at DESC);

ALTER TABLE jimscanner_review_velocity ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role) 만.


-- 2) 보드 RPC: Δreview/day → 추정 일판매량 밴드 + ggsan 소싱가 매칭
-- ─────────────────────────────────────────────────────────────
-- write_rate_low/high = 구매자의 리뷰작성률 가정 (기본 1%~3%).
--   sales = reviews / write_rate 이므로:
--     est_sales_low  = review_per_day / write_rate_high (작성률 높음 → 판매 적게 추정)
--     est_sales_high = review_per_day / write_rate_low  (작성률 낮음 → 판매 많게 추정)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_review_velocity_board(
  days_window int DEFAULT 30,
  write_rate_low float DEFAULT 0.01,
  write_rate_high float DEFAULT 0.03,
  min_sim float DEFAULT 0.20,
  result_limit int DEFAULT 100
)
RETURNS TABLE (
  product_id uuid,
  canonical_name text,
  category_top text,
  -- 리뷰 속도 (hard signal)
  marketplace_count int,
  sku_count int,
  review_total_latest numeric,
  review_delta numeric,
  days_span numeric,
  review_per_day numeric,
  rating_avg numeric,
  -- 추정 실판매 밴드
  est_sales_low numeric,
  est_sales_high numeric,
  -- ggsan 소싱 (마진 축)
  ggsan_goods_no text,
  ggsan_title text,
  ggsan_price_krw int,
  -- 관측 메타
  observed_first timestamptz,
  observed_last timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH window_snaps AS (
    SELECT product_id, marketplace, competitor_sku, review_count, rating_avg, observed_at
    FROM jimscanner_review_velocity
    WHERE observed_at > now() - (days_window || ' days')::interval
  ),
  -- SKU 단위 윈도 내 최초/최신 리뷰수
  sku_agg AS (
    SELECT
      product_id, marketplace, competitor_sku,
      (array_agg(review_count ORDER BY observed_at ASC))[1]  AS first_count,
      (array_agg(review_count ORDER BY observed_at DESC))[1] AS last_count,
      (array_agg(rating_avg   ORDER BY observed_at DESC))[1] AS last_rating,
      min(observed_at) AS first_at,
      max(observed_at) AS last_at
    FROM window_snaps
    GROUP BY product_id, marketplace, competitor_sku
  ),
  -- canonical 상품 단위 합산
  prod_agg AS (
    SELECT
      product_id,
      count(*)::int AS sku_count,
      count(DISTINCT marketplace)::int AS marketplace_count,
      sum(last_count)::numeric AS review_total_latest,
      sum(GREATEST(last_count - first_count, 0))::numeric AS review_delta,
      avg(last_rating) AS rating_avg,
      min(first_at) AS observed_first,
      max(last_at)  AS observed_last
    FROM sku_agg
    GROUP BY product_id
  ),
  velocity AS (
    SELECT
      pa.*,
      GREATEST(
        EXTRACT(EPOCH FROM (pa.observed_last - pa.observed_first)) / 86400.0,
        1.0
      )::numeric AS days_span_calc
    FROM prod_agg pa
  )
  SELECT
    v.product_id,
    p.canonical_name,
    p.category_top,
    v.marketplace_count,
    v.sku_count,
    v.review_total_latest,
    v.review_delta,
    round(v.days_span_calc, 2) AS days_span,
    round(v.review_delta / v.days_span_calc, 3) AS review_per_day,
    round(v.rating_avg, 2) AS rating_avg,
    -- 추정 일판매량 밴드 (작성률 역산)
    round((v.review_delta / v.days_span_calc) / NULLIF(write_rate_high, 0), 1) AS est_sales_low,
    round((v.review_delta / v.days_span_calc) / NULLIF(write_rate_low, 0), 1)  AS est_sales_high,
    -- ggsan 최저가 매칭 (소싱 마진 축)
    g.goods_no AS ggsan_goods_no,
    g.title    AS ggsan_title,
    g.price_krw AS ggsan_price_krw,
    v.observed_first,
    v.observed_last
  FROM velocity v
  JOIN jimscanner_trends_products p ON p.id = v.product_id
  LEFT JOIN LATERAL (
    SELECT gp.goods_no, gp.title, gp.price_krw
    FROM jimscanner_ggsan_products gp
    WHERE gp.title % p.canonical_name
      AND similarity(p.canonical_name, gp.title) >= min_sim
      AND gp.status = 'active'
    ORDER BY similarity(p.canonical_name, gp.title) DESC, gp.price_krw ASC NULLS LAST
    LIMIT 1
  ) g ON true
  WHERE v.review_delta > 0
  ORDER BY (v.review_delta / v.days_span_calc) DESC
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출
REVOKE ALL ON FUNCTION jimscanner_review_velocity_board(int, float, float, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_review_velocity_board(int, float, float, float, int) TO service_role;
