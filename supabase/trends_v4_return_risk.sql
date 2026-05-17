-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 반품률(Return Rate) 추정 점수 (2026-05-17)
-- ─────────────────────────────────────────────────────────────
-- 진입 매력 4점수(trend/commerce/supplier/competition) 외에
-- 5번째 '운영비용' 차원으로 return_risk_score(0~100)를 추가.
-- 산식: (a) 카테고리 베이스라인 (b) SERP 리뷰 부정 시그널 가중합
-- 관련 문서: docs/trend-radar-v4-execution-plan.md
-- ─────────────────────────────────────────────────────────────


-- 1) 카테고리별 반품률 베이스라인
--    출처: 통계청 온라인쇼핑 반품률 + 업계 leak 데이터 + 셀러 인터뷰 (수동 시드).
--    return_rate_pct 는 카테고리 평균 반품률 추정치 (%).
CREATE TABLE IF NOT EXISTS jimscanner_returns_baseline (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  category_top text NOT NULL,        -- 'health' | 'living' | 'digital' | 'clothes' 등
  category_mid text,                 -- nullable — top 단독 베이스라인 가능

  return_rate_low numeric NOT NULL,  -- 0~100 (%)
  return_rate_high numeric NOT NULL, -- 0~100 (%)
  return_rate_mid numeric NOT NULL,  -- 중앙값 — 점수 계산 입력
  notes text,                        -- 출처/근거 메모

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (category_top, category_mid)
);

ALTER TABLE jimscanner_returns_baseline ENABLE ROW LEVEL SECURITY;

-- 시드: 카테고리 베이스라인 (위탁셀러 도구 기준 추정)
INSERT INTO jimscanner_returns_baseline
  (category_top, category_mid, return_rate_low, return_rate_high, return_rate_mid, notes)
VALUES
  ('clothes',  NULL, 25, 35, 30, '의류 평균 — 사이즈/색상 불일치 비중 큼'),
  ('digital',  NULL,  3,  8,  5, '디지털/가전 — 초기불량 위주 낮은 반품률'),
  ('food',     NULL,  1,  3,  2, '식품 — 신선/위생상 반품 어려움 → 매우 낮음'),
  ('health',   NULL,  2,  5,  3, '건강식품 — 식품과 유사, 단순변심 일부'),
  ('living',   NULL,  8, 15, 11, '리빙/생활용품 — 사이즈/색상 일부 영향'),
  ('beauty',   NULL,  5, 12,  8, '화장품 — 변심/트러블 일부'),
  ('baby',     NULL,  6, 14, 10, '유아용품 — 사이즈 의존'),
  ('pet',      NULL,  4, 10,  7, '반려동물 — 사료 외 용품 사이즈 의존')
ON CONFLICT (category_top, category_mid) DO NOTHING;


-- 2) jimscanner_trends_scores 에 return_risk_score 컬럼 추가
--    0~100. 0=반품 거의 없음(최안전), 100=반품률 매우 높음(최위험).
ALTER TABLE jimscanner_trends_scores
  ADD COLUMN IF NOT EXISTS return_risk_score numeric
    CHECK (return_risk_score IS NULL OR (return_risk_score >= 0 AND return_risk_score <= 100));

-- (score_components jsonb 에 returns 키 추가 — DDL 없음, 코드에서 직접 .returns 로 작성)

-- 정렬 인덱스 — 어드민 필터 (반품위험 낮은 순)
CREATE INDEX IF NOT EXISTS jimscanner_trends_scores_return_risk
  ON jimscanner_trends_scores(return_risk_score);


-- 3) (선택) SERP 리뷰 부정 시그널 누적 테이블
--    같은 product 의 리뷰델타를 일별로 쌓아 두면 시계열 분석 가능.
--    19번 SERP 리뷰델타 파이프라인이 적재함.
CREATE TABLE IF NOT EXISTS jimscanner_trends_review_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  low_star_ratio numeric,            -- 1~2점 비율 (0.0 ~ 1.0)
  total_reviews int,                 -- 표본 수

  -- 부정 키워드 카운트 (불량/하자/사이즈/색상다름/배송파손/환불 등)
  keyword_counts jsonb NOT NULL DEFAULT '{}'::jsonb,

  source text,                       -- 'naver_serp' | 'coupang' | 'mixed'
  collected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_review_signals_product_at
  ON jimscanner_trends_review_signals(product_id, collected_at DESC);

ALTER TABLE jimscanner_trends_review_signals ENABLE ROW LEVEL SECURITY;


-- 4) updated_at 자동 갱신 트리거 (베이스라인)
CREATE OR REPLACE FUNCTION jimscanner_returns_baseline_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_returns_baseline_updated_at
  ON jimscanner_returns_baseline;
CREATE TRIGGER jimscanner_returns_baseline_updated_at
  BEFORE UPDATE ON jimscanner_returns_baseline
  FOR EACH ROW EXECUTE FUNCTION jimscanner_returns_baseline_set_updated_at();
