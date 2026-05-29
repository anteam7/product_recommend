-- ────────────────────────────────────────────────────────────
-- 재구매 엔진 점수 — 소진주기 × 수요안정성 정기매출 발굴 (PR-REPEAT-1, 2026-05-29)
-- ────────────────────────────────────────────────────────────
-- 배경: ggsan 카탈로그가 건기식(장·눈·간·혈행건강 등 소모성 소비재) 중심.
--   기존 recommend/opportunity 스코어는 전부 '신규 진입 타이밍·획득' 렌즈.
--   소모성 상품의 본질 가치인 '반복구매 LTV·수요 평활화' 를 측정하는 렌즈가 전무.
--
-- 적재: scripts/ggsan-repeat-engine.mjs (run-crons.mjs 루틴 확장)
--   ① consumption_cycle_days  = 용량/정수(ggsan-extract-package-info) → 소진주기 정규화
--   ② demand_cv               = jimscanner_trends_keywords.volume_relative 시계열의 변동계수(CV)
--   ③ repeat_engine_score     = 재구매빈도(30/주기) × 수요안정성 × 함량당가성비
--
-- UI: /admin/trend-radar/repeat-engine (사분면 x=재구매빈도, y=수요안정성)
--     recommend 보드엔 '정기매출' 배지 컬럼 추가
-- 노출 정책: RLS enable + 정책 정의 X = service-role 만 접근 (기존 패턴 동일)
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_ggsan_repeat (
  goods_no text PRIMARY KEY
    REFERENCES jimscanner_ggsan_products(goods_no) ON DELETE CASCADE,

  -- ① 소진주기
  content_units        numeric,    -- 1통 정/포/캡슐 수 (예: 60정)
  content_per_day      numeric,    -- 1일 섭취량 (예: 2정 → 하루 2)
  consumption_cycle_days numeric,  -- 소진주기(일) = content_units / content_per_day (예: 60/2*1일 = 30일... 보정)
  est_monthly_reorder  numeric,    -- 월 재구매 횟수 = 30 / consumption_cycle_days

  -- ② 수요안정성
  demand_cv            numeric,    -- 수요변동계수 = stddev/mean (volume_relative 시계열) — 낮을수록 안정
  demand_samples       int,        -- CV 산출에 쓰인 시계열 표본 수
  demand_stability     numeric,    -- 0~100 정규화 = 100*(1 - LEAST(demand_cv, 1))
  demand_top_keyword   text,       -- 매칭된 수요 키워드

  -- ③ 함량당 가성비 (#13 재사용 proxy: content_units / price_krw * 1000)
  value_per_content    numeric,

  -- 최종
  repeat_engine_score  numeric,    -- est_monthly_reorder × (demand_stability/100) × value_factor
  components           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- 디버깅·UI breakdown 용

  computed_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_ggsan_repeat_score
  ON jimscanner_ggsan_repeat(repeat_engine_score DESC);
CREATE INDEX IF NOT EXISTS jimscanner_ggsan_repeat_computed
  ON jimscanner_ggsan_repeat(computed_at DESC);

ALTER TABLE jimscanner_ggsan_repeat ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role) 만.
