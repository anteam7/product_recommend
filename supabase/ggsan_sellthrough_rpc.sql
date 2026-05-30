-- ────────────────────────────────────────────────────────────
-- ggsan 품절 회전율 RPC — 셀스루 수요신호 × 재입고 안정성 게이트
-- (product_discovery, 2026-05-30)
-- ────────────────────────────────────────────────────────────
-- jimscanner_ggsan_price_history(goods_no, status, observed_at) 의
-- status 전이(active↔sold_out↔imminent↔removed)를 시계열로 집계해
--   ① 셀스루 속도   = 관측 기간 대비 sold_out 진입 횟수(+평균 재고 지속일)
--   ② 재입고 안정성 = sold_out→active 복귀 횟수·평균 복귀 리드타임·removed 영구이탈
-- 을 goods_no별로 산출한다.
--
-- 도매 품절은 양면 신호다 — 빠른 소진 = 실수요 강함(공급측 증거),
-- 동시에 쿠팡 주문 시 미발송 페널티 리스크. 우상단(빠른 소진+안정 재입고)
-- 이 최우선 소싱, 우하단(빠른 소진+불안정 재입고)이 미발송 경고 대상.
--
-- 적용: psql + PGPASSWORD (docs/database.md, Connection Pooler 6543)
-- UI: src/app/admin/(dashboard)/trend-radar/ggsan/page.tsx (탭 '소싱 안정성')
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_ggsan_sellthrough_rpc(
  days_window int DEFAULT 90,
  result_limit int DEFAULT 300
)
RETURNS TABLE (
  goods_no text,
  title text,
  cate_cd text,
  cate_label text,
  price_krw integer,
  image_url text,
  detail_url text,
  current_status text,
  observation_days numeric,
  observation_count int,
  soldout_entries int,
  avg_stock_days numeric,
  sellthrough_velocity numeric,    -- 30일당 품절 진입 횟수
  restock_count int,
  avg_restock_lead_days numeric,
  is_removed boolean,
  restock_reliability numeric      -- 0..100
)
LANGUAGE sql STABLE
AS $$
WITH hist AS (
  SELECT
    h.goods_no,
    h.status,
    h.observed_at,
    LAG(h.status)      OVER (PARTITION BY h.goods_no ORDER BY h.observed_at) AS prev_status,
    LAG(h.observed_at) OVER (PARTITION BY h.goods_no ORDER BY h.observed_at) AS prev_at
  FROM jimscanner_ggsan_price_history h
  WHERE h.observed_at >= now() - make_interval(days => days_window)
),
trans AS (
  SELECT
    goods_no,
    status,
    observed_at,
    -- sold_out 진입: 직전이 sold_out 이 아니었다가 sold_out 으로
    CASE WHEN status = 'sold_out' AND prev_status IS DISTINCT FROM 'sold_out' THEN 1 ELSE 0 END AS soldout_entry,
    -- 재입고: 직전 sold_out → 현재 active
    CASE WHEN status = 'active' AND prev_status = 'sold_out' THEN 1 ELSE 0 END AS restock_entry,
    -- 재입고 리드타임 (sold_out 관측 → active 복귀 사이 경과일)
    CASE WHEN status = 'active' AND prev_status = 'sold_out'
         THEN EXTRACT(EPOCH FROM (observed_at - prev_at)) / 86400.0 END AS restock_lead_days,
    -- 재고 지속일 (active → sold_out 진입까지 버틴 일수)
    CASE WHEN status = 'sold_out' AND prev_status = 'active'
         THEN EXTRACT(EPOCH FROM (observed_at - prev_at)) / 86400.0 END AS stock_span_days
  FROM hist
),
agg AS (
  SELECT
    goods_no,
    COUNT(*)::int                                                       AS observation_count,
    EXTRACT(EPOCH FROM (MAX(observed_at) - MIN(observed_at))) / 86400.0 AS observation_days,
    SUM(soldout_entry)                                                  AS soldout_entries,
    SUM(restock_entry)                                                  AS restock_count,
    AVG(restock_lead_days)                                              AS avg_restock_lead_days,
    AVG(stock_span_days)                                                AS avg_stock_days,
    bool_or(status = 'removed')                                        AS is_removed
  FROM trans
  GROUP BY goods_no
)
SELECT
  a.goods_no,
  p.title,
  p.cate_cd,
  p.cate_label,
  p.price_krw,
  p.image_url,
  p.detail_url,
  p.status AS current_status,
  ROUND(a.observation_days::numeric, 1)                       AS observation_days,
  a.observation_count,
  COALESCE(a.soldout_entries, 0)::int                         AS soldout_entries,
  ROUND(a.avg_stock_days::numeric, 1)                         AS avg_stock_days,
  -- ① 셀스루 속도 = 30일 환산 품절 진입 횟수
  CASE WHEN a.observation_days >= 1
       THEN ROUND((COALESCE(a.soldout_entries, 0) * 30.0 / a.observation_days)::numeric, 2)
       ELSE 0 END                                             AS sellthrough_velocity,
  COALESCE(a.restock_count, 0)::int                           AS restock_count,
  ROUND(a.avg_restock_lead_days::numeric, 1)                  AS avg_restock_lead_days,
  COALESCE(a.is_removed, false)                               AS is_removed,
  -- ② 재입고 신뢰도 0..100 = 복귀율(70) + 리드타임 가점(30), removed=0
  CASE
    WHEN a.is_removed THEN 0
    WHEN COALESCE(a.soldout_entries, 0) = 0 THEN 100
    ELSE LEAST(100, ROUND(
        LEAST(a.restock_count::numeric / NULLIF(a.soldout_entries, 0), 1.0) * 70
      + CASE
          WHEN a.avg_restock_lead_days IS NULL  THEN 0
          WHEN a.avg_restock_lead_days <= 2     THEN 30
          WHEN a.avg_restock_lead_days <= 7     THEN 20
          WHEN a.avg_restock_lead_days <= 14    THEN 10
          ELSE 0
        END
    , 0))
  END                                                         AS restock_reliability
FROM agg a
JOIN jimscanner_ggsan_products p ON p.goods_no = a.goods_no
WHERE COALESCE(a.soldout_entries, 0) > 0 OR COALESCE(a.is_removed, false)
ORDER BY sellthrough_velocity DESC, restock_reliability DESC
LIMIT result_limit;
$$;

-- supplier_score 주입 헬퍼 (선택): score_components 에 restock_reliability 항목 머지.
-- 스코어러 cron 이 product 매핑 후 호출. UI 와 무관하게 점수 반영용.
COMMENT ON FUNCTION jimscanner_ggsan_sellthrough_rpc(int, int) IS
  '품절 회전율 보드: 셀스루속도 × 재입고신뢰도. 우상단=최우선 소싱, 우하단=미발송 리스크.';
