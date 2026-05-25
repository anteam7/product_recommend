-- 트렌드 인구·디바이스 페르소나 매핑 — 2026-05-25
-- Naver DataLab age/gender/device 파라미터로 키워드별 페르소나 매트릭스 수집.
--
-- 한 키워드를 (age × gender × device) 셀별로 분리 호출하면 호출 수가 폭주하므로,
-- 셀별로 한 번 호출하면서 그 안에 키워드 그룹을 묶어서 ratio 를 추출한다.
-- ratio 는 그룹 내 정규화 값(0~100) — 같은 키워드의 셀간 절대 비교는 불가.
-- 따라서 키워드별로 셀 ratio 의 sum 으로 다시 정규화한 `ratio_normalized` 도 함께 저장.

CREATE TABLE IF NOT EXISTS jimscanner_trends_demographics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword text NOT NULL,
  age text NOT NULL,                   -- '1' (~12), '2' (13-18), '3' (19-24), '4' (25-29), '5' (30-39), '6' (40-49), '7' (50-59), '8' (60+)
                                       -- 본 구현은 운영자가 자유 enum 으로 사용 — 보통 '20s'/'30s' 등 라벨 부착.
  gender text NOT NULL,                -- 'm' / 'f' / '' (all)
  device text NOT NULL,                -- 'pc' / 'mo' / '' (all)
  ratio_raw numeric,                   -- DataLab 응답의 last 시점 ratio (0~100; 셀 호출 내부 정규화)
  ratio_normalized numeric,            -- 키워드 단위로 셀 ratio 합=1 로 다시 정규화 — 페르소나 비율로 해석 가능
  collected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_demographics_keyword_at
  ON jimscanner_trends_demographics(keyword, collected_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_demographics_axis
  ON jimscanner_trends_demographics(keyword, age, gender, device, collected_at DESC);

ALTER TABLE jimscanner_trends_demographics ENABLE ROW LEVEL SECURITY;
-- service-role only — 어드민 페이지에서만 조회.

-- 최신 페르소나 셀 뷰: keyword 별 가장 최신 1회 수집분만.
CREATE OR REPLACE VIEW jimscanner_trends_demographics_latest AS
WITH latest AS (
  SELECT keyword, MAX(collected_at) AS collected_at
  FROM jimscanner_trends_demographics
  GROUP BY keyword
)
SELECT d.*
FROM jimscanner_trends_demographics d
JOIN latest l USING (keyword, collected_at);
