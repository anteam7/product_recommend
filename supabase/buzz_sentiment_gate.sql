-- ─────────────────────────────────────────────────────────────
-- 버즈 감성극성 게이트 — 긍정수요 vs 리콜·논란 부정버즈 분리
-- (트렌드 레이더 v4 확장, 2026-06-04)
-- ─────────────────────────────────────────────────────────────
-- 현재 점수는 '얼마나 많이 뜨는가(volume)'만 보고 '좋게 뜨는가/나쁘게
-- 뜨는가(polarity)'를 구분하지 못한다. 위탁 셀러에게 리콜·부작용·사기
-- 논란으로 버즈가 폭발한 상품을 소싱하는 것은 계정정지·반품지옥 직결.
--
-- classify-trends-llm.mjs 가 각 product 의 evidence(상품명·alias·커뮤니티
-- source)를 감성 극성으로 분해해 아래 컬럼에 적재한다.
--   polarity_score        : -1.0(부정 우세) ~ +1.0(긍정수요 우세)
--   buzz_positive_ratio   :  0.0 ~ 1.0  (긍정 발화 비율)
--   risk_flag             :  null | 'recall' | 'safety' | 'fraud' | 'quality'
--   buzz_sentiment        :  근거 JSON {positive, neutral, negative, evidence[]}
--   buzz_sentiment_at     :  분석 시각
--
-- 적용: psql + PGPASSWORD (docs/database.md). 코드는 적용 후 상태 가정(as any).
-- ─────────────────────────────────────────────────────────────

ALTER TABLE jimscanner_trends_products
  ADD COLUMN IF NOT EXISTS polarity_score numeric
    CHECK (polarity_score IS NULL OR (polarity_score >= -1 AND polarity_score <= 1)),
  ADD COLUMN IF NOT EXISTS buzz_positive_ratio numeric
    CHECK (buzz_positive_ratio IS NULL OR (buzz_positive_ratio >= 0 AND buzz_positive_ratio <= 1)),
  ADD COLUMN IF NOT EXISTS risk_flag text
    CHECK (risk_flag IS NULL OR risk_flag IN ('recall', 'safety', 'fraud', 'quality')),
  ADD COLUMN IF NOT EXISTS buzz_sentiment jsonb,
  ADD COLUMN IF NOT EXISTS buzz_sentiment_at timestamptz;

-- 부정·위험 우세 상품 = 소싱 후보 자동 강등 대상. 보드에서 빠르게 조회.
CREATE INDEX IF NOT EXISTS jimscanner_trends_products_risk
  ON jimscanner_trends_products(risk_flag)
  WHERE risk_flag IS NOT NULL;

CREATE INDEX IF NOT EXISTS jimscanner_trends_products_polarity
  ON jimscanner_trends_products(polarity_score)
  WHERE polarity_score IS NOT NULL;

-- 부정버즈 경보 뷰: risk_flag 가 있거나 polarity 가 음수 우세인 상품.
-- recommend 보드의 '부정버즈 경보' 패널이 읽는다.
CREATE OR REPLACE VIEW jimscanner_trends_buzz_alerts AS
SELECT
  p.id,
  p.canonical_name,
  p.brand,
  p.category_top,
  p.category_mid,
  p.polarity_score,
  p.buzz_positive_ratio,
  p.risk_flag,
  p.buzz_sentiment,
  p.buzz_sentiment_at,
  p.last_seen_at
FROM jimscanner_trends_products p
WHERE p.risk_flag IS NOT NULL
   OR (p.polarity_score IS NOT NULL AND p.polarity_score < -0.2)
ORDER BY
  (p.risk_flag IS NOT NULL) DESC,
  p.polarity_score ASC NULLS LAST;
