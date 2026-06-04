-- 계절성 차감(seasonal decomposition) 보드용 테이블
--
-- DataLab 검색어 트렌드를 timeUnit='month' 로 ~36개월 적재해
-- 키워드별 "이번 달 기대치(seasonal_index)" 를 산출한다.
-- recompute_scores / trend-radar /seasonal 탭이 현재 30일 모멘텀에서
-- 이 기대치를 빼 '잔차(residual surprise)' = 진짜 신규 수요만 남긴다.
--
-- 제습기·모기·선크림처럼 매년 이맘때 오르는 계절 상수는
-- seasonal_index 가 높게(>100) 잡혀 trend_score 자동 상승분을 디스카운트.
--
-- 한 키워드당 12 row (calendar month 1..12). ratio = 해당 월 평균,
-- seasonal_index = month_mean / overall_mean * 100 (100 = 연 평균).

CREATE TABLE IF NOT EXISTS jimscanner_trends_seasonal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- product 매칭 전에도 적재 가능하므로 nullable
  product_id uuid REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  keyword text NOT NULL,

  month smallint NOT NULL CHECK (month >= 1 AND month <= 12),

  -- 해당 calendar month 의 다년 평균 monthly ratio (0~100, DataLab 윈도 기준)
  ratio numeric,
  -- 계절 지수: month_mean / overall_mean * 100 (100 = 연 평균, >100 = 성수기)
  seasonal_index numeric,
  -- 평균에 들어간 표본 연도 수(데이터 신뢰도)
  sample_years smallint NOT NULL DEFAULT 0,

  computed_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (keyword, month)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_seasonal_keyword
  ON jimscanner_trends_seasonal(keyword);

CREATE INDEX IF NOT EXISTS jimscanner_trends_seasonal_product
  ON jimscanner_trends_seasonal(product_id);

ALTER TABLE jimscanner_trends_seasonal ENABLE ROW LEVEL SECURITY;
