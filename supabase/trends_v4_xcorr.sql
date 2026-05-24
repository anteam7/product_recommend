-- ────────────────────────────────────────────────────────────
-- 키워드 리드-래그 인과 그래프 — Cross-Correlation Edges
-- ────────────────────────────────────────────────────────────
-- 매 야간 cron 에서 jimscanner_trends_keywords 의 90일치 시계열
-- (keyword × source × category_top, daily mean(volume_relative))에 대해
-- lag 0~21 일 구간의 표준화 교차상관(Pearson)을 계산한 뒤
-- 통계적으로 유의(>0.55) + 표본 충분(>30) 한 edge 만 적재.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_xcorr_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  src text NOT NULL,                 -- 리딩 키워드 (선행)
  dst text NOT NULL,                 -- 래깅 키워드 (후행)
  src_category text,                 -- src 의 category_top (쇼핑/엔터/푸드…)
  dst_category text,
  lag_days int NOT NULL,             -- src(t) ↔ dst(t+lag) 의 lag (양수)
  corr numeric NOT NULL,             -- 표준화 상관계수 -1~1
  p_value numeric,                   -- 양측 t-test 근사
  sample_n int NOT NULL,             -- 표본 일수
  src_last_at timestamptz,           -- src 최근 활성 시각 (지난 30일 필터용)
  dst_last_at timestamptz,
  window_start date NOT NULL,        -- 계산에 사용된 윈도 시작 (90일 윈도)
  window_end date NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_xcorr_edges_recent
  ON jimscanner_trends_xcorr_edges(computed_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_xcorr_edges_src
  ON jimscanner_trends_xcorr_edges(src, computed_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_xcorr_edges_dst
  ON jimscanner_trends_xcorr_edges(dst, computed_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_xcorr_edges_corr
  ON jimscanner_trends_xcorr_edges(corr DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_xcorr_edges_lag
  ON jimscanner_trends_xcorr_edges(lag_days);

-- 동일 src→dst 페어는 최신 run 만 보존하고 싶을 때 사용 (선택 — cron 에서 DELETE 후 INSERT)
-- 매 run 마다 전량 재계산이므로 cron 코드에서 동일 윈도 기존 row 를 DELETE.

ALTER TABLE jimscanner_trends_xcorr_edges ENABLE ROW LEVEL SECURITY;
-- service_role 만.

-- ────────────────────────────────────────────────────────────
-- cron run 감사 로그용 source 라벨: 'compute_keyword_xcorr'
-- jimscanner_trends_runs 에 그대로 적재.
-- ────────────────────────────────────────────────────────────
