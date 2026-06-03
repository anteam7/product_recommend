-- ────────────────────────────────────────────────────────────
-- PR-MODIFIERS: 속성(수식어) 모멘텀 보드 (2026-06-03)
-- ────────────────────────────────────────────────────────────
-- 트렌드 키워드/alias 를 '상품/테마' 가 아니라 '수식어(속성) 토큰' 단위로
-- 분해해 어떤 스펙이 뜨는지 시계열 추적한다.
--   - 추출원: jimscanner_trends_aliases.alias + jimscanner_trends_products.canonical_name
--   - 추출기: scripts/_extract-modifiers.mjs (룰 + 선택적 LLM)
--   - 적재: 매 재계산마다 새 computed_at 스냅샷 (시계열)
--   - UI: /admin/trend-radar/attributes (모멘텀 막대 + ggsan 변형 드릴다운)
-- 노출 정책: RLS enable + 정책 X = service-role 만 (기존 trends_* 패턴 동일)
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_modifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  modifier text NOT NULL,             -- 정규화된 수식어 토큰 (예: '무선', '접이식', '대용량')
  base_category text,                 -- 'health' | 'living' | 'digital' | NULL (전체)

  occurrence_count int NOT NULL DEFAULT 0,   -- 이번 스냅샷 시점 전체 등장 횟수
  momentum_7d numeric NOT NULL DEFAULT 0,    -- 최근 7일 등장 / 이전 7일 등장 (>1 = 상승)

  sample_product_ids jsonb NOT NULL DEFAULT '[]'::jsonb,  -- 대표 product_id 배열 (드릴다운 시드)

  computed_at timestamptz NOT NULL DEFAULT now()
);

-- 최신 스냅샷 조회 (modifier, base_category, MAX(computed_at))
CREATE INDEX IF NOT EXISTS jimscanner_trends_modifiers_recent
  ON jimscanner_trends_modifiers(computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_modifiers_mod
  ON jimscanner_trends_modifiers(modifier, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_modifiers_cat_momentum
  ON jimscanner_trends_modifiers(base_category, computed_at DESC, momentum_7d DESC);

ALTER TABLE jimscanner_trends_modifiers ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role) 만.


-- ────────────────────────────────────────────────────────────
-- 드릴다운 RPC: 뜨는 속성 토큰 → 해당 속성을 가진 ggsan 변형 SKU
--   jimscanner_ggsan_products.title 에 pg_trgm(gin_trgm 인덱스 존재) 매칭.
--   similarity 가 아니라 ILIKE 부분일치(트라이그램 인덱스 활용) + 유사도 점수 동반.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_trends_modifier_ggsan_match(
  modifier_token text,
  result_limit int DEFAULT 50
)
RETURNS TABLE (
  goods_no text,
  title text,
  cate_cd text,
  cate_label text,
  price_krw integer,
  is_imminent boolean,
  image_url text,
  detail_url text,
  sim numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    g.goods_no,
    g.title,
    g.cate_cd,
    g.cate_label,
    g.price_krw,
    g.is_imminent,
    g.image_url,
    g.detail_url,
    similarity(g.title, modifier_token)::numeric AS sim
  FROM jimscanner_ggsan_products g
  WHERE g.status = 'active'
    AND g.title ILIKE '%' || modifier_token || '%'
  ORDER BY g.is_imminent DESC, similarity(g.title, modifier_token) DESC, g.last_seen_at DESC
  LIMIT result_limit;
$$;
