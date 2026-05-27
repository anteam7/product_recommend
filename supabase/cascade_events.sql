-- ─────────────────────────────────────────────────────────────
-- 경쟁사 Top-N 동시 품절 Cascade 보드 (2026-05-27)
-- ─────────────────────────────────────────────────────────────
-- 카테고리별 쿠팡 SERP 상위 셀러의 재고/배송지연 상태를 1~2시간 주기로 수집해
-- competitor_stock_snapshot 에 적재. Top-3 중 2개 이상 동시 품절·예약발송
-- 전환되면 cascade_event 로 마킹. 매칭 SKU 는 jimscanner_coupang_listings
-- (자사 발행) 및 jimscanner_trends_products (핀 후보) 양쪽에서 카테고리 키로 join.
-- 노출 정책: 모든 테이블 RLS enable + 정책 없음 = service-role 만 접근.
-- ─────────────────────────────────────────────────────────────

-- 1) 카테고리 시드 (어떤 SERP 키워드를 폴링할지)
CREATE TABLE IF NOT EXISTS jimscanner_cascade_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_key text NOT NULL UNIQUE,        -- 'health.melatonin' 같은 dot key
  category_label text NOT NULL,             -- '식물성 멜라토닌' 등 사람용
  category_top text,                        -- 'health' | 'living' | 'digital' (선택)
  serp_keyword text NOT NULL,               -- 쿠팡 SERP 질의
  top_n int NOT NULL DEFAULT 10,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_cascade_categories_active_idx
  ON jimscanner_cascade_categories(active, category_top);

ALTER TABLE jimscanner_cascade_categories ENABLE ROW LEVEL SECURITY;


-- 2) 경쟁사 재고 스냅샷 (시간별 raw)
CREATE TABLE IF NOT EXISTS jimscanner_competitor_stock_snapshot (
  id bigserial PRIMARY KEY,
  category_key text NOT NULL,
  serp_rank int NOT NULL,                   -- 1..N (수집 시점 SERP 위치)
  product_id text NOT NULL,                 -- 쿠팡 productId (vp/products/{id})
  product_url text,
  product_title text,
  vendor_id text,                           -- 셀러 id (있으면)
  seller_name text,
  price_krw int,
  stock_status text NOT NULL,               -- 'in_stock' | 'sold_out' | 'preorder' | 'delayed' | 'unknown'
  delivery_eta_days int,                    -- 예약발송/지연 days (있으면)
  raw jsonb,                                -- 원본 일부 (debug)
  observed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_competitor_stock_snapshot_cat_at
  ON jimscanner_competitor_stock_snapshot(category_key, observed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_competitor_stock_snapshot_product
  ON jimscanner_competitor_stock_snapshot(product_id, observed_at DESC);

ALTER TABLE jimscanner_competitor_stock_snapshot ENABLE ROW LEVEL SECURITY;


-- 3) Cascade 이벤트 (Top-3 중 2개 이상 동시 품절·예약발송 전환)
CREATE TABLE IF NOT EXISTS jimscanner_cascade_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_key text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,                     -- 해소되면 채움 (Top-3 중 2개 이상 재입고)
  trigger_snapshot_id bigint,               -- 최초 트리거 스냅샷 (옵션)

  -- 트리거 당시 Top-N 상태 요약
  top_n int NOT NULL,
  out_of_stock_count int NOT NULL,          -- Top-3 중 OOS/preorder/delayed 수
  affected_product_ids text[] NOT NULL,     -- 영향받은 쿠팡 productId 목록
  affected_titles text[],                   -- 사람이 보는 제목 (디버그)

  -- 권장 광고/노출 부스트 윈도우 (분)
  recommended_boost_minutes int,            -- 평균 재입고 ETA 역산값
  recommended_ad_uplift_pct int,            -- 권장 광고비 인상률 (heuristic)

  -- 매칭 결과 캐시 (UI에서 즉시 표시)
  matched_listing_ids uuid[],               -- jimscanner_coupang_listings.id[]
  matched_trend_product_ids uuid[],         -- jimscanner_trends_products.id[]

  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_cascade_events_active_idx
  ON jimscanner_cascade_events(is_active, started_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_cascade_events_category_idx
  ON jimscanner_cascade_events(category_key, started_at DESC);

ALTER TABLE jimscanner_cascade_events ENABLE ROW LEVEL SECURITY;


-- 4) 폴링 실행 로그
CREATE TABLE IF NOT EXISTS jimscanner_cascade_poll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  triggered_by text,                        -- 'cron' | 'manual' | 'script'
  categories_checked int NOT NULL DEFAULT 0,
  snapshots_inserted int NOT NULL DEFAULT 0,
  events_opened int NOT NULL DEFAULT 0,
  events_closed int NOT NULL DEFAULT 0,
  duration_ms int,
  status text,                              -- 'running' | 'success' | 'error'
  error_message text
);

ALTER TABLE jimscanner_cascade_poll_runs ENABLE ROW LEVEL SECURITY;


-- 5) 초기 시드 (예시 카테고리 — 필요 시 어드민에서 수정)
INSERT INTO jimscanner_cascade_categories (category_key, category_label, category_top, serp_keyword, top_n)
VALUES
  ('health.melatonin',     '식물성 멜라토닌',     'health',  '식물성 멜라토닌',     10),
  ('health.albumin',       '알부민 영양제',       'health',  '알부민',              10),
  ('health.lutein',        '루테인',             'health',  '루테인',              10),
  ('living.compression',   '압축팩',             'living',  '진공 압축팩',         10),
  ('digital.charger-65w',  '65W 충전기',         'digital', '65W GaN 충전기',      10)
ON CONFLICT (category_key) DO NOTHING;
