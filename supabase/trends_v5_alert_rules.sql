-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v5 — 발굴 트리거 룰 엔진 (PR, 2026-06-03)
-- ─────────────────────────────────────────────────────────────
-- 목적: 60개 보드를 '수동 조회' → '능동 감지' 로 뒤집는다.
--   recompute_scores 직후 도는 evaluate-alerts cron 이 직전 스냅샷과
--   비교해 룰 충족 product 를 fired 로 기록하고 채널로 전송.
-- 노출 정책: 기존 jimscanner_trends_* 패턴 — RLS enable + 정책 X = service-role 만.
-- 관련: src/app/api/cron/evaluate-alerts/route.ts, src/lib/trends/evaluate-alerts.ts
-- ─────────────────────────────────────────────────────────────


-- 1) 룰 정의 (조건 DSL)
--    condition jsonb 예시:
--      {"type":"score_delta","metric":"final_score","op":">","threshold":15}
--      {"type":"threshold_cross","metric":"final_score","threshold":80}
--      {"type":"new_supplier_margin","min_margin_krw":3000}
--      {"type":"rank_velocity","metric":"final_score","threshold":20}
--      {"type":"cold_start_token","category_top":"health"}
CREATE TABLE IF NOT EXISTS jimscanner_trends_alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  name text NOT NULL,
  description text,

  -- 조건 DSL (rule engine 이 해석)
  condition jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- 타깃 필터 (선택) — 특정 카테고리만 평가
  category_top text,                         -- NULL = 전체

  -- 전송 방식
  channel text NOT NULL DEFAULT 'digest',    -- 'digest' (1일 1다이제스트) | 'instant'
  enabled boolean NOT NULL DEFAULT true,

  -- 자가 튜닝용 누적 통계 (발화/유효 클릭)
  fired_count int NOT NULL DEFAULT 0,
  hit_count   int NOT NULL DEFAULT 0,        -- 운영자가 '적중' 표시한 횟수

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_alert_rules_enabled
  ON jimscanner_trends_alert_rules(enabled, channel);

ALTER TABLE jimscanner_trends_alert_rules ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION jimscanner_trends_alert_rules_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_trends_alert_rules_updated_at ON jimscanner_trends_alert_rules;
CREATE TRIGGER jimscanner_trends_alert_rules_updated_at
  BEFORE UPDATE ON jimscanner_trends_alert_rules
  FOR EACH ROW EXECUTE FUNCTION jimscanner_trends_alert_rules_set_updated_at();


-- 2) 발화 이력
--    rule 1개가 product 1개에 대해 발화. dedup_key 로 같은 스냅샷 중복 발화 차단.
CREATE TABLE IF NOT EXISTS jimscanner_trends_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id    uuid NOT NULL REFERENCES jimscanner_trends_alert_rules(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  -- 발화 당시 컨텍스트 (UI 피드 표시용)
  product_name text,
  category_top text,
  trigger_value numeric,                     -- delta / 점수 / 마진 등 (룰별 의미)
  message text,                              -- 사람이 읽는 한 줄 ("final_score +18 → 84")
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- 같은 (rule, product, 스냅샷) 중복 차단
  dedup_key text NOT NULL,

  -- 전송 상태
  delivered boolean NOT NULL DEFAULT false,  -- 채널 전송 완료
  delivered_at timestamptz,
  channel text,                              -- 'digest' | 'instant'

  -- 자가 튜닝 — 운영자 피드백
  feedback text,                             -- NULL | 'hit' | 'noise'

  fired_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (dedup_key)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_alerts_rule_at
  ON jimscanner_trends_alerts(rule_id, fired_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_alerts_fired
  ON jimscanner_trends_alerts(fired_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_alerts_undelivered
  ON jimscanner_trends_alerts(delivered, channel) WHERE delivered = false;

ALTER TABLE jimscanner_trends_alerts ENABLE ROW LEVEL SECURITY;


-- 3) 시드 룰 (즉시 가치 — DB 적용 직후 발화 가능)
INSERT INTO jimscanner_trends_alert_rules (name, description, condition, channel)
VALUES
  ('급상승: final_score Δ>15',
   '직전 스냅샷 대비 종합점수가 15점 이상 급등한 상품 (브레이크아웃 선점)',
   '{"type":"score_delta","metric":"final_score","op":">","threshold":15}'::jsonb,
   'instant'),
  ('고득점 진입: final_score 80 상향돌파',
   '직전엔 80 미만이었다가 80 이상으로 올라선 상품 (핀 후보 승격)',
   '{"type":"threshold_cross","metric":"final_score","threshold":80}'::jsonb,
   'digest'),
  ('신규 공급원 + 마진 확보',
   '신규 supplier 가 매칭됐고 추정 마진이 3000원 이상 (소싱 즉시 가능)',
   '{"type":"new_supplier_margin","min_margin_krw":3000}'::jsonb,
   'digest')
ON CONFLICT DO NOTHING;
