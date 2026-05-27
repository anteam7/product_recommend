-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 광고비 진입 게이트 (Ad-Margin Burn)
-- ─────────────────────────────────────────────────────────────
-- 목적: 키워드별 광고 비용(CPC × 전환율) 대비 마진 손익분기 판단.
-- 4점수(trend/commerce/supplier/competition)에 빠진 "트래픽 획득비용" 축 보강.
--
-- 데이터 소스:
--   - 네이버 검색광고 API (키워드도구) — monthlyPcQcCnt, monthlyMobileQcCnt, plAvgDepth, compIdx
--   - 쿠팡 광고 추정 CPC (fallback: 검색 결과 광고 비율 기반 휴리스틱)
-- 적재: 로컬 WSL collector(scripts/collect-naver-adcpc.mjs) → service-role insert
-- 노출: /admin/trend-radar/ad-gate (service-role 만)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_keyword_adcost (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  keyword text NOT NULL,                       -- 정규화된 검색 키워드
  product_id uuid REFERENCES jimscanner_trends_products(id) ON DELETE SET NULL,
                                               -- alias 매칭된 canonical product (없으면 NULL)

  -- 검색량 (월간, PC + Mobile 합산을 기본 사용)
  monthly_search_pc int,
  monthly_search_mobile int,
  monthly_search_total int,

  -- 광고 단가 추정 (KRW, 네이버 광고 키워드도구 기준)
  est_cpc_low numeric,                         -- 1p 1회 최소 노출 단가
  est_cpc_high numeric,                        -- 1p 1회 최대 노출 단가
  est_cpc_avg numeric,                         -- 평균 (UI 노출 메인 값)

  -- 경쟁 지표
  competition_index text,                      -- '낮음' | '중간' | '높음' (네이버 compIdx)
  ad_depth numeric,                            -- 평균 광고 노출 슬롯 수 (plAvgDepth)

  -- 메타
  source text NOT NULL DEFAULT 'naver_searchad',  -- 'naver_searchad' | 'coupang_ad' | 'manual'
  raw_payload jsonb,                           -- 원천 응답 (재파싱·디버깅)

  collected_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (keyword, source, collected_at)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_keyword_adcost_keyword
  ON jimscanner_trends_keyword_adcost(keyword, collected_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_keyword_adcost_product
  ON jimscanner_trends_keyword_adcost(product_id, collected_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_keyword_adcost_cpc
  ON jimscanner_trends_keyword_adcost(est_cpc_avg DESC, collected_at DESC);

ALTER TABLE jimscanner_trends_keyword_adcost ENABLE ROW LEVEL SECURITY;
-- service-role 만 접근 (정책 없음)


-- ─────────────────────────────────────────────────────────────
-- 운영자 입력값 (마진율·전환율 기본 가정) — 단일 row
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jimscanner_trends_ad_gate_config (
  id text PRIMARY KEY DEFAULT 'main',
  margin_rate numeric NOT NULL DEFAULT 0.25,       -- 판매가 대비 마진 비율 (0~1)
  conversion_rate numeric NOT NULL DEFAULT 0.025,  -- 평균 전환율 (CVR, 2.5% 기본)
  sale_price_multiplier numeric NOT NULL DEFAULT 2.5,
                                                    -- 도매가 → 판매가 추정 배수 (없으면 supplier × 2.5)
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE jimscanner_trends_ad_gate_config ENABLE ROW LEVEL SECURITY;

INSERT INTO jimscanner_trends_ad_gate_config (id, notes)
VALUES ('main', '기본값 — 마진 25%, 전환율 2.5%, 도매가×2.5 판매가')
ON CONFLICT (id) DO NOTHING;
