-- 연간 시즌 선점 캘린더 — 비수기 역(逆)소싱 보드 — 2026-05-31
-- 기존 트렌드 수집은 30일 롤링 윈도우라 '지금 뜨는 것'만 보임.
-- 이 테이블은 Naver DataLab 을 trailing 13개월·timeUnit='month' 로 별도 조회해
-- 시드 키워드별 '연중 검색곡선의 위상(언제 사두면 피크에 맞는가)' 을 적재.
--
-- collect-naver-seasonal cron 이 매주 1회 갱신 (DataLab 은 2016~ 월별 시계열 지원 → 즉시 백필).
-- 어드민 /admin/trend-radar/seasonal 에서 월×키워드 히트맵 캘린더로 렌더링.

CREATE TABLE IF NOT EXISTS jimscanner_trends_seasonality (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seed_id uuid,                         -- jimscanner_trends_seeds.id (FK 느슨)
  source text NOT NULL,                 -- 'naver_search_trend' / 'naver_shopping_insight'
  keyword text NOT NULL,                -- 그룹/카테고리 표시명
  peak_month int,                       -- 연간 피크 월 (1~12)
  peak_week int,                        -- 연간 피크 주차 (1~52, peak_month 중순 기준)
  trough_month int,                     -- 연간 비수기(트로프) 월 (1~12)
  amplitude numeric,                    -- 진폭 = peak_ratio / max(trough_ratio, 1)  (계절성 강도)
  current_ratio numeric,                -- 현재(최근 월) ratio 0~100
  current_phase numeric,                -- 현재 곡선상 위치 0~1 ((cur-min)/(max-min))
  weeks_to_peak int,                    -- 현재 주차 → peak_week 까지 남은 주 (연중 wrap)
  monthly_curve jsonb,                  -- [{month:1, ratio:..}, ...] 12개 (히트맵용)
  last_computed timestamptz NOT NULL DEFAULT now()
);

-- 키워드별 1행 유지 (재계산 시 upsert) — source+keyword 유니크
CREATE UNIQUE INDEX IF NOT EXISTS jimscanner_trends_seasonality_uq
  ON jimscanner_trends_seasonality(source, keyword);
CREATE INDEX IF NOT EXISTS jimscanner_trends_seasonality_amp
  ON jimscanner_trends_seasonality(amplitude DESC);

ALTER TABLE jimscanner_trends_seasonality ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.
