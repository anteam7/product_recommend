-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 한국 인허가 강제 게이트 (2026-05-26)
-- ─────────────────────────────────────────────────────────────
-- 위탁 셀러가 도매 입수 직전 마지막으로 체크해야 하는 인허가 정보.
-- KC·식약처·전파인증·에너지효율 등 강제 인증 누락 시 적발 → 판매중지 + 과태료.
-- brand_safety (지식재산 권리침해) 와 별개 — 이건 법적 판매자격.
-- 정책: jimscanner_trends_* 패턴 동일 — RLS enable + service-role 전용.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_certifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  -- 인증 종류:
  --   kc_safety       : KC 안전인증 (전기·전자제품 안전)
  --   kc_emi          : KC 전자파 적합성
  --   kc_kids         : KC 어린이용품 안전인증
  --   mfds_food       : 식약처 건강기능식품·식품 자가품질검사·수입신고
  --   mfds_cosmetic   : 화장품 책임판매업자 등록 + 표시기재
  --   mfds_med        : 의료기기 (가정용 포함) 품목허가
  --   rra_radio       : 전파인증 (방통위/RRA) — 블루투스·와이파이 등 무선기기
  --   kats_efficiency : 에너지소비효율등급 (KATS) — 가전제품
  cert_type text NOT NULL CHECK (cert_type IN (
    'kc_safety','kc_emi','kc_kids','mfds_food','mfds_cosmetic','mfds_med','rra_radio','kats_efficiency'
  )),

  mandatory boolean NOT NULL DEFAULT true,    -- 법적 강제 여부 (true=강제, false=선택)
  est_cost_krw integer,                       -- 예상 인증비용 (KRW)
  est_lead_weeks integer,                     -- 예상 소요기간 (주)

  rule_source text,                           -- 'rule_engine' | 'llm_haiku' | 'manual'
  rule_keyword text,                          -- 매칭된 키워드 (디버깅용)
  confidence numeric NOT NULL DEFAULT 0.8,    -- 0.0~1.0

  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (product_id, cert_type)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_certifications_product
  ON jimscanner_trends_certifications(product_id);

CREATE INDEX IF NOT EXISTS jimscanner_trends_certifications_type
  ON jimscanner_trends_certifications(cert_type, mandatory);

ALTER TABLE jimscanner_trends_certifications ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만 접근.

CREATE OR REPLACE FUNCTION jimscanner_trends_certifications_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_trends_certifications_updated_at ON jimscanner_trends_certifications;
CREATE TRIGGER jimscanner_trends_certifications_updated_at
  BEFORE UPDATE ON jimscanner_trends_certifications
  FOR EACH ROW EXECUTE FUNCTION jimscanner_trends_certifications_set_updated_at();


-- 진입가능성 집계 view (어드민 KPI 카드용)
-- - clear      : 인증 0건       → 진입가능
-- - low_cost   : 누계비용 < 200만 & lead < 6주 → 진입제한 (저비용)
-- - high_cost  : 그 외                          → 진입불가 (고비용·장기)
CREATE OR REPLACE VIEW jimscanner_trends_entry_gate AS
SELECT
  p.id AS product_id,
  COALESCE(SUM(CASE WHEN c.mandatory THEN c.est_cost_krw ELSE 0 END), 0) AS total_cost_krw,
  COALESCE(MAX(CASE WHEN c.mandatory THEN c.est_lead_weeks ELSE 0 END), 0) AS max_lead_weeks,
  COUNT(c.id) FILTER (WHERE c.mandatory) AS mandatory_cert_count,
  CASE
    WHEN COUNT(c.id) FILTER (WHERE c.mandatory) = 0 THEN 'clear'
    WHEN COALESCE(SUM(CASE WHEN c.mandatory THEN c.est_cost_krw ELSE 0 END), 0) < 2000000
      AND COALESCE(MAX(CASE WHEN c.mandatory THEN c.est_lead_weeks ELSE 0 END), 0) < 6
      THEN 'low_cost'
    ELSE 'high_cost'
  END AS entry_class
FROM jimscanner_trends_products p
LEFT JOIN jimscanner_trends_certifications c ON c.product_id = p.id
GROUP BY p.id;
