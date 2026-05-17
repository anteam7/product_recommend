-- 트렌드 키워드 핀 (글감 후보) — 키워드 시계열과 별도
-- 2026-05-06

CREATE TABLE IF NOT EXISTS jimscanner_trends_pins (
  keyword text NOT NULL,
  source text NOT NULL,
  pinned_at timestamptz NOT NULL DEFAULT now(),
  notes text,
  PRIMARY KEY (keyword, source)
);

ALTER TABLE jimscanner_trends_pins ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.

-- ─────────────────────────────────────────────────────────────
-- 핀 포트폴리오 자기잠식(Cannibalization) 페어 뷰 (2026-05-17)
-- ─────────────────────────────────────────────────────────────
-- 실제 뷰 정의·인프라(embedding, history, RPC)는
--   supabase/trends_v4_pin_cannibalization.sql 에 있음.
-- 여기서는 forward declaration 목적의 주석 anchor.
--
--   jimscanner_pin_products_v               -- pin → product 해석
--   jimscanner_pin_cannibalization_pairs    -- 핀 쌍 최신 점수
--   jimscanner_pin_cannibalization_history  -- 시계열
--   jimscanner_pin_cannibalization_recompute() -- RPC
-- ─────────────────────────────────────────────────────────────
