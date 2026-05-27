-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — Demographic Demand Fingerprint (2026-05-28)
-- ─────────────────────────────────────────────────────────────
-- 목적: naver_shopping_insight 의 성별·연령 share 응답을 product 단위로 정규화.
-- 이미 적재된 raw payload 만 재파싱 — 추가 API 호출 0.
-- service-role 만 접근. RLS enable + 정책 미정의 (기존 패턴과 동일).
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_demo_fingerprint (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  -- 성별 share: {"m": 0.42, "f": 0.58}
  gender_share jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 연령 share: {"10": 0.05, "20": 0.30, "30": 0.28, "40": 0.20, "50": 0.12, "60": 0.05}
  age_share jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- 최대 share 세그먼트 라벨 (예: '20s_f', '50s_m')
  dominant_segment text,

  -- 집중도(Herfindahl-Hirschman Index): sum(share^2). 1.0 = 한 세그먼트에 100% 집중.
  concentration_hhi numeric,

  -- 소스 — 어떤 raw payload 묶음에서 산출됐는지
  source_label text,

  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_demo_fingerprint_product_at
  ON jimscanner_trends_demo_fingerprint(product_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_demo_fingerprint_segment
  ON jimscanner_trends_demo_fingerprint(dominant_segment, computed_at DESC);

ALTER TABLE jimscanner_trends_demo_fingerprint ENABLE ROW LEVEL SECURITY;

-- 최신 fingerprint 만 보고싶을 때 쓰는 뷰
CREATE OR REPLACE VIEW jimscanner_trends_demo_fingerprint_latest AS
SELECT DISTINCT ON (product_id)
  product_id,
  gender_share,
  age_share,
  dominant_segment,
  concentration_hhi,
  source_label,
  computed_at
FROM jimscanner_trends_demo_fingerprint
ORDER BY product_id, computed_at DESC;
