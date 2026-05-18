-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — JTBD 대체재 그래프 (2026-05-18)
-- ─────────────────────────────────────────────────────────────
-- 진입 막힘(규제·MOQ·경쟁포화) 시 동일 needs 공간의 대안 SKU 매칭.
-- 핵심 아이디어:
--   1) 각 product 에 'Job-to-be-Done' 태그 부여 (예: 수면개선, 에너지부스트)
--   2) 같은 JTBD 클러스터 안의 카테고리·브랜드가 다른 대안 SKU 를 그래프로 매칭
--   3) 각 대안 옆에 규제리스크·진입난이도·마진 점수 노출
-- ─────────────────────────────────────────────────────────────

-- 1) products 테이블에 JTBD 태그 컬럼 추가
ALTER TABLE jimscanner_trends_products
  ADD COLUMN IF NOT EXISTS jtbd_tags jsonb,           -- ["수면개선","스트레스완화"]
  ADD COLUMN IF NOT EXISTS jtbd_classified_at timestamptz,
  ADD COLUMN IF NOT EXISTS regulation_risk smallint,  -- 0-10 (10=식약처 허가/직구금지 등 고위험)
  ADD COLUMN IF NOT EXISTS entry_difficulty smallint, -- 0-10 (10=MOQ·총판 락인·경쟁포화)
  ADD COLUMN IF NOT EXISTS margin_score smallint;     -- 0-10 (10=마진 우수)

CREATE INDEX IF NOT EXISTS jimscanner_trends_products_jtbd_tags
  ON jimscanner_trends_products USING gin (jtbd_tags);

CREATE INDEX IF NOT EXISTS jimscanner_trends_products_jtbd_unclassified
  ON jimscanner_trends_products(updated_at DESC)
  WHERE jtbd_classified_at IS NULL;

-- 2) JTBD 매핑 그래프 (product ↔ product, 같은 JTBD 공유)
--    edge_strength = 공유 JTBD 태그 수 / 총 JTBD 태그 수 (0-1)
--    type: 'alternative' (다른 카테고리·브랜드, 같은 JTBD) | 'lookalike' (같은 카테고리)
CREATE TABLE IF NOT EXISTS jimscanner_trends_jtbd_graph (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  target_product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  shared_jtbd_tags jsonb NOT NULL,            -- 공유 JTBD 태그 리스트
  edge_strength numeric NOT NULL,             -- 0-1
  edge_type text NOT NULL DEFAULT 'alternative', -- 'alternative' | 'lookalike'
  computed_at timestamptz NOT NULL DEFAULT now(),

  CHECK (source_product_id <> target_product_id),
  CHECK (edge_strength >= 0 AND edge_strength <= 1),
  UNIQUE (source_product_id, target_product_id)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_jtbd_graph_source
  ON jimscanner_trends_jtbd_graph(source_product_id, edge_strength DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_jtbd_graph_target
  ON jimscanner_trends_jtbd_graph(target_product_id, edge_strength DESC);

ALTER TABLE jimscanner_trends_jtbd_graph ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.

-- 3) 그래프 갱신 RPC: 한 product 의 JTBD 태그가 갱신된 후 호출.
--    동일 JTBD 태그를 공유하는 모든 product 와 edge 를 (재)계산.
CREATE OR REPLACE FUNCTION jimscanner_trends_jtbd_rebuild_edges(p_product_id uuid)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_tags jsonb;
  v_source_category text;
  v_source_brand text;
  v_count int := 0;
BEGIN
  SELECT jtbd_tags, category_top, brand
    INTO v_source_tags, v_source_category, v_source_brand
    FROM jimscanner_trends_products
   WHERE id = p_product_id;

  IF v_source_tags IS NULL OR jsonb_array_length(v_source_tags) = 0 THEN
    -- 기존 edge 만 지우고 종료
    DELETE FROM jimscanner_trends_jtbd_graph WHERE source_product_id = p_product_id;
    RETURN 0;
  END IF;

  -- 기존 edge 삭제 후 재구축
  DELETE FROM jimscanner_trends_jtbd_graph WHERE source_product_id = p_product_id;

  INSERT INTO jimscanner_trends_jtbd_graph
    (source_product_id, target_product_id, shared_jtbd_tags, edge_strength, edge_type)
  SELECT
    p_product_id,
    p.id,
    shared.tags,
    -- shared_count / union_count (Jaccard)
    (jsonb_array_length(shared.tags))::numeric
      / GREATEST(
          jsonb_array_length(v_source_tags)
            + jsonb_array_length(p.jtbd_tags)
            - jsonb_array_length(shared.tags),
          1
        )::numeric,
    CASE
      WHEN p.category_top IS DISTINCT FROM v_source_category
        OR p.brand IS DISTINCT FROM v_source_brand
      THEN 'alternative'
      ELSE 'lookalike'
    END
  FROM jimscanner_trends_products p
  CROSS JOIN LATERAL (
    SELECT COALESCE(jsonb_agg(tag), '[]'::jsonb) AS tags
      FROM (
        SELECT a.value AS tag
          FROM jsonb_array_elements_text(v_source_tags) AS a(value)
         INTERSECT
        SELECT b.value
          FROM jsonb_array_elements_text(p.jtbd_tags) AS b(value)
      ) s
  ) shared
  WHERE p.id <> p_product_id
    AND p.jtbd_tags IS NOT NULL
    AND jsonb_array_length(shared.tags) > 0
  ON CONFLICT (source_product_id, target_product_id) DO UPDATE
    SET shared_jtbd_tags = EXCLUDED.shared_jtbd_tags,
        edge_strength = EXCLUDED.edge_strength,
        edge_type = EXCLUDED.edge_type,
        computed_at = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION jimscanner_trends_jtbd_rebuild_edges(uuid) TO service_role;
