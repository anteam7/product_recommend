-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 핀 포트폴리오 자기잠식 진단 (2026-05-17)
-- ─────────────────────────────────────────────────────────────
-- 운영자가 jimscanner_trends_pins 에 등록한 키워드/상품 페어들이
-- 같은 수요·검색의도·카테고리 슬롯을 두고 잠식하는지 자동 진단.
--
-- 결합 신호:
--   1) 임베딩 코사인 유사도 (canonical_name + description + alias)
--   2) 검색의도(intent_label) 일치 여부
--   3) (category_top, category_mid) 일치도
--   4) 동일 ggsan 공급원 공유 여부
--
-- cannibalization_score ∈ [0,1] = 가중합. 0.6 이상은 위험 페어.
-- ─────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS vector;

-- 1) 상품 임베딩 컬럼 (384차원 = bge-small / minilm 기준; 모델 변경 시 차원 조정 필요)
ALTER TABLE jimscanner_trends_products
  ADD COLUMN IF NOT EXISTS embedding vector(384),
  ADD COLUMN IF NOT EXISTS embedding_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS embedding_model text;

-- 임베딩 인덱스 (IVF Flat — 핀 개수 적을 때는 seq scan 도 무리 없으나 미래 대비)
CREATE INDEX IF NOT EXISTS jimscanner_trends_products_embedding_ivfflat
  ON jimscanner_trends_products
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);

-- 2) 잠식 점수 시계열 (페어별 매 재계산 시 새 row)
CREATE TABLE IF NOT EXISTS jimscanner_pin_cannibalization_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- (a_product_id < b_product_id) 정렬 보장으로 페어 중복 제거
  product_a uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  product_b uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  embedding_sim numeric NOT NULL CHECK (embedding_sim >= 0 AND embedding_sim <= 1),
  intent_match numeric NOT NULL CHECK (intent_match >= 0 AND intent_match <= 1),
  category_match numeric NOT NULL CHECK (category_match >= 0 AND category_match <= 1),
  supplier_overlap numeric NOT NULL CHECK (supplier_overlap >= 0 AND supplier_overlap <= 1),

  cannibalization_score numeric NOT NULL CHECK (cannibalization_score >= 0 AND cannibalization_score <= 1),

  computed_at timestamptz NOT NULL DEFAULT now(),

  CHECK (product_a < product_b)
);

CREATE INDEX IF NOT EXISTS jimscanner_pin_cannibalization_history_pair_at
  ON jimscanner_pin_cannibalization_history(product_a, product_b, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_pin_cannibalization_history_recent
  ON jimscanner_pin_cannibalization_history(computed_at DESC, cannibalization_score DESC);

ALTER TABLE jimscanner_pin_cannibalization_history ENABLE ROW LEVEL SECURITY;


-- 3) pin → product 해석 뷰
--    현재 jimscanner_trends_pins 는 (keyword, source) 기반.
--    alias 테이블을 통해 product_id 로 해석.
--    여러 product 매칭 시 confidence 최대만 채택.
CREATE OR REPLACE VIEW jimscanner_pin_products_v AS
SELECT DISTINCT ON (p.keyword, p.source)
  p.keyword,
  p.source,
  p.pinned_at,
  p.notes,
  a.product_id,
  pr.canonical_name,
  pr.category_top,
  pr.category_mid,
  pr.intent_label,
  pr.embedding
FROM jimscanner_trends_pins p
LEFT JOIN jimscanner_trends_aliases a ON lower(a.alias) = lower(p.keyword)
LEFT JOIN jimscanner_trends_products pr ON pr.id = a.product_id
ORDER BY p.keyword, p.source, a.confidence DESC NULLS LAST;


-- 4) 핀된 product 쌍의 최신 잠식 점수 뷰
--    UI 에서 바로 SELECT 해서 force-directed 그래프 + 위험 카드 렌더.
CREATE OR REPLACE VIEW jimscanner_pin_cannibalization_pairs AS
WITH pinned_products AS (
  SELECT DISTINCT product_id
  FROM jimscanner_pin_products_v
  WHERE product_id IS NOT NULL
),
latest_pair AS (
  SELECT DISTINCT ON (product_a, product_b)
    product_a,
    product_b,
    embedding_sim,
    intent_match,
    category_match,
    supplier_overlap,
    cannibalization_score,
    computed_at
  FROM jimscanner_pin_cannibalization_history
  ORDER BY product_a, product_b, computed_at DESC
)
SELECT
  lp.product_a,
  lp.product_b,
  pa.canonical_name AS name_a,
  pb.canonical_name AS name_b,
  pa.category_top   AS category_top_a,
  pb.category_top   AS category_top_b,
  pa.category_mid   AS category_mid_a,
  pb.category_mid   AS category_mid_b,
  pa.intent_label   AS intent_a,
  pb.intent_label   AS intent_b,
  lp.embedding_sim,
  lp.intent_match,
  lp.category_match,
  lp.supplier_overlap,
  lp.cannibalization_score,
  lp.computed_at
