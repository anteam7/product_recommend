-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 쿠팡 SERP 실측 스냅샷 (competition_score 접지)
-- ─────────────────────────────────────────────────────────────
-- docs/trend-radar-v4-execution-plan.md §5.4 의 competition_score 는
--   low_competition       = 쿠팡 검색결과 수의 역수
--   low_review_saturation = 쿠팡 평균 리뷰 수의 역수
-- 로 설계됐으나, 그 실측 SERP 값을 적재하는 테이블이 없어 휴리스틱/스텁으로 돌고 있었음.
-- 이 마이그레이션은 실측 시계열 1개 테이블 + competition 파생 뷰를 추가한다.
--
-- 수집기: scripts/collect-coupang-serp.mjs (run-crons.mjs --serp 단계)
-- 노출 정책: RLS enable + 정책 정의 X = service-role 만 접근 (기존 trends_* 패턴 동일)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_serp (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  keyword text NOT NULL,                 -- 실측에 사용한 검색 키워드 (alias / canonical)

  listing_count   int,                   -- SERP 상품 카드 수 (검색결과 밀도)
  price_min       numeric,               -- 실가격대 최저
  price_p25       numeric,               -- 1사분위
  price_median    numeric,               -- 중앙값
  price_p75       numeric,               -- 3사분위
  price_max       numeric,               -- 최고
  top_review_sum  bigint,                -- 상위 카드 리뷰 수 합 (리뷰 포화 proxy)
  avg_review      numeric,               -- 카드당 평균 리뷰 수
  rocket_share    numeric,               -- 로켓배송 카드 비율 0~1
  ad_slot_share   numeric,               -- 광고 슬롯 비율 0~1

  raw_payload jsonb,                     -- 원천 파싱 결과 (재파싱·디버깅용)
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_serp_product_at
  ON jimscanner_trends_serp(product_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_serp_keyword_at
  ON jimscanner_trends_serp(keyword, captured_at DESC);

ALTER TABLE jimscanner_trends_serp ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.


-- competition 파생 뷰: product 별 최신 SERP 스냅샷 → low_competition / low_review_saturation.
-- §5.4 공식:
--   low_competition       = 100 - log(listing_count) / log(10000) * 100
--   low_review_saturation = 100 - log(avg_review)    / log(1000)  * 100
-- recompute_scores 가 이 뷰를 읽어 실측값으로 competition_score 를 접지한다.
CREATE OR REPLACE VIEW jimscanner_trends_serp_latest AS
SELECT DISTINCT ON (s.product_id)
  s.product_id,
  s.keyword,
  s.listing_count,
  s.price_min,
  s.price_p25,
  s.price_median,
  s.price_p75,
  s.price_max,
  s.top_review_sum,
  s.avg_review,
  s.rocket_share,
  s.ad_slot_share,
  s.captured_at,
  GREATEST(0, LEAST(100,
    100 - (ln(GREATEST(s.listing_count, 1))::numeric / ln(10000) * 100)
  )) AS low_competition,
  GREATEST(0, LEAST(100,
    100 - (ln(GREATEST(s.avg_review, 1))::numeric / ln(1000) * 100)
  )) AS low_review_saturation
FROM jimscanner_trends_serp s
WHERE s.product_id IS NOT NULL
ORDER BY s.product_id, s.captured_at DESC;
