-- channel_pnl_lookup.sql
-- 채널 × 카테고리 마진/광고비/전환율 룩업 시드 + 핀별 ROI 자동 계산 뷰
--
-- 4계층 모델 중 Phase 0 (엔드유저용 비교 페이지 + 어드민) 의
-- 운영자 의사결정 도구. /admin/trend-radar/channel-pnl 에서 사용.
--
-- 적용:
--   psql ... -f supabase/channel_pnl_lookup.sql
--
-- 의존: jimscanner_trends_products (trends_v4_seller_tools.sql)

-- 1) 채널 마스터 시드
CREATE TABLE IF NOT EXISTS jimscanner_channel_master (
  channel_code text PRIMARY KEY,            -- 'smartstore' | 'coupang' | '11st' | 'self'
  channel_label text NOT NULL,
  default_fee_pct numeric NOT NULL,         -- 0.0700 = 7%
  default_cpc_krw int NOT NULL,             -- 평균 CPC 추정
  default_ctr numeric NOT NULL DEFAULT 0.025, -- 클릭률
  default_cr numeric NOT NULL DEFAULT 0.020,  -- 전환율
  natural_traffic_possible boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO jimscanner_channel_master (channel_code, channel_label, default_fee_pct, default_cpc_krw, default_ctr, default_cr, natural_traffic_possible, notes)
VALUES
  ('smartstore', 'Smartstore',   0.0700,  300, 0.030, 0.025, true,  '네이버쇼핑 노출 강 · SEO 가능'),
  ('coupang',    'Coupang',      0.1400,  900, 0.025, 0.030, false, '광고비 헤비 · 자연유입 거의 불가'),
  ('11st',       '11번가',       0.1000,  500, 0.022, 0.020, true,  'SK pay 결제 묶음, SEO 부분 가능'),
  ('self',       '자사몰',       0.0300, 1200, 0.015, 0.025, false, '광고로만 트래픽 확보, 마진은 최상')
ON CONFLICT (channel_code) DO NOTHING;

-- 2) 채널 × 카테고리 오버라이드 (선택)
CREATE TABLE IF NOT EXISTS jimscanner_channel_category_pnl (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_code text NOT NULL REFERENCES jimscanner_channel_master(channel_code) ON DELETE CASCADE,
  category_top text NOT NULL,               -- jimscanner_trends_products.category_top
  fee_pct numeric,                          -- NULL → master 사용
  cpc_krw int,
  ctr numeric,
  cr numeric,
  seo_difficulty numeric,                   -- 0~1, 0=쉬움, 1=극난
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_code, category_top)
);

-- 카테고리 시드 — 시장 관찰 기반 첫 추정
INSERT INTO jimscanner_channel_category_pnl (channel_code, category_top, fee_pct, cpc_krw, ctr, cr, seo_difficulty)
VALUES
  ('smartstore', 'health',  0.0700,  450, 0.028, 0.022, 0.75),
  ('smartstore', 'living',  0.0700,  280, 0.032, 0.028, 0.55),
  ('smartstore', 'digital', 0.0700,  380, 0.025, 0.020, 0.70),

  ('coupang',    'health',  0.1400, 1200, 0.024, 0.030, 0.85),
  ('coupang',    'living',  0.1300,  750, 0.026, 0.032, 0.65),
  ('coupang',    'digital', 0.1400,  950, 0.022, 0.028, 0.80),

  ('11st',       'health',  0.1000,  600, 0.020, 0.018, 0.50),
  ('11st',       'living',  0.1000,  400, 0.024, 0.020, 0.40),
  ('11st',       'digital', 0.1000,  550, 0.020, 0.018, 0.55),

  ('self',       'health',  0.0300, 1500, 0.012, 0.024, 0.40),
  ('self',       'living',  0.0300, 1000, 0.018, 0.026, 0.30),
  ('self',       'digital', 0.0300, 1400, 0.014, 0.022, 0.40)
ON CONFLICT (channel_code, category_top) DO NOTHING;

-- 3) 핀별 채널 P&L 뷰
--    행: jimscanner_trends_products (모든 상품 후보)
--    열: 4 채널
--    셀: fee/CPC/SEO/순마진/주간GMV
--
-- 가정:
--   - 평균 판매가: 25,000원 (카테고리별 오버라이드 가능 — 다음 버전)
--   - 주간 검색량 proxy: alias_count × 1500 (위탁 후보 인지도 추정)
--   - 광고비 = (방문/CR) × CPC, 방문 = GMV / 판매가
CREATE OR REPLACE VIEW jimscanner_channel_pnl_view AS
WITH base AS (
  SELECT
    p.id            AS product_id,
    p.canonical_name,
    p.category_top,
    p.category_mid,
    p.alias_count,
    p.last_seen_at,
    25000::numeric  AS assumed_price_krw,
    GREATEST(p.alias_count, 1) * 1500 AS weekly_search_volume
  FROM jimscanner_trends_products p
),
channel_x AS (
  SELECT
    b.*,
    cm.channel_code,
    cm.channel_label,
    cm.natural_traffic_possible,
    COALESCE(cp.fee_pct,        cm.default_fee_pct)  AS fee_pct,
    COALESCE(cp.cpc_krw,        cm.default_cpc_krw)  AS cpc_krw,
    COALESCE(cp.ctr,            cm.default_ctr)      AS ctr,
    COALESCE(cp.cr,             cm.default_cr)       AS cr,
    COALESCE(cp.seo_difficulty, 0.6)                 AS seo_difficulty
  FROM base b
  CROSS JOIN jimscanner_channel_master cm
  LEFT JOIN jimscanner_channel_category_pnl cp
    ON cp.channel_code = cm.channel_code
   AND cp.category_top = b.category_top
)
SELECT
  product_id,
  canonical_name,
  category_top,
  category_mid,
  alias_count,
  last_seen_at,
  channel_code,
  channel_label,
  natural_traffic_possible,
  fee_pct,
  cpc_krw,
  seo_difficulty,
  assumed_price_krw,
  weekly_search_volume,
  -- 주간 추정 GMV = 검색량 × CTR × CR × 판매가
  ROUND((weekly_search_volume * ctr * cr * assumed_price_krw)::numeric, 0) AS weekly_gmv_krw,
  -- 주간 클릭수
  ROUND((weekly_search_volume * ctr)::numeric, 0) AS weekly_clicks,
  -- 주간 광고비 = 클릭수 × CPC
  ROUND((weekly_search_volume * ctr * cpc_krw)::numeric, 0) AS weekly_ad_spend_krw,
  -- 순마진율 = 1 - 채널수수료 - (광고비/GMV)
  -- GMV=0 인 경우 NULL
  CASE
    WHEN (weekly_search_volume * ctr * cr * assumed_price_krw) > 0 THEN
      ROUND(
        (1 - fee_pct - (cpc_krw::numeric / NULLIF(cr * assumed_price_krw, 0)))::numeric,
        4
      )
    ELSE NULL
  END AS net_margin_pct
FROM channel_x;

COMMENT ON VIEW jimscanner_channel_pnl_view IS
  '채널×핀 P&L 매트릭스: /admin/trend-radar/channel-pnl 에서 사용. ' ||
  '가정 — 판매가 25k, 주간검색량 = alias_count × 1500. 향후 ggsan price 연동.';
