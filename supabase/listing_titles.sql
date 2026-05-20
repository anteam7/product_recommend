-- ─────────────────────────────────────────────────────────────
-- 리스팅 제목 옵티마이저 (2026-05-20)
-- ─────────────────────────────────────────────────────────────
-- 발굴된 핀(jimscanner_trends_products) → Naver 스마트스토어/쿠팡 출고로
-- 이어지는 마찰점인 '50자 SEO 제목 작성'을 자동화.
--
-- 입력:
--   (a) canonical_name + aliases (jimscanner_trends_aliases)
--   (b) 최근 30일 검색 트렌드 (jimscanner_trends_keywords)
--   (c) classified_intent='transactional' 키워드 우선
--   (d) 컴플라이언스 게이트 blocked_terms (간단 시드)
--
-- 출력:
--   jimscanner_listing_title_candidates 에 4~6개 후보 row 적재
--   운영자가 '선택' 시 jimscanner_listing_title_pinned 에 저장
-- ─────────────────────────────────────────────────────────────

-- 1) 후보 제목 (LLM 생성 결과, 매 생성마다 새 batch_id 로 row 추가)
CREATE TABLE IF NOT EXISTS jimscanner_listing_title_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  batch_id uuid NOT NULL,                      -- 같은 generate 호출에서 나온 후보 묶음
  title text NOT NULL,                         -- 50자 이내 SEO 제목
  score numeric NOT NULL DEFAULT 0,            -- 0~100 (LLM 자체 평가 or 가중 합)
  covered_keywords text[] NOT NULL DEFAULT '{}',
  covered_volume numeric NOT NULL DEFAULT 0,   -- 커버 키워드 volume_relative 합
  char_len int NOT NULL,                       -- 실제 문자수 (검증용)
  blocked_terms text[] NOT NULL DEFAULT '{}',  -- 위반된 금지어 (비어 있으면 통과)
  notes text,                                  -- LLM 의 짧은 근거 메모

  llm_model text,
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_listing_title_candidates_product
  ON jimscanner_listing_title_candidates(product_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_listing_title_candidates_batch
  ON jimscanner_listing_title_candidates(batch_id);

ALTER TABLE jimscanner_listing_title_candidates ENABLE ROW LEVEL SECURITY;
-- service-role only.

-- 2) 운영자가 선택한 최종 제목 (product 1건당 0~1 row)
CREATE TABLE IF NOT EXISTS jimscanner_listing_title_pinned (
  product_id uuid PRIMARY KEY REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  candidate_id uuid REFERENCES jimscanner_listing_title_candidates(id) ON DELETE SET NULL,
  title text NOT NULL,
  char_len int NOT NULL,
  covered_keywords text[] NOT NULL DEFAULT '{}',
  pinned_by text,                              -- admin email
  pinned_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_listing_title_pinned_at
  ON jimscanner_listing_title_pinned(pinned_at DESC);

ALTER TABLE jimscanner_listing_title_pinned ENABLE ROW LEVEL SECURITY;

-- 3) 금지어 시드 (컴플라이언스 게이트 #19 의 단순 버전)
--   광고법·표시광고법 위반 가능성이 있는 표현 / 의약품 어휘 / 과장 표현.
CREATE TABLE IF NOT EXISTS jimscanner_listing_blocked_terms (
  term text PRIMARY KEY,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE jimscanner_listing_blocked_terms ENABLE ROW LEVEL SECURITY;

INSERT INTO jimscanner_listing_blocked_terms (term, reason) VALUES
  ('최고', '최상급 표현 (표시광고법)'),
  ('최저가', '최상급 표현 (표시광고법)'),
  ('1위', '근거 없는 순위 표현'),
  ('완치', '의약품 효능 (식약처 기준)'),
  ('치료', '의약품 효능 (식약처 기준)'),
  ('100%', '절대 표현'),
  ('국내유일', '근거 없는 독점 표현'),
  ('정품보장', '플랫폼 약관 위반 가능')
ON CONFLICT (term) DO NOTHING;
