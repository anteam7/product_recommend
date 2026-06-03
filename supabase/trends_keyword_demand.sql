-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 — 네이버 검색광고 키워드도구 연동 (절대 검색량 + CPC 앵커)
-- 2026-06-03
-- ─────────────────────────────────────────────────────────────
-- 목적: DataLab 의 0~100 상대비율(volume_relative) 한계 보정.
--   검색광고 'keywordstool' API 로 키워드별 ① 월간 절대 검색량(PC/모바일 분리),
--   ② 경쟁정도(낮음/중간/높음), ③ 월평균 노출 광고수, ④ 예상 입찰가(CPC) 수집.
-- 노출 정책: RLS enable + 정책 정의 X = service-role 만 접근 (기존 trends_* 패턴 동일).
-- 인증 env: NAVER_SEARCHAD_API_KEY / NAVER_SEARCHAD_SECRET_KEY / NAVER_SEARCHAD_CUSTOMER_ID
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_keyword_demand (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  keyword text NOT NULL,            -- 정규화된 조회 키워드 (공백 제거 대문자, 검색광고 응답 relKeyword)
  hint_keyword text,                -- 조회에 사용한 원본 시드/alias 키워드

  monthly_pc int,                   -- 월간 PC 검색수 (절대값, '< 10' 은 5 로 환산)
  monthly_mobile int,               -- 월간 모바일 검색수 (절대값)
  monthly_total int,                -- monthly_pc + monthly_mobile (denormalized)

  comp_idx text,                    -- '낮음' | '중간' | '높음'
  ad_depth numeric,                 -- 월평균 노출 광고수 (plAvgDepth)
  est_cpc numeric,                  -- 예상 입찰가(CPC, 원) — bid estimate, best-effort nullable

  raw_payload jsonb,                -- keywordstool 원천 row (재파싱·디버깅)
  collected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_keyword_demand_kw_at
  ON jimscanner_trends_keyword_demand(keyword, collected_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_keyword_demand_total
  ON jimscanner_trends_keyword_demand(monthly_total DESC, collected_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_keyword_demand_at
  ON jimscanner_trends_keyword_demand(collected_at DESC);

ALTER TABLE jimscanner_trends_keyword_demand ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.
