-- ─────────────────────────────────────────────────────────────
-- 신개념 광맥 발굴 — 미분류·'기타' 잔여 신호 군집 (2026-06-02)
-- ─────────────────────────────────────────────────────────────
-- classify-trends-llm 이 기존 canonical 에 못 붙인 잔여물
-- (llm_classified_at IS NULL + category_top='other') 을 alias 텍스트
-- 코사인으로 묶고, 기존 canonical_name 집합과 근접매칭해
-- '어디에도 안 붙는' 클러스터(=택소노미 화이트스페이스)만 남긴다.
--
-- 적재: scripts/cluster-unclassified.mjs (로컬 cron)
-- UI:   /admin/trend-radar/emerging (read-only + 승격/기각 액션)
-- RLS:  enable + 정책 X = service-role 만 (기존 jimscanner_trends_* 패턴)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_emerging_clusters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  label text NOT NULL,                          -- LLM 자동 라벨 (대표 표현)
  member_terms text[] NOT NULL DEFAULT '{}',    -- 구성 키워드 (distinct surface)
  member_product_ids uuid[] NOT NULL DEFAULT '{}', -- 구성 trends_products id
  category_hint text,                           -- health | living | digital | other | NULL

  member_count int NOT NULL DEFAULT 0,
  source_count int NOT NULL DEFAULT 0,          -- distinct alias source 폭
  total_frequency int NOT NULL DEFAULT 0,       -- 멤버 alias_count 합

  nearest_canonical text,                       -- 가장 가까운 기존 canonical_name
  nearest_similarity numeric,                   -- 0.0~1.0 (낮을수록 화이트스페이스)

  first_seen_at timestamptz,
  last_seen_at  timestamptz,

  status text NOT NULL DEFAULT 'open',          -- 'open' | 'promoted' | 'dismissed'
  promoted_product_id uuid,                     -- 승격 시 생성된 canonical product

  llm_model text,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (label)
);

CREATE INDEX IF NOT EXISTS jimscanner_emerging_clusters_status_fresh
  ON jimscanner_emerging_clusters(status, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_emerging_clusters_whitespace
  ON jimscanner_emerging_clusters(nearest_similarity ASC, total_frequency DESC);

ALTER TABLE jimscanner_emerging_clusters ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만 접근.
