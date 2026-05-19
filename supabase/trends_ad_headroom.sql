-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 — Break-Even CPC 광고 진입 가능성 (PR-AdHeadroom)
-- ─────────────────────────────────────────────────────────────
-- 핀 후보 키워드별 시장 CPC / 검색량 / 경쟁 지수를 누적하고,
-- 마진 × 가정 CVR 매트릭스로 산출한 BE-CPC 와 비교해 광고 진입
-- 가능성을 3등급 라벨링하는 ad-headroom 보드용 테이블.
--
-- 데이터 소스: 네이버 검색광고 API — KeyWordsTool (RelKwdStat).
-- 수집: scripts/fetch-naver-ads-stats.mjs 로컬 cron (Hobby 한도 우회).
-- 노출: /admin/trend-radar/ad-headroom (어드민, service-role read-only).
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_keyword_ads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  keyword text NOT NULL,                  -- 정규화된 키워드 (네이버 API 호출 input)
  monthly_pc_qc int,                      -- 월간 PC 검색량 (monthlyPcQcCnt)
  monthly_mobile_qc int,                  -- 월간 모바일 검색량 (monthlyMobileQcCnt)
  monthly_pc_clk numeric,                 -- 월간 PC 클릭수 추정 (monthlyAvePcClkCnt)
  monthly_mobile_clk numeric,             -- 월간 모바일 클릭수 추정 (monthlyAveMobileClkCnt)
  monthly_pc_ctr numeric,                 -- PC CTR (%) (monthlyAvePcCtr)
  monthly_mobile_ctr numeric,             -- Mobile CTR (%) (monthlyAveMobileCtr)
  avg_cpc numeric,                        -- 추정 평균 입찰가 (KRW) — pc/mobile 가중 평균
  pl_avg_depth numeric,                   -- 평균 광고 노출 깊이 (plAvgDepth)
  competition_idx text,                   -- '낮음' | '중간' | '높음' (compIdx)

  raw_payload jsonb,                      -- 원천 응답 (디버깅/재파싱)
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_keyword_ads_keyword_at
  ON jimscanner_trends_keyword_ads(keyword, fetched_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_keyword_ads_fetched
  ON jimscanner_trends_keyword_ads(fetched_at DESC);

ALTER TABLE jimscanner_trends_keyword_ads ENABLE ROW LEVEL SECURITY;
-- service-role 만 접근. 정책 정의 X (기존 trends_* 패턴 동일).
