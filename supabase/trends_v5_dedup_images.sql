-- ────────────────────────────────────────────────────────────
-- PR-5: 이미지 임베딩 기반 canonical product 자동 dedup (2026-05-20)
-- ────────────────────────────────────────────────────────────
-- 배경: jimscanner_trends_aliases 매핑은 텍스트 동일/유사도 기반이라
--   표현이 다른 같은 상품이 별개 product_id 로 분리된다
--   (예: 'USB-C 65W 충전기' vs '65w 고속충전기 type c').
-- 해법: SERP 썸네일을 CLIP/SigLIP 으로 임베딩하고 cosine 유사도로
--   중복 product 쌍을 추출해서 운영자가 한 클릭에 머지.
-- ────────────────────────────────────────────────────────────

-- pgvector 확장 (이미 있을 수 있음)
CREATE EXTENSION IF NOT EXISTS vector;

-- 1) 상품 이미지 + 임베딩
--    한 product 에 여러 image row 가능 (Naver SERP 상위 N개 등).
CREATE TABLE IF NOT EXISTS jimscanner_trends_product_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  image_url text NOT NULL,
  source text NOT NULL,                 -- 'naver_shopping_serp' | 'naver_related' | 'coupang' | 'manual'
  embedding vector(512),                -- CLIP/SigLIP 512-dim. NULL = 미임베딩
  embedding_model text,                 -- 'clip-vit-b-32' | 'siglip-so400m' 등

  created_at timestamptz NOT NULL DEFAULT now(),
  embedded_at timestamptz,

  UNIQUE (product_id, image_url)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_product_images_product
  ON jimscanner_trends_product_images(product_id);

-- 미임베딩 row 우선 처리용
CREATE INDEX IF NOT EXISTS jimscanner_trends_product_images_pending
  ON jimscanner_trends_product_images(created_at)
  WHERE embedding IS NULL;

-- ivfflat cosine 인덱스 (벡터 100개 미만이면 빌드 의미 없음 — 데이터 쌓인 후 REINDEX)
CREATE INDEX IF NOT EXISTS jimscanner_trends_product_images_embedding_ivfflat
  ON jimscanner_trends_product_images
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);

ALTER TABLE jimscanner_trends_product_images ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.


