-- ────────────────────────────────────────────────────────────
-- Brand Safety Filter — 상표권/IP 침해 사전 게이트
-- ────────────────────────────────────────────────────────────
-- 위탁판매 후보 SKU(jimscanner_trends_products, jimscanner_ggsan_products)
-- 의 제목·alias 텍스트를 KIPRIS 등록상표 / 캐릭터 IP / 유명 브랜드 사전과
-- 매칭해 사전 차단(block) · 경고(warn) · 주의(caution) 분류.
--
-- 사후 적발(계정정지·합의금)의 1순위가 캐릭터/상표 IP 침해이므로
-- 발굴→등록 사이 게이트 통과 강제.
-- ────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1) Brand risk terms 사전
CREATE TABLE IF NOT EXISTS jimscanner_trends_brand_risk_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term text NOT NULL,                         -- 매칭 토큰 (예: '짱구', 'POKEMON', '루이비통')
  owner_class text NOT NULL,                  -- 'trademark' | 'character' | 'brand' | 'celebrity'
  risk_level text NOT NULL,                   -- 'block' | 'warn' | 'caution'
  source_url text,                            -- KIPRIS / 라이선스사 URL
  hit_pattern text,                           -- 'token' | 'regex' | 'fuzzy' (기본 token)
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brand_risk_terms_owner_class_chk
    CHECK (owner_class IN ('trademark','character','brand','celebrity')),
  CONSTRAINT brand_risk_terms_risk_level_chk
    CHECK (risk_level IN ('block','warn','caution')),
  CONSTRAINT brand_risk_terms_hit_pattern_chk
    CHECK (hit_pattern IS NULL OR hit_pattern IN ('token','regex','fuzzy'))
);

CREATE UNIQUE INDEX IF NOT EXISTS jimscanner_trends_brand_risk_terms_term_uniq
  ON jimscanner_trends_brand_risk_terms (lower(term), owner_class);
CREATE INDEX IF NOT EXISTS jimscanner_trends_brand_risk_terms_active
  ON jimscanner_trends_brand_risk_terms (risk_level) WHERE is_active;
CREATE INDEX IF NOT EXISTS jimscanner_trends_brand_risk_terms_trgm
  ON jimscanner_trends_brand_risk_terms USING gin (term gin_trgm_ops);

ALTER TABLE jimscanner_trends_brand_risk_terms ENABLE ROW LEVEL SECURITY;

-- 2) Brand risk hits (매칭 결과 적재)
CREATE TABLE IF NOT EXISTS jimscanner_trends_brand_risk_hits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  ggsan_goods_no text,                        -- ggsan 후보의 goods_no (선택)
  term_id uuid NOT NULL REFERENCES jimscanner_trends_brand_risk_terms(id) ON DELETE CASCADE,
  matched_term text NOT NULL,                 -- 실제 매칭된 사전 term
  matched_alias text,                         -- 상품 측에서 매칭된 텍스트 (canonical_name / alias / title)
  matched_field text NOT NULL,                -- 'canonical_name' | 'alias' | 'ggsan_title' | 'ocr'
  match_kind text NOT NULL,                   -- 'token' | 'regex' | 'fuzzy'
  match_score numeric,                        -- fuzzy 일 때 유사도 (0..1)
  owner_class text NOT NULL,
  risk_level text NOT NULL,
  is_whitelisted boolean NOT NULL DEFAULT false,
  whitelisted_by text,
  whitelisted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brand_risk_hits_owner_class_chk
    CHECK (owner_class IN ('trademark','character','brand','celebrity')),
  CONSTRAINT brand_risk_hits_risk_level_chk
    CHECK (risk_level IN ('block','warn','caution')),
  CONSTRAINT brand_risk_hits_target_chk
    CHECK (product_id IS NOT NULL OR ggsan_goods_no IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_brand_risk_hits_product
  ON jimscanner_trends_brand_risk_hits (product_id, risk_level)
  WHERE NOT is_whitelisted;
CREATE INDEX IF NOT EXISTS jimscanner_trends_brand_risk_hits_ggsan
  ON jimscanner_trends_brand_risk_hits (ggsan_goods_no)
  WHERE ggsan_goods_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS jimscanner_trends_brand_risk_hits_created
  ON jimscanner_trends_brand_risk_hits (created_at DESC);

ALTER TABLE jimscanner_trends_brand_risk_hits ENABLE ROW LEVEL SECURITY;

-- 3) RPC — product_id 별 최대 risk 반환 (스코어링 파이프라인에서 게이트로 사용)
--    block > warn > caution > null. 화이트리스트 hit 은 제외.
CREATE OR REPLACE FUNCTION jimscanner_brand_safety_score(p_product_id uuid)
RETURNS TABLE (
  product_id uuid,
  max_risk text,
  hit_count integer,
  block_count integer,
  warn_count integer,
  caution_count integer,
  top_term text,
  top_owner_class text
)
LANGUAGE sql
STABLE
AS $$
  WITH live AS (
    SELECT *
    FROM jimscanner_trends_brand_risk_hits
    WHERE product_id = p_product_id
      AND NOT is_whitelisted
  ),
  ranked AS (
    SELECT
      h.*,
      CASE h.risk_level
        WHEN 'block'   THEN 3
        WHEN 'warn'    THEN 2
        WHEN 'caution' THEN 1
        ELSE 0
      END AS risk_rank
    FROM live h
  ),
  top AS (
    SELECT matched_term, owner_class
    FROM ranked
    ORDER BY risk_rank DESC, created_at DESC
    LIMIT 1
  )
  SELECT
    p_product_id,
    (SELECT risk_level FROM ranked ORDER BY risk_rank DESC LIMIT 1),
    (SELECT COUNT(*)::int FROM live),
    (SELECT COUNT(*)::int FROM live WHERE risk_level = 'block'),
    (SELECT COUNT(*)::int FROM live WHERE risk_level = 'warn'),
    (SELECT COUNT(*)::int FROM live WHERE risk_level = 'caution'),
    (SELECT matched_term FROM top),
    (SELECT owner_class FROM top);
