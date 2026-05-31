-- trends_v5_chainlink_index.sql
-- ============================================================================
-- DataLab 재정규화 체인링크 보정 — 연속 수요지수(continuous demand index)
-- ----------------------------------------------------------------------------
-- 문제: 네이버 DataLab 은 "요청 윈도의 최댓값 = 100" 으로 매 호출 재정규화한
--       ratio 만 반환한다. 매일 30일치를 끌어와 jimscanner_trends_keywords.
--       volume_relative 에 적재한 시계열을 단순 이어 붙이면, 새 스파이크가
--       윈도에 들어오는 순간 과거 값이 일제히 축소(rebase)되어 시계열이
--       비정상(non-stationary)이 되고 velocity(trend_score) 가 왜곡된다.
--
-- 해법: 매일 호출이 직전 호출과 29일 겹치는 점을 이용해 CPI 식 체인링킹을
--       적용한다. 겹침 구간의 평균비로 스케일 팩터를 구해 새 구간만 splice 해
--       연속 지수(continuous index)를 만든다. velocity 는 이 보정 지수로 재계산.
--
-- 관련: supabase/trends.sql, supabase/trends_v4_seller_tools.sql
--       src/scoring/recompute.ts (체인링크 엔진 + 재계산 오케스트레이션)
-- ============================================================================

CREATE TABLE IF NOT EXISTS jimscanner_trends_keyword_index (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 체인링크는 키워드(그룹 title) 단위로 수행. 상품과는 alias 로 연결.
  keyword      text NOT NULL,
  source       text NOT NULL,
  -- 보정된 연속 수요지수 시계열: [{ "date": "YYYY-MM-DD", "index": 73.4 }, ...]
  indexed_series jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 원본(윈도 재정규화) 시계열 — 보정 효과 시각화/감사용:
  -- [{ "date": "YYYY-MM-DD", "ratio": 100 }, ...]
  raw_series   jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 보정 지수 기반 velocity (0~100) — trend_score 의 1순위 신호.
  velocity     numeric NOT NULL DEFAULT 0 CHECK (velocity >= 0 AND velocity <= 100),
  -- 체인링킹 메타: { "windows": 7, "spliced_points": 6, "max_link_factor": 1.8, ... }
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at  timestamptz NOT NULL DEFAULT now()
);

-- 키워드+소스별 최신 지수 조회
CREATE INDEX IF NOT EXISTS jimscanner_trends_keyword_index_kw_at
  ON jimscanner_trends_keyword_index(keyword, source, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_keyword_index_velocity
  ON jimscanner_trends_keyword_index(velocity DESC, computed_at DESC);

ALTER TABLE jimscanner_trends_keyword_index ENABLE ROW LEVEL SECURITY;

-- 기존 trends 테이블과 동일한 service-role 전용 정책 패턴
DROP POLICY IF EXISTS jimscanner_trends_keyword_index_service ON jimscanner_trends_keyword_index;
CREATE POLICY jimscanner_trends_keyword_index_service
  ON jimscanner_trends_keyword_index
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
