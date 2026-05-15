-- ─────────────────────────────────────────────────────────────
-- 트렌드 반감기(T½) 예측 보드 (2026-05-16)
-- ─────────────────────────────────────────────────────────────
-- 후보 상품의 final_score 시계열을 과거 analog(이미 종료된 트렌드)와
-- cosine 유사도로 매칭해, 현재 점수가 절반으로 떨어지기까지 남은 주차(T½)와
-- 80% 신뢰구간을 산출한다.
--
-- scripts/predict-halflife.mjs 가 24시간 주기로 INSERT.
-- UI: src/app/admin/(dashboard)/trend-radar/products/[id]/page.tsx
--     src/app/admin/(dashboard)/trend-radar/recommend/page.tsx
--     src/app/admin/(dashboard)/trend-radar/opportunity/page.tsx
--
-- service-role 만 접근 (RLS enable, 정책 정의 X).
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_halflife_forecasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  -- 예측 결과 (주 단위)
  t_half_weeks numeric,                       -- 반감기 (NULL = 산출 불가)
  ci_low numeric,                             -- 80% 신뢰구간 하한
  ci_high numeric,                            -- 80% 신뢰구간 상한

  -- analog 매칭 메타
  analog_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],   -- 매칭된 종료 트렌드 product_id 리스트
  analog_count int NOT NULL DEFAULT 0,                -- analog 풀 크기
  confidence text NOT NULL DEFAULT 'low'              -- 'high' | 'mid' | 'low'
    CHECK (confidence IN ('high', 'mid', 'low')),

  -- 입력 컨텍스트 (디버깅·UI)
  current_score numeric,                              -- 예측 시점 final_score
  weeks_observed int,                                 -- 관측된 주차 수
  method text NOT NULL DEFAULT 'cosine_analog_v1',    -- 알고리즘 버전

  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_halflife_forecasts_product_at
  ON jimscanner_trends_halflife_forecasts(product_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_halflife_forecasts_recent
  ON jimscanner_trends_halflife_forecasts(computed_at DESC);

ALTER TABLE jimscanner_trends_halflife_forecasts ENABLE ROW LEVEL SECURITY;

-- product_id 별 최신 예측만 조회하는 뷰 (UI 편의용)
CREATE OR REPLACE VIEW jimscanner_trends_halflife_latest AS
SELECT DISTINCT ON (product_id)
  product_id,
  t_half_weeks,
  ci_low,
  ci_high,
  analog_ids,
  analog_count,
  confidence,
  current_score,
  weeks_observed,
  method,
  computed_at
FROM jimscanner_trends_halflife_forecasts
ORDER BY product_id, computed_at DESC;
