-- ────────────────────────────────────────────────────────────
-- Spec-Attribute Whitespace Matrix (2026-05-28)
-- ────────────────────────────────────────────────────────────
-- 카테고리별 SKU 정형 사양(용량·사이즈·색상·재질·핵심기능) 추출 +
-- 키워드 modifier 수요 분포 카운트 → cartesian product 매트릭스에서
-- '수요는 있는데 공급은 없는' 빈 셀(whitespace) 발견.
--
-- 기존 #21 Modifier Demand Vector(1차원) 와 #40 Category-level Mismatch
-- 로는 잡히지 않는 SKU 사양 레벨의 마이크로 갭을 노린다.
-- 예: '600ml 핑크 보온병' 검색은 있는데 공급 SKU 없음 → ggsan base SKU
-- 옵션 추가로 진입 가능.
-- ────────────────────────────────────────────────────────────

-- 1) SKU 정형 사양 (LLM 추출 결과 적재)
-- sku_source = 'ggsan' | 'naver_market' | 'coupang' | ...
CREATE TABLE IF NOT EXISTS jimscanner_sku_spec_attrs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id text NOT NULL,                  -- ggsan goods_no 또는 source 고유 id
  sku_source text NOT NULL DEFAULT 'ggsan',
  category text NOT NULL,                -- 'water_bottle' | 'omega3' | ... (LLM 정규화 카테고리)
  category_top text,                     -- 'living' | 'health' | 'digital'
  attr_dim text NOT NULL,                -- 'volume' | 'size' | 'color' | 'material' | 'feature'
  attr_value text NOT NULL,              -- '600ml' | '핑크' | '스테인리스' | ...
  confidence numeric DEFAULT 1.0,        -- 0~1 LLM extraction confidence
  extracted_by text DEFAULT 'rule',      -- 'rule' | 'llm' | 'manual'
  extracted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_sku_spec_attr UNIQUE (sku_source, sku_id, attr_dim, attr_value)
);

CREATE INDEX IF NOT EXISTS jimscanner_sku_spec_attrs_cat_dim
  ON jimscanner_sku_spec_attrs(category, attr_dim, attr_value);
CREATE INDEX IF NOT EXISTS jimscanner_sku_spec_attrs_sku
  ON jimscanner_sku_spec_attrs(sku_source, sku_id);
CREATE INDEX IF NOT EXISTS jimscanner_sku_spec_attrs_cat_top
  ON jimscanner_sku_spec_attrs(category_top, category);

ALTER TABLE jimscanner_sku_spec_attrs ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role) 전용.


-- 2) 키워드 modifier 수요 분포
-- jimscanner_trends_keywords + jimscanner_market_raw 의 검색 키워드에서
-- '600ml 보온병' '핑크 텀블러' 같은 modifier 토큰을 (category, attr_dim, attr_value)
-- 로 분해해 검색 빈도 카운트.
CREATE TABLE IF NOT EXISTS jimscanner_modifier_demand (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  attr_dim text NOT NULL,
  attr_value text NOT NULL,
  search_freq int NOT NULL DEFAULT 0,    -- 30일 누적 등장 횟수
  source_count int NOT NULL DEFAULT 0,   -- 등장한 unique 소스 수 (다소스 가중치)
  example_keywords text[] DEFAULT '{}',  -- 디버깅용 샘플
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_modifier_demand UNIQUE (category, attr_dim, attr_value)
);

CREATE INDEX IF NOT EXISTS jimscanner_modifier_demand_cat
  ON jimscanner_modifier_demand(category, attr_dim, search_freq DESC);

ALTER TABLE jimscanner_modifier_demand ENABLE ROW LEVEL SECURITY;


