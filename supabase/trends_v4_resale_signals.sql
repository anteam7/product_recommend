-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 중고시장 잔존가치·회전율 신호 (2026-05-20)
-- ─────────────────────────────────────────────────────────────
-- 목적: 위탁 후회구매 게이트. 구매 직후 만족도(=중고시장 행동)를 측정한다.
--   - 잔존가치 (used / new ratio): 낮으면 후회구매
--   - 회전속도 (days-to-sold median): 빠르면 수요 강함
--   - 매물밀도 (active listings / 30d sold): 높으면 처분압력
-- 데이터 소스: 당근마켓·번개장터·중고나라 (수집기 scripts/collect-resale.mjs)
-- 노출 정책: service-role 전용 (기존 jimscanner_trends_* 패턴)
-- ─────────────────────────────────────────────────────────────

-- 1) 중고시장 raw 시그널 (시계열, 매 수집 시 새 row)
CREATE TABLE IF NOT EXISTS jimscanner_trends_resale_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  source text NOT NULL,                -- 'danggeun' | 'bunjang' | 'joongna'
  query  text NOT NULL,                -- 실제 검색에 쓴 키워드 (canonical_name 또는 alias)

  listings_active        int    NOT NULL DEFAULT 0,   -- 활성 매물 수
  avg_used_price         numeric,                     -- 활성 매물 평균가 (KRW)
  new_price_ref          numeric,                     -- 신품 참고가 (쿠팡·ggsan 등에서 별도 주입)
  price_ratio            numeric,                     -- avg_used / new_price_ref (0~1+)
  days_to_sold_median    numeric,                     -- 최근 30일 완료거래 중간 일수
  sold_completed_ratio   numeric,                     -- 완료/전체 비율 (회전율)
  sold_count_30d         int,                         -- 최근 30일 거래 완료 수

  collected_at timestamptz NOT NULL DEFAULT now(),
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,            -- 디버깅용 raw sample

  -- 같은 product+source+query+day 는 하루 1 row 로 제한
  UNIQUE (product_id, source, query, collected_at)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_resale_product_at
  ON jimscanner_trends_resale_signals(product_id, collected_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_resale_source_at
  ON jimscanner_trends_resale_signals(source, collected_at DESC);

ALTER TABLE jimscanner_trends_resale_signals ENABLE ROW LEVEL SECURITY;
-- service-role 만 접근. 정책 정의 안 함.


-- 2) jimscanner_trends_scores 에 retention_factor 컬럼 추가 (게이팅용 0~1)
--    recompute 시 product 의 최신 resale 시그널을 가중합으로 0~1 변환해 곱하기.
--    NULL 또는 1.0 이면 게이팅 없음 (기존 동작 유지).
ALTER TABLE jimscanner_trends_scores
  ADD COLUMN IF NOT EXISTS retention_factor numeric;

-- 양수 + 1 이하 제약 (NULL 허용)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jimscanner_trends_scores_retention_factor_chk'
  ) THEN
    ALTER TABLE jimscanner_trends_scores
      ADD CONSTRAINT jimscanner_trends_scores_retention_factor_chk
      CHECK (retention_factor IS NULL OR (retention_factor >= 0 AND retention_factor <= 1));
  END IF;
END $$;


-- 3) product 별 최신 retention 요약 뷰 (UI 빠른 조회용)
--    핀별 카드 = 가장 최근 collected_at row 의 가중평균.
CREATE OR REPLACE VIEW jimscanner_trends_resale_latest AS
SELECT
  r.product_id,
  -- 각 source 별 최신 row 한 개씩
  jsonb_object_agg(r.source, jsonb_build_object(
    'listings_active', r.listings_active,
    'avg_used_price', r.avg_used_price,
    'new_price_ref', r.new_price_ref,
    'price_ratio', r.price_ratio,
    'days_to_sold_median', r.days_to_sold_median,
    'sold_completed_ratio', r.sold_completed_ratio,
    'sold_count_30d', r.sold_count_30d,
    'collected_at', r.collected_at
  )) AS by_source,
  -- 통합 요약 (3사 평균)
  AVG(r.price_ratio)             AS price_ratio_avg,
  AVG(r.days_to_sold_median)     AS days_to_sold_avg,
  AVG(r.sold_completed_ratio)    AS sold_completed_ratio_avg,
  SUM(r.listings_active)         AS listings_active_total,
  SUM(r.sold_count_30d)          AS sold_count_30d_total,
  MAX(r.collected_at)            AS last_collected_at
FROM (
  SELECT DISTINCT ON (product_id, source) *
  FROM jimscanner_trends_resale_signals
  ORDER BY product_id, source, collected_at DESC
) r
GROUP BY r.product_id;

-- end of migration
