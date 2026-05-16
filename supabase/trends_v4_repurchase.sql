-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 재구매 주기(Autocorrelation) 분석 (2026-05-16)
-- ─────────────────────────────────────────────────────────────
-- 목적: naver_search_trend / naver_shopping_insight 시계열에 ACF/FFT 적용해
--   소모품(주·월 단위 반복) 후보를 사전 선별. 일회성 트렌드와 분리.
--
-- 데이터 흐름:
--   1) scripts/compute-repurchase-cycle.mjs 가 매일 새벽 jimscanner_trends_keywords
--      에서 product_id 별 시계열을 끌어와 ACF 계산
--   2) 결과를 jimscanner_trends_repurchase_metrics 에 upsert
--   3) jimscanner_trends_products 에 repurchase_cycle_days · ltv_score 컬럼 채움
--   4) jimscanner_trends_repurchase 뷰가 위 두 테이블을 join 해 UI에 노출
--
-- D5/D7 정책: 기존 trends_* 와 동일 — RLS enable, service-role 만 접근
-- ─────────────────────────────────────────────────────────────


-- 1) 재구매 메트릭 (product 단위, 매일 1 row upsert)
CREATE TABLE IF NOT EXISTS jimscanner_trends_repurchase_metrics (
  product_id uuid PRIMARY KEY REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  -- 추정 재구매 주기 (일수). NULL 이면 신뢰할 만한 peak 없음 (=일회성/노이즈)
  cycle_days int,

  -- ACF peak 정규화값 (0~1). 1에 가까울수록 강한 반복성
  acf_peak numeric,

  -- 신뢰도 (0~1). peak 의 SNR · 시계열 길이 · 결측치 비율 등 종합
  confidence numeric,

  -- 재구매성 지수 (0~100). UI 정렬용 — acf_peak × confidence × log(volume) 정규화
  repurchase_index numeric,

  -- LTV 점수 (0~100). cycle_days 짧을수록 + acf_peak 강할수록 + volume 클수록
  ltv_score numeric,

  -- 상위 3개 ACF peak (디버깅·시각화용). [{lag: 7, value: 0.62}, ...]
  acf_peaks jsonb,

  -- 분석에 쓴 시계열 메타
  series_length int,
  series_start  date,
  series_end    date,
  avg_volume    numeric,

  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_repurchase_metrics_cycle
  ON jimscanner_trends_repurchase_metrics(cycle_days, repurchase_index DESC)
  WHERE cycle_days IS NOT NULL;

CREATE INDEX IF NOT EXISTS jimscanner_trends_repurchase_metrics_ltv
  ON jimscanner_trends_repurchase_metrics(ltv_score DESC NULLS LAST);

ALTER TABLE jimscanner_trends_repurchase_metrics ENABLE ROW LEVEL SECURITY;


-- 2) jimscanner_trends_products 에 cache 컬럼 (UI · recommend 배지용)
ALTER TABLE jimscanner_trends_products
  ADD COLUMN IF NOT EXISTS repurchase_cycle_days int,
  ADD COLUMN IF NOT EXISTS ltv_score numeric;


-- 3) UI 노출용 join 뷰
CREATE OR REPLACE VIEW jimscanner_trends_repurchase AS
SELECT
  p.id                          AS product_id,
  p.canonical_name              AS title,
  p.category_top,
  p.category_mid,
  p.brand,
  p.intent_label,
  m.cycle_days,
  m.acf_peak,
  m.confidence,
  m.repurchase_index,
  m.ltv_score,
  m.acf_peaks,
  m.series_length,
  m.avg_volume,
  m.computed_at
FROM jimscanner_trends_products p
JOIN jimscanner_trends_repurchase_metrics m ON m.product_id = p.id;

-- 뷰는 RLS 상속 — base 테이블 RLS 가 효력 발휘.

-- ─────────────────────────────────────────────────────────────
-- 운영 메모:
--   - scripts/compute-repurchase-cycle.mjs 가 ACF / cycle 산출
--   - cron: 매일 04:00 KST (run-crons 에 추가 예정)
--   - 컬럼 추가 후 `npm run gen:types` 로 generated types 갱신
-- ─────────────────────────────────────────────────────────────
