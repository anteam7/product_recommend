-- ────────────────────────────────────────────────────────────
-- 이미지 임베딩 기반 크로스소스 비전 트윈 (2026-05-18)
-- ────────────────────────────────────────────────────────────
-- 목적: 알리·무신사·다나와·지지산은 같은 SKU 라도 텍스트(상품명/옵션) 가
--        달라 trigram 매칭이 끊긴다. 멀티모달 임베딩(768d) 으로 cosine 매칭하여
--        cross-source 동일 상품을 1:1 로 묶는다.
-- 사용처:
--   - /admin/trend-radar/visual-twins  (보드)
--   - jimscanner_ggsan_recommend RPC 에 visual_twin_id JOIN (V1.1)
-- ────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS vector;

-- 1) SKU 이미지 임베딩 (소스별 신상품)
CREATE TABLE IF NOT EXISTS jimscanner_sku_image_embeddings (
  id           bigserial PRIMARY KEY,
  source       text NOT NULL,           -- 'aliex_best' | 'musinsa_best' | 'domeggook_main' | 'ggsan' | 'danawa_main' | ...
  source_sku_id text NOT NULL,          -- ggsan 이면 goods_no, 알리 productId 등 source 내 unique key
  image_url    text NOT NULL,
  embedding    vector(768),             -- 멀티모달 임베딩 (CLIP ViT-L/14 또는 Vertex multimodal 768d)
  embed_model  text,                    -- 'openai-clip-vit-l-14' | 'vertex-multimodal-001' 등 추적용
  captured_at  timestamptz NOT NULL DEFAULT now(),

  -- 비전 트윈 클러스터 매핑 (cluster 단계 후 채워짐)
  cluster_id   bigint,

  -- 부가 컨텍스트(클러스터 보드 표시용, 임베딩 단계서 같이 캡쳐)
  title        text,
  price_krw    integer,
  review_count integer,
  rank_in_src  integer,

  UNIQUE (source, source_sku_id)
);

CREATE INDEX IF NOT EXISTS jimscanner_sku_image_embeddings_source
  ON jimscanner_sku_image_embeddings(source, captured_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_sku_image_embeddings_cluster
  ON jimscanner_sku_image_embeddings(cluster_id) WHERE cluster_id IS NOT NULL;

-- IVFFlat 인덱스: cosine 매칭용. 데이터 수천 row 누적 후 lists 튜닝 권장.
CREATE INDEX IF NOT EXISTS jimscanner_sku_image_embeddings_vec
  ON jimscanner_sku_image_embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

ALTER TABLE jimscanner_sku_image_embeddings ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role) 전용.

-- 2) 비전 트윈 클러스터 (cosine ≥ 0.88 connected component)
CREATE TABLE IF NOT EXISTS jimscanner_visual_twin_clusters (
  cluster_id     bigserial PRIMARY KEY,
  representative_image_url text,             -- 대표 이미지 (보통 ggsan/도매원 우선)
  representative_title text,
  member_count   integer NOT NULL DEFAULT 0,
  source_count   integer NOT NULL DEFAULT 0, -- distinct source 수 (≥2 면 진짜 cross-source twin)
  min_cosine     real,                       -- 클러스터 내 최소 cosine (응집도 지표)
  has_ggsan      boolean NOT NULL DEFAULT false,   -- 도매원(=ggsan) 매칭 존재 여부 — 마진 판단 1차 게이트
  has_aliex      boolean NOT NULL DEFAULT false,
  has_musinsa    boolean NOT NULL DEFAULT false,
  has_danawa     boolean NOT NULL DEFAULT false,
  has_domeggook  boolean NOT NULL DEFAULT false,
  min_price_krw  integer,
  max_price_krw  integer,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_visual_twin_clusters_score
  ON jimscanner_visual_twin_clusters(source_count DESC, member_count DESC);

CREATE INDEX IF NOT EXISTS jimscanner_visual_twin_clusters_has_ggsan
  ON jimscanner_visual_twin_clusters(updated_at DESC) WHERE has_ggsan;

ALTER TABLE jimscanner_visual_twin_clusters ENABLE ROW LEVEL SECURITY;

-- FK: embedding.cluster_id → clusters.cluster_id (없을 수도 있으니 ON DELETE SET NULL)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'jimscanner_sku_image_embeddings_cluster_fk'
  ) THEN
    ALTER TABLE jimscanner_sku_image_embeddings
      ADD CONSTRAINT jimscanner_sku_image_embeddings_cluster_fk
      FOREIGN KEY (cluster_id) REFERENCES jimscanner_visual_twin_clusters(cluster_id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- 3) 클러스터 → ggsan goods_no 빠른 lookup 뷰 (recommend 페이지 배지용)
CREATE OR REPLACE VIEW jimscanner_ggsan_visual_twin AS
SELECT
  e.source_sku_id AS goods_no,
  e.cluster_id,
  c.source_count,
  c.member_count,
  c.has_aliex,
  c.has_musinsa,
  c.has_danawa,
  c.has_domeggook,
  c.min_price_krw,
  c.max_price_krw
FROM jimscanner_sku_image_embeddings e
JOIN jimscanner_visual_twin_clusters c ON c.cluster_id = e.cluster_id
WHERE e.source = 'ggsan';

-- 권한
REVOKE ALL ON jimscanner_sku_image_embeddings FROM PUBLIC;
REVOKE ALL ON jimscanner_visual_twin_clusters FROM PUBLIC;
GRANT ALL ON jimscanner_sku_image_embeddings TO service_role;
GRANT ALL ON jimscanner_visual_twin_clusters TO service_role;
GRANT SELECT ON jimscanner_ggsan_visual_twin TO service_role;
