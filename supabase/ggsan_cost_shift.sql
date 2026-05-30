-- ──────────────────────────────────────────────────────────────────────────
-- 도매가 변동 추적 → 마진 재계산 양방향 알림 보드
--   /admin/trend-radar/cost-shift 백엔드 뷰
--
-- jimscanner_ggsan_price_history 의 가격 시계열에서 goods_no 별
--   (a) 최신 가격(cur) 과 (b) 직전 "다른" 가격(prev) 을 골라 델타를 계산하고,
-- 매칭/발행된 쿠팡 리스팅(jimscanner_coupang_listings.source_goods_no = goods_no)이 있으면
-- 쿠팡 가격공식(SHIP=3000, FEE=0.106, VAT=list/11)으로 변동 전후 기대마진을 재계산한다.
--
-- 위탁판매는 도매가 = 원가 이므로, 공급가가 list_price 고정 상태에서 한 번 인상되면
-- Δ마진 = (prev_dome - cur_dome) 만큼 그대로 마진에 반영된다(수수료/부가세는 판매가 의존 → 불변).
--   · 도매가 하락(drop) → 마진 확대 → 즉시 리프라이싱/재발굴 기회 큐
--   · 도매가 인상(rise) → 마진 임계 하향 돌파 → 가격 인상·철수 후보 큐
--
-- 적용:  psql "$DATABASE_URL" -f supabase/ggsan_cost_shift.sql
-- (코드는 이 뷰가 존재한다고 가정. 타입 미생성이므로 select 시 `as any` 캐스팅 사용)
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW jimscanner_ggsan_cost_shift AS
WITH hist AS (
  SELECT
    goods_no,
    price_krw,
    observed_at,
    ROW_NUMBER() OVER (PARTITION BY goods_no ORDER BY observed_at DESC) AS rn
  FROM jimscanner_ggsan_price_history
  WHERE price_krw IS NOT NULL AND price_krw > 0
),
latest AS (
  SELECT goods_no, price_krw AS cur_price, observed_at AS cur_at
  FROM hist
  WHERE rn = 1
),
-- 현재 가격과 "다른" 가장 최근 관측치 = 직전 가격 (단순 재관측 노이즈 무시)
prev AS (
  SELECT DISTINCT ON (h.goods_no)
    h.goods_no,
    h.price_krw   AS prev_price,
    h.observed_at AS prev_at
  FROM hist h
  JOIN latest l ON l.goods_no = h.goods_no
  WHERE h.price_krw <> l.cur_price
  ORDER BY h.goods_no, h.observed_at DESC
),
-- goods_no 당 발행된 리스팅 1건 (가장 최근 등록)
listing AS (
  SELECT DISTINCT ON (cl.source_goods_no)
    cl.source_goods_no AS goods_no,
    cl.seller_product_id,
    cl.registered_title,
    cl.status,
    cl.list_price_krw,
    cl.dome_price_krw,
    cl.estimated_margin_pct
  FROM jimscanner_coupang_listings cl
  WHERE cl.source_goods_no IS NOT NULL
  ORDER BY cl.source_goods_no, cl.id DESC
)
SELECT
  p.goods_no,
  p.title,
  p.cate_cd,
  p.cate_label,
  p.is_imminent,
  p.last_changed_at,
  l.cur_price,
  l.cur_at,
  pv.prev_price,
  pv.prev_at,
  (l.cur_price - pv.prev_price)                                   AS price_delta,
  ROUND((l.cur_price - pv.prev_price) * 100.0 / NULLIF(pv.prev_price, 0), 2) AS price_delta_pct,
  CASE WHEN l.cur_price < pv.prev_price THEN 'drop' ELSE 'rise' END AS direction,
  -- 발행 리스팅 (없으면 NULL)
  ls.seller_product_id,
  ls.registered_title,
  ls.status AS listing_status,
  ls.list_price_krw,
  -- 변동 전/후 기대마진 (판매가 고정 가정, 수수료/부가세는 판매가 의존 → 불변)
  CASE WHEN ls.list_price_krw > 0 THEN
    (ls.list_price_krw - (pv.prev_price + 3000)
      - ROUND(ls.list_price_krw * 0.106) - ROUND(ls.list_price_krw / 11.0))::int
  END AS prev_margin_krw,
  CASE WHEN ls.list_price_krw > 0 THEN
    (ls.list_price_krw - (l.cur_price + 3000)
      - ROUND(ls.list_price_krw * 0.106) - ROUND(ls.list_price_krw / 11.0))::int
  END AS cur_margin_krw,
  CASE WHEN ls.list_price_krw > 0 THEN
    ROUND((ls.list_price_krw - (pv.prev_price + 3000)
      - ROUND(ls.list_price_krw * 0.106) - ROUND(ls.list_price_krw / 11.0)) * 100.0
      / ls.list_price_krw, 2)
  END AS prev_margin_pct,
  CASE WHEN ls.list_price_krw > 0 THEN
    ROUND((ls.list_price_krw - (l.cur_price + 3000)
      - ROUND(ls.list_price_krw * 0.106) - ROUND(ls.list_price_krw / 11.0)) * 100.0
      / ls.list_price_krw, 2)
  END AS cur_margin_pct,
  -- Δ마진율(p.p.) = 도매가 델타가 마진에 그대로 반영
  CASE WHEN ls.list_price_krw > 0 THEN
    ROUND((pv.prev_price - l.cur_price) * 100.0 / ls.list_price_krw, 2)
  END AS margin_delta_pct,
  (ls.seller_product_id IS NOT NULL) AS is_published
FROM latest l
JOIN prev pv          ON pv.goods_no = l.goods_no
JOIN jimscanner_ggsan_products p ON p.goods_no = l.goods_no
LEFT JOIN listing ls  ON ls.goods_no = l.goods_no;

COMMENT ON VIEW jimscanner_ggsan_cost_shift IS
  '도매가 변동(최신 vs 직전 다른 가격) + 발행 리스팅 기대마진 재계산. /trend-radar/cost-shift 보드용.';

-- 익명/anon 접근 없음 — service-role(어드민)만 사용. RLS 는 베이스 테이블에서 강제.