FROM latest_pair lp
JOIN pinned_products ppa ON ppa.product_id = lp.product_a
JOIN pinned_products ppb ON ppb.product_id = lp.product_b
JOIN jimscanner_trends_products pa ON pa.id = lp.product_a
JOIN jimscanner_trends_products pb ON pb.id = lp.product_b
ORDER BY lp.cannibalization_score DESC;


-- 5) 페어별 잠식 지수 계산 RPC
--    cron / 어드민 수동 trigger 에서 호출.
--    핀된 모든 product 쌍에 대해 (embedding cosine, intent, category, supplier) 결합 → history 적재.
--
-- 가중치:
--   embedding_sim       0.45   (의미적 중복 핵심 신호)
--   intent_match        0.25   (검색 의도 동일)
--   category_match      0.15   (top match 0.5 + mid match 0.5)
--   supplier_overlap    0.15   (동일 ggsan supplier_product_id 공유)
CREATE OR REPLACE FUNCTION jimscanner_pin_cannibalization_recompute()
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  inserted int := 0;
BEGIN
  WITH pinned AS (
    SELECT DISTINCT pr.id, pr.canonical_name, pr.category_top, pr.category_mid,
           pr.intent_label, pr.embedding
    FROM jimscanner_pin_products_v v
    JOIN jimscanner_trends_products pr ON pr.id = v.product_id
    WHERE v.product_id IS NOT NULL
  ),
  pairs AS (
    SELECT
      LEAST(a.id, b.id)    AS product_a,
      GREATEST(a.id, b.id) AS product_b,
      CASE
        WHEN a.embedding IS NULL OR b.embedding IS NULL THEN 0
        ELSE GREATEST(0, 1 - (a.embedding <=> b.embedding))
      END AS embedding_sim,
      CASE
        WHEN a.intent_label IS NOT NULL
         AND b.intent_label IS NOT NULL
         AND a.intent_label = b.intent_label THEN 1
        ELSE 0
      END AS intent_match,
      (
        (CASE WHEN a.category_top = b.category_top THEN 0.5 ELSE 0 END) +
        (CASE
           WHEN a.category_mid IS NOT NULL
            AND b.category_mid IS NOT NULL
            AND a.category_mid = b.category_mid THEN 0.5
           ELSE 0
         END)
      ) AS category_match,
      COALESCE((
        SELECT LEAST(1.0,
                     COUNT(*)::numeric /
                     GREATEST(1,
                       (SELECT COUNT(*) FROM jimscanner_trends_supplier sa
                          WHERE sa.product_id = a.id AND sa.supplier_source = 'ggsan')
                       +
                       (SELECT COUNT(*) FROM jimscanner_trends_supplier sb
                          WHERE sb.product_id = b.id AND sb.supplier_source = 'ggsan')
                       -
                       COUNT(*)
                     )::numeric)
        FROM jimscanner_trends_supplier sa
        JOIN jimscanner_trends_supplier sb
          ON sa.supplier_source = sb.supplier_source
         AND sa.supplier_product_id IS NOT NULL
         AND sa.supplier_product_id = sb.supplier_product_id
        WHERE sa.product_id = a.id
          AND sb.product_id = b.id
          AND sa.supplier_source = 'ggsan'
      ), 0) AS supplier_overlap
    FROM pinned a
    JOIN pinned b ON a.id <> b.id AND a.id < b.id
  )
  INSERT INTO jimscanner_pin_cannibalization_history (
    product_a, product_b,
    embedding_sim, intent_match, category_match, supplier_overlap,
    cannibalization_score
  )
  SELECT
    product_a,
    product_b,
    embedding_sim,
    intent_match,
    category_match,
    supplier_overlap,
    LEAST(1.0,
      0.45 * embedding_sim
    + 0.25 * intent_match
    + 0.15 * category_match
    + 0.15 * supplier_overlap
    )
  FROM pairs;

  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END;
$$;