$$;

-- 4) 초기 시드 — 캐릭터 IP / 명품 / 글로벌 브랜드 대표 사례
--    (KIPRIS 전수 적재는 cron 으로 별도 보강. 여기엔 사고 빈도 상위만)
INSERT INTO jimscanner_trends_brand_risk_terms (term, owner_class, risk_level, source_url, hit_pattern, notes)
VALUES
  -- 캐릭터 IP (block)
  ('짱구',          'character', 'block', 'https://www.kipris.or.kr', 'token', '짱구는 못말려 / 신에이동화'),
  ('크레용신짱',     'character', 'block', 'https://www.kipris.or.kr', 'token', '짱구 일본명'),
  ('포켓몬',        'character', 'block', 'https://www.kipris.or.kr', 'token', '포켓몬코리아'),
  ('Pokemon',      'character', 'block', 'https://www.kipris.or.kr', 'token', NULL),
  ('피카츄',        'character', 'block', 'https://www.kipris.or.kr', 'token', NULL),
  ('디즈니',        'character', 'block', 'https://www.kipris.or.kr', 'token', 'The Walt Disney Company'),
  ('Disney',       'character', 'block', 'https://www.kipris.or.kr', 'token', NULL),
  ('미키마우스',     'character', 'block', 'https://www.kipris.or.kr', 'token', NULL),
  ('마블',          'character', 'block', 'https://www.kipris.or.kr', 'token', 'Marvel'),
  ('Marvel',       'character', 'block', 'https://www.kipris.or.kr', 'token', NULL),
  ('카카오프렌즈',   'character', 'block', 'https://www.kipris.or.kr', 'token', NULL),
  ('라이언',        'character', 'warn',  'https://www.kipris.or.kr', 'token', '카카오 라이언 — 동음이의 주의'),
  ('산리오',        'character', 'block', 'https://www.kipris.or.kr', 'token', 'Sanrio'),
  ('헬로키티',      'character', 'block', 'https://www.kipris.or.kr', 'token', NULL),
  ('Hello Kitty',  'character', 'block', 'https://www.kipris.or.kr', 'token', NULL),
  ('짱구는못말려',   'character', 'block', 'https://www.kipris.or.kr', 'token', NULL),
  ('스누피',        'character', 'block', 'https://www.kipris.or.kr', 'token', NULL),
  ('Snoopy',       'character', 'block', 'https://www.kipris.or.kr', 'token', NULL),
  ('티니핑',        'character', 'block', 'https://www.kipris.or.kr', 'token', '캐치티니핑 / SAMG'),
  ('뽀로로',        'character', 'block', 'https://www.kipris.or.kr', 'token', '아이코닉스'),
  ('핑크퐁',        'character', 'block', 'https://www.kipris.or.kr', 'token', '더핑크퐁컴퍼니'),
  ('아기상어',      'character', 'warn',  'https://www.kipris.or.kr', 'token', '핑크퐁 IP'),

  -- 명품 / 글로벌 브랜드 (block)
  ('루이비통',      'brand', 'block', 'https://www.kipris.or.kr', 'token', 'Louis Vuitton'),
  ('Louis Vuitton','brand', 'block', 'https://www.kipris.or.kr', 'token', NULL),
  ('샤넬',          'brand', 'block', 'https://www.kipris.or.kr', 'token', 'Chanel'),
  ('Chanel',       'brand', 'block', 'https://www.kipris.or.kr', 'token', NULL),
  ('구찌',          'brand', 'block', 'https://www.kipris.or.kr', 'token', 'Gucci'),
  ('Gucci',        'brand', 'block', 'https://www.kipris.or.kr', 'token', NULL),
  ('프라다',        'brand', 'block', 'https://www.kipris.or.kr', 'token', 'Prada'),
  ('Prada',        'brand', 'block', 'https://www.kipris.or.kr', 'token', NULL),
  ('에르메스',      'brand', 'block', 'https://www.kipris.or.kr', 'token', 'Hermes'),
  ('Hermes',       'brand', 'block', 'https://www.kipris.or.kr', 'token', NULL),
  ('롤렉스',        'brand', 'block', 'https://www.kipris.or.kr', 'token', 'Rolex'),
  ('Rolex',        'brand', 'block', 'https://www.kipris.or.kr', 'token', NULL),
  ('나이키',        'brand', 'warn',  'https://www.kipris.or.kr', 'token', 'Nike — 정품 병행은 OK'),
  ('Nike',         'brand', 'warn',  'https://www.kipris.or.kr', 'token', NULL),
  ('아디다스',      'brand', 'warn',  'https://www.kipris.or.kr', 'token', 'Adidas'),
  ('Adidas',       'brand', 'warn',  'https://www.kipris.or.kr', 'token', NULL),
  ('애플',          'brand', 'warn',  'https://www.kipris.or.kr', 'token', 'Apple — 호환 액세서리 주의'),
  ('Apple',        'brand', 'caution','https://www.kipris.or.kr','token', 'iPhone 호환'),
  ('아이폰',        'brand', 'caution','https://www.kipris.or.kr','token', NULL),
  ('iPhone',       'brand', 'caution','https://www.kipris.or.kr','token', NULL),
  ('갤럭시',        'brand', 'caution','https://www.kipris.or.kr','token', '삼성 Galaxy'),
  ('Galaxy',       'brand', 'caution','https://www.kipris.or.kr','token', NULL),
  ('삼성',          'brand', 'caution','https://www.kipris.or.kr','token', '호환 액세서리'),
  ('LG',           'brand', 'caution','https://www.kipris.or.kr','token', NULL),

  -- 트레이드마크 / 표현 (block)
  ('AirPods',      'trademark','block','https://www.kipris.or.kr','token', NULL),
  ('에어팟',        'trademark','block','https://www.kipris.or.kr','token', NULL),
  ('Supreme',      'trademark','block','https://www.kipris.or.kr','token', NULL),
  ('슈프림',        'trademark','block','https://www.kipris.or.kr','token', NULL),
  ('YEEZY',        'trademark','block','https://www.kipris.or.kr','token', NULL),
  ('스타벅스',      'trademark','block','https://www.kipris.or.kr','token', 'Starbucks'),
  ('Starbucks',    'trademark','block','https://www.kipris.or.kr','token', NULL),

  -- 셀럽 (caution)
  ('BTS',          'celebrity','block','https://www.kipris.or.kr','token', 'HYBE'),
  ('블랙핑크',      'celebrity','block','https://www.kipris.or.kr','token', 'BLACKPINK'),
  ('BLACKPINK',    'celebrity','block','https://www.kipris.or.kr','token', NULL),
  ('NewJeans',     'celebrity','block','https://www.kipris.or.kr','token', NULL),
  ('뉴진스',        'celebrity','block','https://www.kipris.or.kr','token', NULL)
ON CONFLICT (lower(term), owner_class) DO NOTHING;
