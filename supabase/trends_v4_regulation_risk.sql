-- ────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 위탁 진입 규제 리스크 라벨러 (2026-05-15)
-- ────────────────────────────────────────────────────────────
-- KC 안전인증·전파인증·식약처 신고·어린이용품·의약외품·화장품·식품·전기용품
-- 등 한국 통관·판매 규제 리스크를 product 별로 라벨링.
-- 호출: scripts/classify-regulation.mjs (로컬 실행, service-role)
-- ────────────────────────────────────────────────────────────

-- 1) 규제 리스크 라벨 테이블 (product 1:1)
CREATE TABLE IF NOT EXISTS jimscanner_trends_regulation (
  product_id uuid PRIMARY KEY REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  -- 부여된 리스크 태그 (예: ["kc_electronics","battery","children"])
  risk_tags jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- HS 코드 추정 (10자리 한국 HSK; 미상 시 NULL)
  hs_code_guess text,

  -- 핵심 인증/규제 플래그 (UI 단축 표시용)
  kc_required boolean NOT NULL DEFAULT false,           -- KC 안전·전파 인증
  kc_children boolean NOT NULL DEFAULT false,           -- 어린이제품 안전 특별법
  mfds_required boolean NOT NULL DEFAULT false,         -- 식약처 신고 (식품·화장품·의약외품·의료기기)
  food_related boolean NOT NULL DEFAULT false,          -- 식품·건강기능식품
  cosmetic boolean NOT NULL DEFAULT false,              -- 화장품
  electric boolean NOT NULL DEFAULT false,              -- 전기용품
  battery boolean NOT NULL DEFAULT false,               -- 리튬 배터리 (운송 제한)

  -- 0=무관 / 1=경고 / 2=주의 / 3=고위험 (진입 비추천)
  severity smallint NOT NULL DEFAULT 0 CHECK (severity BETWEEN 0 AND 3),

  -- 'rule' (키워드 룰엔진) | 'llm' (Haiku 검수) | 'manual'
  source text NOT NULL DEFAULT 'rule',

  -- 사람이 읽을 한 줄 요약 (예: "KC 전파인증 + 리튬 배터리, 위탁 진입 비추천")
  summary text,

  -- 분류 근거 (rule: 매칭된 키워드 목록 / llm: 추가 코멘트)
  rationale jsonb NOT NULL DEFAULT '{}'::jsonb,

  classified_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_regulation_severity
  ON jimscanner_trends_regulation(severity DESC, classified_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_regulation_updated
  ON jimscanner_trends_regulation(updated_at DESC);

ALTER TABLE jimscanner_trends_regulation ENABLE ROW LEVEL SECURITY;
-- RLS enable + 정책 정의 X = service-role 만 접근 (기존 패턴 유지)

-- updated_at 트리거
CREATE OR REPLACE FUNCTION jimscanner_trends_regulation_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_trends_regulation_updated_at ON jimscanner_trends_regulation;
CREATE TRIGGER jimscanner_trends_regulation_updated_at
  BEFORE UPDATE ON jimscanner_trends_regulation
  FOR EACH ROW EXECUTE FUNCTION jimscanner_trends_regulation_set_updated_at();
