-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 재구매 주기·LTV 추정 보드 (PR, 2026-05-20)
-- ─────────────────────────────────────────────────────────────
-- 카테고리·브랜드별 평균 재구매 주기(Repurchase Cadence)와 LTV proxy 를 저장.
-- 데이터 소스 3개를 결합:
--   1) jimscanner_trends_keywords 의 같은 키워드 자기상관(ACF) → 검색 재등장 주기
--   2) jimscanner_forwarder_reviews 텍스트의 재구매 토픽 빈도
--   3) 카테고리별 외부 벤치마크 seed (영양제 30d, 화장품 45d, 생활용품 60d, 의류 90d 등)
--
-- 일 1회 recompute_cadence cron 이 이 테이블을 새로 채움.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_repurchase_cadence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 분류 키 (최소 category_top 필수, 나머지는 NULL 가능 → 집계 레벨 구분)
  category_top text NOT NULL,         -- 'health' | 'beauty' | 'living' | 'apparel' | 'digital' ...
  category_mid text,                  -- 'supplements' | 'skincare' | 'storage' 등
  brand text,                         -- NULL = 카테고리 평균, 값있음 = 브랜드 cohort

  -- 재구매 주기 (일)
  cadence_days_p25 numeric,           -- 25 퍼센타일 (빠른 재구매층)
  cadence_days_p50 numeric NOT NULL,  -- 중앙값
  cadence_days_p75 numeric,           -- 75 퍼센타일 (느린 재구매층)

  -- LTV proxy (원). 단가 × 12개월 / cadence_days × 60% retention
  ltv_proxy_krw numeric,

  -- 신뢰도
  sample_size int NOT NULL DEFAULT 0,
  confidence_score numeric,           -- 0~1 (sample_size, evidence 다양성, ACF 강도 기반)

  -- 근거 (다 한 곳에)
  --   {
  --     "acf_signal": { "keyword": "멜라토닌", "lag_days": [28,30,32], "strength": 0.62 },
  --     "review_signal": { "n_reviews": 12, "n_repurchase_mentions": 4, "phrases": ["또 샀어요", "재주문"] },
  --     "benchmark": { "source": "seed", "days": 30, "rationale": "영양제 카테고리 평균" }
  --   }
  evidence_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,

  computed_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (category_top, category_mid, brand)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_repurchase_cadence_top
  ON jimscanner_trends_repurchase_cadence(category_top);

CREATE INDEX IF NOT EXISTS jimscanner_trends_repurchase_cadence_brand
  ON jimscanner_trends_repurchase_cadence(brand)
  WHERE brand IS NOT NULL;

CREATE INDEX IF NOT EXISTS jimscanner_trends_repurchase_cadence_recent
  ON jimscanner_trends_repurchase_cadence(computed_at DESC);

ALTER TABLE jimscanner_trends_repurchase_cadence ENABLE ROW LEVEL SECURITY;
-- service-role 전용 (정책 정의 X). 기존 jimscanner_trends_* 패턴 그대로.

-- ─────────────────────────────────────────────────────────────
-- Seed: 카테고리별 외부 벤치마크 (cadence_days_p50 only)
-- 코드에서 recompute 시 사용하므로 여기서는 참고용 INSERT 만 둠.
-- 이미 있으면 ON CONFLICT 로 skip.
-- ─────────────────────────────────────────────────────────────
INSERT INTO jimscanner_trends_repurchase_cadence
  (category_top, category_mid, brand, cadence_days_p25, cadence_days_p50, cadence_days_p75,
   sample_size, confidence_score, evidence_jsonb, computed_at)
VALUES
  ('health',   'supplements', NULL, 21, 30, 45,  0, 0.30,
    jsonb_build_object('benchmark', jsonb_build_object('source','seed','days',30,'rationale','영양제 카테고리 평균')), now()),
  ('beauty',   'skincare',    NULL, 30, 45, 60,  0, 0.30,
    jsonb_build_object('benchmark', jsonb_build_object('source','seed','days',45,'rationale','스킨케어 평균')), now()),
  ('beauty',   'cosmetics',   NULL, 45, 60, 90,  0, 0.30,
    jsonb_build_object('benchmark', jsonb_build_object('source','seed','days',60,'rationale','색조 평균')), now()),
  ('living',   'consumable',  NULL, 30, 60, 90,  0, 0.30,
    jsonb_build_object('benchmark', jsonb_build_object('source','seed','days',60,'rationale','생활용품 소모재 평균')), now()),
  ('apparel',  NULL,          NULL, 60, 90, 180, 0, 0.25,
    jsonb_build_object('benchmark', jsonb_build_object('source','seed','days',90,'rationale','의류 단발 모델')), now()),
  ('digital',  NULL,          NULL, 180, 365, 730, 0, 0.20,
    jsonb_build_object('benchmark', jsonb_build_object('source','seed','days',365,'rationale','가전 단발 모델')), now()),
  ('pet',      'food',        NULL, 21, 30, 45,  0, 0.30,
    jsonb_build_object('benchmark', jsonb_build_object('source','seed','days',30,'rationale','반려 사료 평균')), now()),
  ('health',   'sleep',       NULL, 25, 30, 45,  0, 0.30,
    jsonb_build_object('benchmark', jsonb_build_object('source','seed','days',30,'rationale','수면·멜라토닌 평균')), now())
ON CONFLICT (category_top, category_mid, brand) DO NOTHING;
