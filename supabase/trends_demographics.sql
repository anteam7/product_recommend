-- 키워드 인구통계 페르소나 락온 보드 — 2026-05-18
-- Naver DataLab Shopping Insight 의 device/ages/gender 분기 파라미터를 활용해
-- 핀+상위 키워드별 인구통계 핑거프린트를 수집·시각화.

CREATE TABLE IF NOT EXISTS jimscanner_trends_demographics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword text NOT NULL,            -- 키워드 (또는 cid 이름)
  cid text,                          -- shopping insight 카테고리 cid (있을 때)
  source text NOT NULL,              -- 'naver_shopping_insight' / 'naver_search_trend'
  age_bucket text,                   -- '10','20','30','40','50','60' / NULL (성별/디바이스 전용 row)
  gender text,                       -- 'm','f' / NULL
  device text,                       -- 'pc','mo' / NULL
  share numeric NOT NULL,            -- 0~100 (DataLab ratio 의 가장 최근 시점)
  collected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_demographics_keyword_at
  ON jimscanner_trends_demographics(keyword, collected_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_demographics_source_at
  ON jimscanner_trends_demographics(source, collected_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_demographics_cid_at
  ON jimscanner_trends_demographics(cid, collected_at DESC);

ALTER TABLE jimscanner_trends_demographics ENABLE ROW LEVEL SECURITY;
-- service-role 만 접근 (어드민 페이지 SSR createAdminClient 사용).
