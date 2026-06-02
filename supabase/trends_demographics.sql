-- 인구통계 수요 프로파일 — 2026-06-03
-- Naver DataLab 의 연령·성별 세그먼트 분해를 신규 1차 데이터 축으로 추가.
-- 기존 jimscanner_trends_keywords 는 단일 ratio 만 평탄화 저장 → '누가 사는가' 유실.
-- 아래 두 jsonb 컬럼에 세그먼트별 ratio 벡터를 적재한다.
--
--   demo_age    : {"10대":12.3, "20대":40.1, "30대":..., "40대":..., "50대":..., "60대+":...}
--   demo_gender : {"m":33.2, "f":66.8}
--
-- source 는 별도 'naver_demographics' 값으로 구분해 기존 ratio 수집과 섞이지 않게 한다.

ALTER TABLE jimscanner_trends_keywords
  ADD COLUMN IF NOT EXISTS demo_age jsonb,
  ADD COLUMN IF NOT EXISTS demo_gender jsonb;

-- 데모 벡터가 있는 최신 row 만 빠르게 조회.
CREATE INDEX IF NOT EXISTS jimscanner_trends_keywords_demo
  ON jimscanner_trends_keywords(keyword, collected_at DESC)
  WHERE demo_age IS NOT NULL;