-- 3) Whitespace 매트릭스 RPC
-- 입력: p_category (정규화 카테고리, 예: 'water_bottle'), p_top_dims (상위 N개 dim×value 사용)
-- 출력: cartesian product 셀 — (dim_a, val_a, dim_b, val_b, demand_score, supply_count, is_whitespace)
-- is_whitespace = demand_score ≥ p_min_demand AND supply_count ≤ p_max_supply
CREATE OR REPLACE FUNCTION jimscanner_spec_whitespace_matrix(
  p_category text,
  p_dim_a text DEFAULT 'volume',
  p_dim_b text DEFAULT 'color',
  p_top_n int DEFAULT 8,
  p_min_demand int DEFAULT 3,
  p_max_supply int DEFAULT 0
)
RETURNS TABLE(
  dim_a text,
  val_a text,
  dim_b text,
  val_b text,
  demand_a int,
  demand_b int,
  demand_score numeric,
  supply_count int,
  is_whitespace boolean,
  sample_supply_skus text[]
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_dim_a text := p_dim_a;
  v_dim_b text := p_dim_b;
BEGIN
  RETURN QUERY
  WITH top_a AS (
    SELECT attr_value, search_freq
    FROM jimscanner_modifier_demand
    WHERE category = p_category AND attr_dim = v_dim_a
    ORDER BY search_freq DESC
    LIMIT p_top_n
  ),
  top_b AS (
    SELECT attr_value, search_freq
    FROM jimscanner_modifier_demand
    WHERE category = p_category AND attr_dim = v_dim_b
    ORDER BY search_freq DESC
    LIMIT p_top_n
  ),
  grid AS (
    SELECT a.attr_value AS val_a, a.search_freq AS freq_a,
           b.attr_value AS val_b, b.search_freq AS freq_b
    FROM top_a a CROSS JOIN top_b b
  ),
  supply AS (
    SELECT sa.attr_value AS val_a, sb.attr_value AS val_b,
           COUNT(DISTINCT sa.sku_id) AS cnt,
           array_agg(DISTINCT sa.sku_id) FILTER (WHERE sa.sku_id IS NOT NULL) AS skus
    FROM jimscanner_sku_spec_attrs sa
    JOIN jimscanner_sku_spec_attrs sb
      ON sa.sku_id = sb.sku_id AND sa.sku_source = sb.sku_source
    WHERE sa.category = p_category AND sa.attr_dim = v_dim_a
      AND sb.category = p_category AND sb.attr_dim = v_dim_b
    GROUP BY sa.attr_value, sb.attr_value
  )
  SELECT
    v_dim_a,
    g.val_a,
    v_dim_b,
    g.val_b,
    g.freq_a::int AS demand_a,
    g.freq_b::int AS demand_b,
    -- 단순 결합: 두 dim demand 의 기하평균
    (sqrt(GREATEST(g.freq_a, 0)::numeric * GREATEST(g.freq_b, 0)::numeric))::numeric AS demand_score,
    COALESCE(s.cnt, 0)::int AS supply_count,
    (sqrt(GREATEST(g.freq_a, 0)::numeric * GREATEST(g.freq_b, 0)::numeric) >= p_min_demand
       AND COALESCE(s.cnt, 0) <= p_max_supply) AS is_whitespace,
    COALESCE(
      (SELECT array_agg(x) FROM unnest(s.skus) AS x LIMIT 3),
      ARRAY[]::text[]
    ) AS sample_supply_skus
  FROM grid g
  LEFT JOIN supply s ON s.val_a = g.val_a AND s.val_b = g.val_b
  ORDER BY demand_score DESC, supply_count ASC;
END;
$$;

-- 4) 가용 카테고리·dim 목록 헬퍼 RPC
CREATE OR REPLACE FUNCTION jimscanner_spec_whitespace_dims(p_category text)
RETURNS TABLE(attr_dim text, value_count int, total_demand int)
LANGUAGE sql STABLE AS $$
  SELECT attr_dim,
         COUNT(*)::int AS value_count,
         SUM(search_freq)::int AS total_demand
  FROM jimscanner_modifier_demand
  WHERE category = p_category
  GROUP BY attr_dim
  ORDER BY total_demand DESC;
$$;

CREATE OR REPLACE FUNCTION jimscanner_spec_whitespace_categories()
RETURNS TABLE(category text, sku_count int, modifier_count int)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT category, COUNT(DISTINCT sku_id)::int AS cnt
    FROM jimscanner_sku_spec_attrs GROUP BY category
  ),
  m AS (
    SELECT category, COUNT(*)::int AS cnt
    FROM jimscanner_modifier_demand GROUP BY category
  )
  SELECT COALESCE(s.category, m.category) AS category,
         COALESCE(s.cnt, 0) AS sku_count,
         COALESCE(m.cnt, 0) AS modifier_count
  FROM s FULL OUTER JOIN m ON s.category = m.category
  ORDER BY s.cnt DESC NULLS LAST, m.cnt DESC NULLS LAST;
$$;