-- 2) dedup 후보 RPC
--    cosine ≥ min_sim 인 (product_a, product_b) 쌍을 반환.
--    product_a.id < product_b.id 로 정규화해서 중복 제거.
--    카테고리 일치 여부와 final_score 차이를 같이 반환해서
--    UI 에서 "다른 카테고리인데 시각적 같음"·"점수 비슷한 쌍 우선" 정렬 가능.
CREATE OR REPLACE FUNCTION jimscanner_dedup_candidates(
  min_sim numeric DEFAULT 0.85,
  result_limit int DEFAULT 50
)
RETURNS TABLE (
  product_a_id uuid,
  product_b_id uuid,
  product_a_name text,
  product_b_name text,
  product_a_category text,
  product_b_category text,
  product_a_image text,
  product_b_image text,
  product_a_score numeric,
  product_b_score numeric,
  product_a_alias_count int,
  product_b_alias_count int,
  max_similarity numeric,
  same_category boolean,
  score_diff numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH latest_scores AS (
    -- product 별 가장 최근 final_score
    SELECT DISTINCT ON (product_id)
      product_id, final_score
    FROM jimscanner_trends_scores
    ORDER BY product_id, computed_at DESC
  ),
  representative_image AS (
    -- product 별 대표 이미지 (가장 오래된 1장)
    SELECT DISTINCT ON (product_id)
      product_id, image_url
    FROM jimscanner_trends_product_images
    WHERE embedding IS NOT NULL
    ORDER BY product_id, created_at ASC
  ),
  pair_sim AS (
    -- 모든 image-쌍의 cosine sim. product_id 가 다른 쌍만, a < b 로 정규화.
    SELECT
      LEAST(a.product_id, b.product_id) AS pa,
      GREATEST(a.product_id, b.product_id) AS pb,
      MAX(1 - (a.embedding <=> b.embedding))::numeric AS max_sim
    FROM jimscanner_trends_product_images a
    JOIN jimscanner_trends_product_images b
      ON a.product_id < b.product_id
     AND a.embedding IS NOT NULL
     AND b.embedding IS NOT NULL
     AND (1 - (a.embedding <=> b.embedding)) >= min_sim
    GROUP BY 1, 2
  )
  SELECT
    pa AS product_a_id,
    pb AS product_b_id,
    pa_prod.canonical_name AS product_a_name,
    pb_prod.canonical_name AS product_b_name,
    pa_prod.category_top AS product_a_category,
    pb_prod.category_top AS product_b_category,
    pa_img.image_url AS product_a_image,
    pb_img.image_url AS product_b_image,
    COALESCE(pa_score.final_score, 0)::numeric AS product_a_score,
    COALESCE(pb_score.final_score, 0)::numeric AS product_b_score,
    pa_prod.alias_count AS product_a_alias_count,
    pb_prod.alias_count AS product_b_alias_count,
    pair_sim.max_sim AS max_similarity,
    (pa_prod.category_top = pb_prod.category_top) AS same_category,
    ABS(COALESCE(pa_score.final_score, 0) - COALESCE(pb_score.final_score, 0))::numeric AS score_diff
  FROM pair_sim
  JOIN jimscanner_trends_products pa_prod ON pa_prod.id = pa
  JOIN jimscanner_trends_products pb_prod ON pb_prod.id = pb
  LEFT JOIN representative_image pa_img ON pa_img.product_id = pa
  LEFT JOIN representative_image pb_img ON pb_img.product_id = pb
  LEFT JOIN latest_scores pa_score ON pa_score.product_id = pa
  LEFT JOIN latest_scores pb_score ON pb_score.product_id = pb
  ORDER BY pair_sim.max_sim DESC, score_diff ASC
  LIMIT result_limit
$$;


-- 3) 머지 RPC
--    source(흡수당하는 쪽) 의 모든 alias / image / score / supplier 를
--    target 으로 이관하고 source product row 를 삭제.
--    score 재계산은 다음 cron 의 recompute 가 처리하도록 트리거만 남김.
CREATE OR REPLACE FUNCTION jimscanner_merge_products(
  target_id uuid,
  source_id uuid,
  actor text DEFAULT 'manual'
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  moved_aliases int := 0;
  moved_images int := 0;
  moved_scores int := 0;
  moved_supplier int := 0;
  source_name text;
  target_name text;
BEGIN
  IF target_id = source_id THEN
    RAISE EXCEPTION 'target_id and source_id must differ';
  END IF;

  SELECT canonical_name INTO target_name FROM jimscanner_trends_products WHERE id = target_id;
  SELECT canonical_name INTO source_name FROM jimscanner_trends_products WHERE id = source_id;
  IF target_name IS NULL OR source_name IS NULL THEN
    RAISE EXCEPTION 'product not found (target=% source=%)', target_id, source_id;
  END IF;

  -- alias: UNIQUE(alias, alias_type) 충돌 시 source 쪽 alias 는 그냥 drop (이미 target 에 동일)
  WITH moved AS (
    UPDATE jimscanner_trends_aliases a
    SET product_id = target_id
    WHERE a.product_id = source_id
      AND NOT EXISTS (
        SELECT 1 FROM jimscanner_trends_aliases b
        WHERE b.product_id = target_id
          AND b.alias = a.alias
          AND b.alias_type = a.alias_type
      )
    RETURNING 1
  )
  SELECT count(*) INTO moved_aliases FROM moved;

  -- 못 옮긴 (중복) source alias 제거
  DELETE FROM jimscanner_trends_aliases WHERE product_id = source_id;

  -- images: UNIQUE(product_id, image_url) 충돌 무시
  WITH moved AS (
    UPDATE jimscanner_trends_product_images i
    SET product_id = target_id
    WHERE i.product_id = source_id
      AND NOT EXISTS (
        SELECT 1 FROM jimscanner_trends_product_images j
        WHERE j.product_id = target_id AND j.image_url = i.image_url
      )
    RETURNING 1
  )
  SELECT count(*) INTO moved_images FROM moved;
  DELETE FROM jimscanner_trends_product_images WHERE product_id = source_id;

  -- scores: 시계열이므로 그대로 target 으로 이관 (history 보존)
  UPDATE jimscanner_trends_scores SET product_id = target_id WHERE product_id = source_id;
  GET DIAGNOSTICS moved_scores = ROW_COUNT;

  -- supplier rows (있으면)
  BEGIN
    UPDATE jimscanner_trends_supplier SET product_id = target_id WHERE product_id = source_id;
    GET DIAGNOSTICS moved_supplier = ROW_COUNT;
  EXCEPTION WHEN undefined_table THEN
    moved_supplier := 0;
  END;

  -- target 의 alias_count / last_seen_at 갱신
  UPDATE jimscanner_trends_products t
  SET
    alias_count = (SELECT count(*) FROM jimscanner_trends_aliases WHERE product_id = t.id),
    last_seen_at = GREATEST(t.last_seen_at, now())
  WHERE t.id = target_id;

  -- source 삭제 (CASCADE 가 남은 row 도 정리)
  DELETE FROM jimscanner_trends_products WHERE id = source_id;

  -- 감사 로그
  INSERT INTO jimscanner_admin_actions (actor, action, target_type, target_id, summary, metadata)
  VALUES (
    actor,
    'merge_trend_product',
    'jimscanner_trends_products',
    target_id::text,
    format('머지: "%s" ← "%s" (alias %s, image %s, score %s)',
      target_name, source_name, moved_aliases, moved_images, moved_scores),
    jsonb_build_object(
      'target_id', target_id,
      'source_id', source_id,
      'source_name', source_name,
      'moved_aliases', moved_aliases,
      'moved_images', moved_images,
      'moved_scores', moved_scores,
      'moved_supplier', moved_supplier
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'target_id', target_id,
    'source_id', source_id,
    'moved_aliases', moved_aliases,
    'moved_images', moved_images,
    'moved_scores', moved_scores,
    'moved_supplier', moved_supplier
  );
END
$$;
