-- ────────────────────────────────────────────────────────────
-- 표시광고·식약처 컴플라이언스 게이트 (PR-COMPLIANCE-1)
-- ────────────────────────────────────────────────────────────
-- 멜라토닌·다이어트·미백·기능성 표현은 식약처·표시광고법 직격 카테고리.
-- 핀/리스팅 후보를 등록 전에 룰셋으로 자동 스캔해서 차단·경고·면책문구 강제.
--
-- 적용 도메인(domain):
--   '약사법', '식약처건강기능식품', '의료기기법', '화장품법', '표시광고법', '공정위'
-- 액션(action):
--   'block'         — 등록 차단
--   'warn'          — 운영자 확인 필요 (재검토 큐)
--   'require_doc'   — 면책문구·인증서류 첨부 강제
-- ────────────────────────────────────────────────────────────

-- 1) 룰셋
CREATE TABLE IF NOT EXISTS jimscanner_compliance_rules (
  rule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text NOT NULL CHECK (
    domain IN ('약사법','식약처건강기능식품','의료기기법','화장품법','표시광고법','공정위')
  ),
  rule_name text NOT NULL,
  banned_phrases text[] NOT NULL DEFAULT '{}',
  required_disclaimer text,
  action text NOT NULL CHECK (action IN ('block','warn','require_doc')),
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
  reference_url text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_compliance_rules_domain
  ON jimscanner_compliance_rules(domain, is_active);

ALTER TABLE jimscanner_compliance_rules ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION jimscanner_compliance_rules_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_compliance_rules_updated_at ON jimscanner_compliance_rules;
CREATE TRIGGER jimscanner_compliance_rules_updated_at
  BEFORE UPDATE ON jimscanner_compliance_rules
  FOR EACH ROW EXECUTE FUNCTION jimscanner_compliance_rules_set_updated_at();


-- 2) 위반 적발 (스캔 결과)
CREATE TABLE IF NOT EXISTS jimscanner_compliance_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_kind text NOT NULL CHECK (target_kind IN ('pin','ggsan_product','trend_product','trend_keyword')),
  target_id text NOT NULL,            -- pin: keyword::source, ggsan: goods_no, trend_*: id/keyword
  target_label text,                  -- 사람-읽기 라벨 (제목/키워드)
  rule_id uuid NOT NULL REFERENCES jimscanner_compliance_rules(rule_id) ON DELETE CASCADE,
  matched_text text NOT NULL,         -- 어떤 표현이 걸렸는지
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  action text NOT NULL CHECK (action IN ('block','warn','require_doc')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text,
  resolution_note text,                -- 운영자 해제 사유
  UNIQUE (target_kind, target_id, rule_id, matched_text)
);

CREATE INDEX IF NOT EXISTS jimscanner_compliance_findings_unresolved
  ON jimscanner_compliance_findings(detected_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS jimscanner_compliance_findings_target
  ON jimscanner_compliance_findings(target_kind, target_id);
CREATE INDEX IF NOT EXISTS jimscanner_compliance_findings_rule
  ON jimscanner_compliance_findings(rule_id, detected_at DESC);

ALTER TABLE jimscanner_compliance_findings ENABLE ROW LEVEL SECURITY;


-- 3) 초기 룰 시드 — 한국 규제 사전
INSERT INTO jimscanner_compliance_rules (domain, rule_name, banned_phrases, required_disclaimer, action, severity, reference_url) VALUES
-- 약사법 — 의약품 오인광고
('약사법', '의약품 효능 오인표현',
  ARRAY['치료','완치','특효','치유','의학적 효능','약효','약리작용','즉효','특허받은 치료'],
  NULL, 'block', 'critical',
  'https://www.law.go.kr/법령/약사법'),

-- 식약처 건강기능식품 — 기능성 과대광고
('식약처건강기능식품', '기능성 과대광고 (체지방·다이어트)',
  ARRAY['살빠지는','다이어트 보장','체지방 분해','지방연소','뱃살빼기','100% 감량','즉시 다이어트'],
  '※ 본 제품은 건강기능식품으로 질병의 예방·치료를 위한 의약품이 아닙니다.',
  'block', 'high',
  'https://www.mfds.go.kr'),

('식약처건강기능식품', '수면·멜라토닌 오남용 광고',
  ARRAY['수면제 대체','불면증 치료','우울증 개선','자살충동 완화','정신과약 대신','신경안정제'],
  '※ 본 제품은 건강기능식품이며 수면장애의 진단·치료 목적이 아닙니다. 지속적 불면 시 전문의 상담을 권장합니다.',
  'block', 'critical',
  'https://www.mfds.go.kr'),

('식약처건강기능식품', '면역·항암 오인표현',
  ARRAY['항암','암 예방','암 치료','면역치료','종양 제거','바이러스 박멸','코로나 예방','코로나 치료'],
  NULL, 'block', 'critical',
  'https://www.mfds.go.kr'),

('식약처건강기능식품', '필수 면책문구 누락',
  ARRAY['건강기능식품','건기식','영양제'],
  '※ 본 제품은 질병의 예방·치료를 위한 의약품이 아닙니다.',
  'require_doc', 'medium',
  'https://www.mfds.go.kr'),

-- 의료기기법
('의료기기법', '의료기기 미인증 효능표시',
  ARRAY['혈압 측정','혈당 측정','진단','심전도','체온계 의료용','의료용 마사지기','통증치료기'],
  NULL, 'warn', 'high',
  'https://www.mfds.go.kr'),

-- 화장품법
('화장품법', '미백·주름 등 기능성 오인',
  ARRAY['주름제거','피부재생','상처치유','아토피 치료','여드름 치료','탈모치료','발모','모발성장 보장'],
  '※ 본 제품은 화장품이며 의학적 효능을 제공하지 않습니다.',
  'warn', 'high',
  'https://www.law.go.kr/법령/화장품법'),

-- 표시광고법 — 과장·기만
('표시광고법', '최상급·절대표현',
  ARRAY['최고','최저가 보장','업계 1위','국내 유일','100% 효과','부작용 없음','완벽','단 한 번에'],
  NULL, 'warn', 'medium',
  'https://www.ftc.go.kr'),

('표시광고법', '비교광고 기만',
  ARRAY['타사 대비 2배','경쟁사보다 우수','업계 평균보다','시중 제품 대비'],
  '※ 비교 근거 자료를 보유하고 있어야 합니다.',
  'require_doc', 'medium',
  'https://www.ftc.go.kr'),

-- 공정위 — 후기·체험단
('공정위', '뒷광고·체험단 미표시',
  ARRAY['내돈내산','솔직후기','진짜 후기','광고아님','협찬X'],
  '※ 경제적 대가를 받은 경우 「소정의 수수료를 지급받습니다」 등 명시 의무.',
  'warn', 'high',
  'https://www.ftc.go.kr')
ON CONFLICT DO NOTHING;
