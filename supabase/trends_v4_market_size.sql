-- ─────────────────────────────────────────────────────────────
-- 예상 월 시장규모(원) 추정 — 상대점수 → 절대 KRW 환산 (PR, 2026-05-31)
-- ─────────────────────────────────────────────────────────────
-- 발굴 신호(trend/commerce/competition_score)는 0~100 무차원이라
-- '얼마나 큰 돈이 걸린 시장인가'를 알 수 없다. 본 테이블은
--   검색량 절대 앵커(#38) × 카테고리 전환율 × 평균 판매가
-- 를 곱해 product 별 '예상 월 거래액(GMV, 원)' 과
-- competition_score 분배 기반 '획득가능 매출(SAM, 원)' 을 보수/기본/낙관
-- 3밴드로 기록한다.
--
-- 적재 주체: recompute_scores 흐름(또는 별도 추정 스텝)이 service-role 로 upsert.
-- UI: /admin/trend-radar/market-size 가 (product_id, MAX(computed_at)) 로 조회.
-- 노출 정책: RLS enable + 정책 미정의 = service-role 만 (기존 trends_* 패턴 동일).
--
-- ⚠️ 현재 UI 는 이 테이블이 없어도 src/lib/trends/market-size.ts 로 on-the-fly
--    계산이 가능하다. 본 테이블은 추정 결과 영속화/시계열 추적용(선택).
-- 관련: src/lib/trends/market-size.ts, supabase/trends_v4_seller_tools.sql
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_market_size (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  -- 입력 앵커 (추적·재현용)
  monthly_searches numeric,                  -- 월간 검색수 절대 앵커 (#38 또는 trend_score 근사)
  search_source text NOT NULL DEFAULT 'estimated', -- 'anchor' | 'estimated'
  avg_price_krw numeric,                      -- 추정 평균 판매가
  price_source text NOT NULL DEFAULT 'none',  -- 'market' | 'wholesale_markup' | 'none'
  estimated_sellers int,                      -- 추정 경쟁 셀러 수
  capture_share numeric,                      -- 0~1, 내 획득 점유율

  -- 출력: 보수/기본/낙관 3밴드 GMV·SAM (원)
  gmv_conservative numeric,
  gmv_base numeric,
  gmv_optimistic numeric,
  sam_conservative numeric,
  sam_base numeric,
  sam_optimistic numeric,

  -- 밴드별 전환율·검색수 등 상세 (디버깅·UI breakdown 용)
  bands jsonb NOT NULL DEFAULT '{}'::jsonb,

  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_market_size_product_at
  ON jimscanner_trends_market_size(product_id, computed_at DESC);

-- 돈 단위 랭킹(보드 KRW 내림차순) 용
CREATE INDEX IF NOT EXISTS jimscanner_trends_market_size_gmv_recent
  ON jimscanner_trends_market_size(gmv_base DESC, computed_at DESC);

ALTER TABLE jimscanner_trends_market_size ENABLE ROW LEVEL SECURITY;
-- service-role 만 접근 (정책 미정의).
