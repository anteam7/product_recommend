-- SERP 신규 셀러 진입률 — Competitive Entry Velocity
-- 2026-05-26
--
-- 네이버 쇼핑 SERP 상위 N위 셀러를 키워드별 일 1회 스냅샷 → 신규 진입/이탈 속도 측정.
-- 시드(검색량) × NewSellerRate 산점도로 골드러시 1~2주차 변곡점 포착.

-- ─────────────────────────────────────────
-- 1) SERP 셀러 스냅샷
CREATE TABLE IF NOT EXISTS jimscanner_serp_seller_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword text NOT NULL,
  seller_id text NOT NULL,         -- naver mall id (없으면 도메인 해시)
  seller_name text NOT NULL,
  rank int NOT NULL,
  mall_type text,                  -- 'naver' | 'overseas' | 'small' | 'rental' | etc.
  product_id text,                 -- naver productId
  product_title text,
  price int,
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  snapshot_date date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Seoul')::date
);

CREATE INDEX IF NOT EXISTS jimscanner_serp_seller_snapshots_kw_date
  ON jimscanner_serp_seller_snapshots(keyword, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS jimscanner_serp_seller_snapshots_seller
  ON jimscanner_serp_seller_snapshots(seller_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS jimscanner_serp_seller_snapshots_kw_seller_date
  ON jimscanner_serp_seller_snapshots(keyword, seller_id, snapshot_date);

ALTER TABLE jimscanner_serp_seller_snapshots ENABLE ROW LEVEL SECURITY;
-- service_role 만 접근. 공개 SELECT 정책 없음.

-- ─────────────────────────────────────────
-- 2) cron 감사 로그는 기존 jimscanner_trends_runs (source='naver_shopping_serp') 재사용

-- ─────────────────────────────────────────
-- 3) Entry Velocity View — 키워드별 신규 진입률 / 이탈률 / phase 분류
CREATE OR REPLACE VIEW serp_entry_velocity_v AS
WITH
sellers_28d AS (
  SELECT keyword, seller_id, seller_name,
         MIN(snapshot_date) AS first_seen,
         MAX(snapshot_date) AS last_seen,
         COUNT(*) AS appearance_count
  FROM jimscanner_serp_seller_snapshots
  WHERE snapshot_date >= (CURRENT_DATE - INTERVAL '28 days')
  GROUP BY keyword, seller_id, seller_name
),
kw_agg AS (
  SELECT
    keyword,
    COUNT(*) AS sellers_28d,
    COUNT(*) FILTER (WHERE first_seen >= (CURRENT_DATE - INTERVAL '7 days')) AS new_sellers_7d,
    COUNT(*) FILTER (WHERE last_seen < (CURRENT_DATE - INTERVAL '7 days')) AS churned_sellers_7d,
    COUNT(*) FILTER (WHERE last_seen >= (CURRENT_DATE - INTERVAL '2 days')) AS active_sellers_2d
  FROM sellers_28d
  GROUP BY keyword
)
SELECT
  k.keyword,
  k.sellers_28d,
  k.new_sellers_7d,
  k.churned_sellers_7d,
  k.active_sellers_2d,
  CASE WHEN k.sellers_28d > 0
       THEN ROUND((k.new_sellers_7d::numeric / k.sellers_28d::numeric) * 100, 1)
       ELSE 0 END AS new_seller_rate_pct,
  CASE WHEN k.sellers_28d > 0
       THEN ROUND((k.churned_sellers_7d::numeric / k.sellers_28d::numeric) * 100, 1)
       ELSE 0 END AS churn_rate_pct,
  -- entry_phase: rush(신규폭증) / saturating(포화시작) / stable(안정) / cooling(식어감)
  CASE
    WHEN k.sellers_28d = 0 THEN 'unknown'
    WHEN (k.new_sellers_7d::numeric / NULLIF(k.sellers_28d,0)) >= 0.30
         AND (k.churned_sellers_7d::numeric / NULLIF(k.sellers_28d,0)) < 0.15
      THEN 'rush'
    WHEN (k.new_sellers_7d::numeric / NULLIF(k.sellers_28d,0)) >= 0.15
         AND (k.churned_sellers_7d::numeric / NULLIF(k.sellers_28d,0)) >= 0.15
      THEN 'saturating'
    WHEN (k.churned_sellers_7d::numeric / NULLIF(k.sellers_28d,0)) >= 0.25
      THEN 'cooling'
    ELSE 'stable'
  END AS entry_phase
FROM kw_agg k;

-- ─────────────────────────────────────────
-- 4) 핀 큐에 entry_phase 노출용: 기존 jimscanner_trends_pins 와 keyword join 시 위 view 사용.
--    별도 컬럼 추가 대신 view join 으로 결합 (이력 보존).
