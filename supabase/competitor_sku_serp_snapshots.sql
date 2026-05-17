-- ────────────────────────────────────────────────────────────
-- 경쟁 SKU SERP 스냅샷 & 공백 윈도우 시그널 (PR-VACANCY-1, 2026-05-17)
-- ────────────────────────────────────────────────────────────
-- 목적:
--   네이버쇼핑 SERP 상위 N개 SKU 의 매일 스냅샷을 저장하고,
--   전일 대비 (a) 이탈, (b) 품절 전환, (c) 리뷰 급감 SKU 를
--   "공백 윈도우"로 라벨링해 ggsan 위탁 즉시 진입 액션을 제공.
--
-- 본 SQL 만 적용해도 코드는 빌드된다 (페이지/스크립트는 빈 데이터 처리).
-- ────────────────────────────────────────────────────────────

-- 1) SERP 스냅샷 (매일 cron 으로 적재)
CREATE TABLE IF NOT EXISTS jimscanner_competitor_sku_serp_snapshots (
  id            bigserial PRIMARY KEY,
  snapshot_date date        NOT NULL,
  keyword       text        NOT NULL,
  category_top  text,                       -- 'health' | 'living' | 'digital' | null
  rank          int         NOT NULL,       -- SERP 순위 (1..N)
  sku_id        text        NOT NULL,       -- 네이버쇼핑 productId (또는 mall+nv_mid 합성 key)
  title         text        NOT NULL,
  mall_name     text,
  price_krw     int,
  review_count  int         NOT NULL DEFAULT 0,
  stock_status  text        NOT NULL DEFAULT 'in_stock',
    -- 'in_stock' | 'sold_out' | 'temp_unavailable' | 'restricted' | 'unknown'
  raw_label     text,                       -- 상품 카드의 원본 라벨 텍스트 (디버그용)
  detail_url    text,
  collected_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (snapshot_date, keyword, sku_id)
);

CREATE INDEX IF NOT EXISTS competitor_sku_serp_snapshots_kw_date
  ON jimscanner_competitor_sku_serp_snapshots(keyword, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS competitor_sku_serp_snapshots_sku
  ON jimscanner_competitor_sku_serp_snapshots(sku_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS competitor_sku_serp_snapshots_date
  ON jimscanner_competitor_sku_serp_snapshots(snapshot_date DESC);

ALTER TABLE jimscanner_competitor_sku_serp_snapshots ENABLE ROW LEVEL SECURITY;
-- service_role 만 접근. 사용자 RLS 정책 없음.

-- 2) 공백 윈도우 시그널 (detect-serp-vacancy.mjs 가 매일 채움)
CREATE TABLE IF NOT EXISTS jimscanner_serp_vacancy_signals (
  id              bigserial PRIMARY KEY,
  detected_at     timestamptz NOT NULL DEFAULT now(),
  window_date     date        NOT NULL,    -- 공백 발생 기준 일자
  keyword         text        NOT NULL,
  category_top    text,
  sku_id          text        NOT NULL,
  title           text,
  mall_name       text,
  vacancy_type    text        NOT NULL,
    -- 'dropped_out'   : 전일 Top10 에 있다가 사라짐
    -- 'went_oos'      : 품절/일시품절/구매불가 로 전환
    -- 'review_crash'  : 리뷰 증가가 7일 MA 대비 -80% 이상 급감
  prev_rank       int,
  prev_review     int,
  curr_review     int,
  ma7_delta       numeric(8,2),             -- 7일 평균 일별 리뷰 증가량
  curr_delta      numeric(8,2),             -- 당일 리뷰 증가량
  expected_window_hours int,                -- 잔여 윈도우 추정 (24/48/72)
  ggsan_match_goods_no text,                -- 유사도 매칭된 ggsan goods_no (옵션)
  ggsan_match_score numeric(4,3),
  status          text        NOT NULL DEFAULT 'open',
    -- 'open' | 'pinned' | 'dismissed' | 'expired'
  notes           text,

  UNIQUE (window_date, keyword, sku_id, vacancy_type)
);

CREATE INDEX IF NOT EXISTS serp_vacancy_signals_kw_date
  ON jimscanner_serp_vacancy_signals(window_date DESC, keyword);
CREATE INDEX IF NOT EXISTS serp_vacancy_signals_status
  ON jimscanner_serp_vacancy_signals(status, detected_at DESC);

ALTER TABLE jimscanner_serp_vacancy_signals ENABLE ROW LEVEL SECURITY;
-- service_role 만. 어드민 페이지에서 service_role 클라이언트로 접근.
