-- ─────────────────────────────────────────────────────────────
-- 점수 가중치 프로파일 — What-if 랩 (2026-06-01)
-- ─────────────────────────────────────────────────────────────
-- /admin/trend-radar/scoring-lab 에서 사용.
-- 4개 컴포넌트(trend/commerce/supplier/competition) 가중치 프리셋을
-- 위험성향별("경쟁 회피형", "대박 추종형" 등)로 저장·재사용.
-- 노출 정책: RLS enable + 정책 정의 X = service-role(어드민) 만 접근.
--   (기존 jimscanner_trends_* 패턴과 동일)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_score_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  name text NOT NULL,
  -- {"trend": 0.30, "commerce": 0.30, "supplier": 0.20, "competition": 0.20}
  -- 합이 1.0 일 필요는 없음 (UI 에서 정규화).
  weights jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (name)
);

ALTER TABLE jimscanner_trends_score_profiles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION jimscanner_trends_score_profiles_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_trends_score_profiles_updated_at ON jimscanner_trends_score_profiles;
CREATE TRIGGER jimscanner_trends_score_profiles_updated_at
  BEFORE UPDATE ON jimscanner_trends_score_profiles
  FOR EACH ROW EXECUTE FUNCTION jimscanner_trends_score_profiles_set_updated_at();

-- 기본 프리셋 (위험성향별)
INSERT INTO jimscanner_trends_score_profiles (name, weights) VALUES
  ('균형형',       '{"trend":0.25,"commerce":0.25,"supplier":0.25,"competition":0.25}'::jsonb),
  ('경쟁 회피형',  '{"trend":0.20,"commerce":0.20,"supplier":0.20,"competition":0.40}'::jsonb),
  ('대박 추종형',  '{"trend":0.45,"commerce":0.30,"supplier":0.15,"competition":0.10}'::jsonb),
  ('공급 안정 최우선', '{"trend":0.20,"commerce":0.20,"supplier":0.45,"competition":0.15}'::jsonb)
ON CONFLICT (name) DO NOTHING;
