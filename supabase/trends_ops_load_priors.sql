-- ─────────────────────────────────────────────────────────────
-- 위탁 운영부하 게이트 — 카테고리 prior 테이블 (2026-06-01)
-- ─────────────────────────────────────────────────────────────
-- 판매 후 '인적 운영부하'(반품·교환·CS 문의) prior 를 category_mid 단위로 관리.
-- jimscanner_trends_seeds 와 같은 운영자 관리 테이블 패턴.
--
-- 의류 사이즈/신발/이너웨어 = 반품률↑
-- 전자 액세서리/케이블 = 호환성 문의↑
-- 조립·설치형 = 사용법 문의↑
--
-- enrich 스크립트(scripts/enrich-ops-load.mjs)가 이 prior + 커뮤니티 raw
-- 텍스트 신호를 합성해 jimscanner_trends_scores.score_components.ops_load 에 기록.
-- 노출 정책: RLS enable + 정책 X = service-role 전용 (기존 trends_* 패턴).
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trends_ops_load_priors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  category_mid text NOT NULL,                 -- 'oms' 정규화 category_mid (예: '의류', '케이블', '조립가구')
  return_rate_prior numeric NOT NULL DEFAULT 0.08
    CHECK (return_rate_prior >= 0 AND return_rate_prior <= 1),  -- 반품/교환률 prior (0~1)
  inquiry_rate_prior numeric NOT NULL DEFAULT 0.08
    CHECK (inquiry_rate_prior >= 0 AND inquiry_rate_prior <= 1),-- CS 문의률 prior (0~1)

  note text,                                  -- 사람이 읽는 근거
  source text NOT NULL DEFAULT 'manual',      -- 'manual' | 'market_obs' | 'llm'
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (category_mid)
);

CREATE INDEX IF NOT EXISTS trends_ops_load_priors_category
  ON trends_ops_load_priors(category_mid);

ALTER TABLE trends_ops_load_priors ENABLE ROW LEVEL SECURITY;
-- 정책 미정의 = service-role 전용 (어드민 read-only).

CREATE OR REPLACE FUNCTION trends_ops_load_priors_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trends_ops_load_priors_updated_at ON trends_ops_load_priors;
CREATE TRIGGER trends_ops_load_priors_updated_at
  BEFORE UPDATE ON trends_ops_load_priors
  FOR EACH ROW EXECUTE FUNCTION trends_ops_load_priors_set_updated_at();

-- ── 초기 prior 시드 (시장 관찰 기반, 운영하며 보정) ──────────────
INSERT INTO trends_ops_load_priors (category_mid, return_rate_prior, inquiry_rate_prior, note, source) VALUES
  ('의류',      0.35, 0.15, '사이즈/핏 불일치 반품 다발', 'market_obs'),
  ('이너웨어',  0.30, 0.12, '사이즈·위생 반품, 교환 까다로움', 'market_obs'),
  ('신발',      0.40, 0.15, '사이즈 반품률 최상위', 'market_obs'),
  ('케이블',    0.12, 0.45, '기기 호환성 문의 폭주', 'market_obs'),
  ('충전기',    0.12, 0.40, '호환·출력 문의 다발', 'market_obs'),
  ('액세서리',  0.15, 0.35, '호환/규격 문의', 'market_obs'),
  ('조립가구',  0.15, 0.40, '조립·설치 사용법 문의', 'market_obs'),
  ('설치형',    0.15, 0.42, '설치 난이도 문의', 'market_obs'),
  ('전자기기',  0.12, 0.30, '초기불량·사용법 문의', 'market_obs'),
  ('건강식품',  0.04, 0.07, '소모품, 반품·문의 적음', 'market_obs'),
  ('영양제',    0.04, 0.07, '소모품, 운영부하 낮음', 'market_obs'),
  ('식품',      0.05, 0.06, '소모품, 운영부하 낮음', 'market_obs')
ON CONFLICT (category_mid) DO NOTHING;
