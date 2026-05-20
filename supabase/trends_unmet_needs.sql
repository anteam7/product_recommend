-- Unmet-Needs 추출 테이블 — 2026-05-20
-- 커뮤니티 게시글에서 LLM 으로 추출한 미충족 수요 시드.
-- jimscanner_trends_raw 의 forum 계열 row (82cook/natepan/ppomppu/dcinside/aliex_best 등)
-- 를 24h 윈도우로 스캔 → '추천해줘/없을까/대안이 있나/짜증나' 패턴을 need 로 정규화.

CREATE TABLE IF NOT EXISTS jimscanner_unmet_needs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,                       -- 원천 source (예: '82cook', 'natepan', 'ppomppu', 'dcinside', 'aliex_best')
  source_post_ref text,                       -- 원본 식별 (url / id / hash)
  raw_excerpt text NOT NULL,                  -- 인용 가능한 원문 일부 (최대 ~400자)
  need_text text NOT NULL,                    -- LLM 이 추출한 정규화된 need 문장 (한국어, 1~2문장)
  need_type text NOT NULL CHECK (need_type IN ('request','complaint','gap')),
  category_guess text,                        -- LLM 추정 카테고리 (health/living/digital/fashion/food/etc)
  intensity numeric NOT NULL DEFAULT 0.5,     -- 0~1 (반복·표현 강도)
  extracted_at timestamptz NOT NULL DEFAULT now(),
  promoted_seed_id uuid REFERENCES jimscanner_trends_seeds(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS jimscanner_unmet_needs_at
  ON jimscanner_unmet_needs(extracted_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_unmet_needs_cat_at
  ON jimscanner_unmet_needs(category_guess, extracted_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_unmet_needs_source_ref
  ON jimscanner_unmet_needs(source, source_post_ref);
CREATE INDEX IF NOT EXISTS jimscanner_unmet_needs_need_text
  ON jimscanner_unmet_needs(need_text);
CREATE INDEX IF NOT EXISTS jimscanner_unmet_needs_pending
  ON jimscanner_unmet_needs(extracted_at DESC)
  WHERE promoted_seed_id IS NULL;

ALTER TABLE jimscanner_unmet_needs ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role) 전용. 정책 없음 → anon/auth 차단.

-- 같은 게시글에서 같은 need 가 중복 추출되지 않도록 보조 unique
CREATE UNIQUE INDEX IF NOT EXISTS jimscanner_unmet_needs_post_need_uniq
  ON jimscanner_unmet_needs(source, source_post_ref, md5(need_text))
  WHERE source_post_ref IS NOT NULL;
