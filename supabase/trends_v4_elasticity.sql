-- ────────────────────────────────────────────────────────────
-- 가격 탄력성 추정 (PR-ELASTICITY-1, 2026-05-17)
-- ────────────────────────────────────────────────────────────
-- 진입가 결정용. log(volume) ~ log(price) + log(competitor) 회귀로
-- 각 product의 가격탄력성 β를 추정. 시계열 패널 = DataLab 검색량 +
-- Smartstore SERP 가격 중위값(누적) + 경쟁사 수.
--
-- 운영 정책:
--   - 30일 이상 데이터를 가진 product 만 회귀.
--   - R² < 0.3 또는 n < 30 은 신뢰도 낮음(어드민 회색).
--   - |β| ≥ 1.5 = 가격민감(저가공세), |β| ≤ 0.5 = 차별화 가능(프리미엄).
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_elasticity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  -- 회귀 결과
  elasticity_coef numeric,         -- β: log-log 회귀 계수 (가격탄력성, 음수가 정상)
  competitor_coef numeric,         -- log(competitor) 계수 (참고용)
  intercept numeric,               -- 회귀 절편
  r_squared numeric,               -- 0~1
  sample_days int NOT NULL,        -- 회귀에 쓰인 row 수

  -- 가격 밴드 (Smartstore SERP 중위값의 분포)
  price_band_p10 numeric,          -- 10퍼센타일
  price_band_p50 numeric,          -- 중위값
  price_band_p90 numeric,          -- 90퍼센타일

  -- 권장 진입가 (β 부호와 R² 신뢰도에 따라 산출)
  optimal_entry_price numeric,
  decision_label text,             -- 'price_sensitive' | 'differentiable' | 'mixed' | 'low_confidence'

  -- 메타
  confidence text NOT NULL DEFAULT 'low'
    CHECK (confidence IN ('low','medium','high')),
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_elasticity_product_at
  ON jimscanner_trends_elasticity(product_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_elasticity_coef
  ON jimscanner_trends_elasticity(elasticity_coef);

CREATE INDEX IF NOT EXISTS jimscanner_trends_elasticity_recent
  ON jimscanner_trends_elasticity(computed_at DESC);

ALTER TABLE jimscanner_trends_elasticity ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role) 전용.
