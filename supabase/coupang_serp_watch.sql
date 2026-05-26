-- ─────────────────────────────────────────────────────────────
-- 쿠팡 SERP 노출 트래커 — Listing Rank Watch (2026-05-27)
-- ─────────────────────────────────────────────────────────────
-- 발행한 쿠팡 리스팅이 자체 타겟 키워드 검색 결과 어디에 떠 있는지
-- 매일 1회 스냅샷으로 추적. coupang-orders 의 주문 0건 원인이
-- "노출 자체가 없음(타이틀/관련성 문제)" vs "노출은 있는데 비전환
-- (상세/가격 문제)" 인지 분기 진단을 가능하게 한다.
--
-- 운영: service-role 만 접근 (어드민 전용)
-- ─────────────────────────────────────────────────────────────

-- 1) 추적 대상 키워드 (listing 별로 N개 등록 가능)
CREATE TABLE IF NOT EXISTS jimscanner_coupang_serp_keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL,
  target_keyword text NOT NULL,
  weight int NOT NULL DEFAULT 1,           -- 가중치 (메인 키워드=3, 보조=1)
  is_active boolean NOT NULL DEFAULT true,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, target_keyword)
);

CREATE INDEX IF NOT EXISTS jimscanner_coupang_serp_keywords_listing
  ON jimscanner_coupang_serp_keywords (listing_id);
CREATE INDEX IF NOT EXISTS jimscanner_coupang_serp_keywords_active
  ON jimscanner_coupang_serp_keywords (is_active, target_keyword);

ALTER TABLE jimscanner_coupang_serp_keywords ENABLE ROW LEVEL SECURITY;


-- 2) SERP rank 시계열
--    하루 1회 cron 스냅샷. rank=NULL 이면 N위 안에 없음(누락).
--    page = ceil(rank / 72)  (쿠팡 1페이지=72건 기준; 스크래퍼가 산출)
CREATE TABLE IF NOT EXISTS jimscanner_coupang_serp_watch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL,
  target_keyword text NOT NULL,

  rank int,                                -- 1-based; NULL = 미발견
  page int,                                -- 페이지 번호 (NULL = 미발견)
  vendor_id_match boolean NOT NULL DEFAULT false,  -- 우리 vendor 가 노출됐는지
  product_id_match bigint,                 -- 매칭된 product_id (있을 때)
  total_results int,                       -- 검색 결과 total (가능한 경우)
  scan_depth int NOT NULL DEFAULT 360,     -- 스캔한 최대 rank (보통 5페이지=360)

  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_coupang_serp_watch_listing_kw_at
  ON jimscanner_coupang_serp_watch (listing_id, target_keyword, captured_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_coupang_serp_watch_captured
  ON jimscanner_coupang_serp_watch (captured_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_coupang_serp_watch_kw
  ON jimscanner_coupang_serp_watch (target_keyword, captured_at DESC);

ALTER TABLE jimscanner_coupang_serp_watch ENABLE ROW LEVEL SECURITY;


-- 3) 뷰 — 최신 + 7일 평균 (페이지에서 자주 쓰임)
CREATE OR REPLACE VIEW jimscanner_coupang_serp_watch_latest AS
WITH latest AS (
  SELECT DISTINCT ON (listing_id, target_keyword)
    listing_id, target_keyword, rank, page, vendor_id_match,
    product_id_match, total_results, captured_at
  FROM jimscanner_coupang_serp_watch
  ORDER BY listing_id, target_keyword, captured_at DESC
),
agg_7d AS (
  SELECT listing_id, target_keyword,
         AVG(rank)::numeric(10,1) AS avg_rank_7d,
         COUNT(*) FILTER (WHERE rank IS NOT NULL) AS hit_days_7d,
         COUNT(*) AS scan_days_7d
  FROM jimscanner_coupang_serp_watch
  WHERE captured_at >= now() - interval '7 days'
  GROUP BY listing_id, target_keyword
),
agg_30d AS (
  SELECT listing_id, target_keyword,
         AVG(rank)::numeric(10,1) AS avg_rank_30d,
         MIN(rank) AS best_rank_30d
  FROM jimscanner_coupang_serp_watch
  WHERE captured_at >= now() - interval '30 days'
  GROUP BY listing_id, target_keyword
)
SELECT l.*,
       a7.avg_rank_7d, a7.hit_days_7d, a7.scan_days_7d,
       a30.avg_rank_30d, a30.best_rank_30d
FROM latest l
LEFT JOIN agg_7d a7 USING (listing_id, target_keyword)
LEFT JOIN agg_30d a30 USING (listing_id, target_keyword);
