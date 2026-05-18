-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 시그널 임베딩 맵 (PR-embeddings, 2026-05-18)
-- ─────────────────────────────────────────────────────────────
-- 다차원 시그널 벡터(4점수 + 소스별 언급량 + 가격대 + supplier 다양성 +
-- category 의미임베딩)를 UMAP 으로 2D 좌표로 떨궈서 산점도 + 클러스터링.
-- 산출은 주1회 scripts/recompute-embeddings.py (sentence-transformers + umap-learn).
-- UI 는 src/app/admin/(dashboard)/trend-radar/embedding-map/page.tsx (read-only).
--
-- D5: 운영자 전용 (어드민 한정) · service-role 만 접근
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_embeddings (
  product_id uuid PRIMARY KEY
    REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  -- 현재 좌표
  vec_x double precision NOT NULL,
  vec_y double precision NOT NULL,

  -- 7일 전 좌표 (모멘텀 화살표용). NULL 이면 신규 등장 → trail 미표시.
  vec_prev_x double precision,
  vec_prev_y double precision,

  -- HDBSCAN cluster_id. -1 == noise (라벨 미부여)
  cluster_id int NOT NULL DEFAULT -1,

  -- LLM 1줄 요약 (cluster 단위로 동일 값 — denormalized cache)
  cluster_label text,

  -- 클러스터 모멘텀 점수 = 구성 SKU final_score 7d Δ 평균
  cluster_momentum double precision NOT NULL DEFAULT 0,

  -- 디버그용 — 어떤 시그널이 좌표를 만들었나 (snapshot)
  signal_snapshot jsonb,

  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_embeddings_cluster
  ON jimscanner_trends_embeddings(cluster_id);

CREATE INDEX IF NOT EXISTS jimscanner_trends_embeddings_computed_at
  ON jimscanner_trends_embeddings(computed_at DESC);

ALTER TABLE jimscanner_trends_embeddings ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.

COMMENT ON TABLE jimscanner_trends_embeddings IS
  '트렌드 레이더 v4 — product 별 2D UMAP 좌표 + HDBSCAN cluster + 7일 전 좌표(모멘텀 trail).';
