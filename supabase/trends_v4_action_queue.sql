-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 오늘의 액션 큐 (2026-05-16)
-- ─────────────────────────────────────────────────────────────
-- 목적: 시그널(점수/도매가/모멘텀)을 운영자 To-Do 카드로 변환.
-- 발굴 → 결정 → 실행 funnel 측정 (생성→완료 lead-time, skip ratio).
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_action_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  action_type text NOT NULL CHECK (action_type IN ('register','reprice','restock','derecord')),

  trigger_signal jsonb NOT NULL DEFAULT '{}'::jsonb,  -- 어떤 시그널이 카드를 만들었는지 원본
  trigger_rule text,                                   -- 룰 식별자 (예: 'final_score_entry_60')

  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','snoozed','done','skipped')),
  priority_score numeric NOT NULL DEFAULT 0,           -- 카드 정렬용 (final_score 또는 가중치)

  decision_note text,                                  -- 운영자 처리 코멘트
  snoozed_until timestamptz,

  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,                            -- done / skipped 처리 시각
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- 같은 product + action_type 의 활성 카드(new/snoozed) 중복 방지.
-- 'done' / 'skipped' 후 동일 시그널이 또 뜨면 새 카드 허용.
CREATE UNIQUE INDEX IF NOT EXISTS jimscanner_trends_action_queue_active_unique
  ON jimscanner_trends_action_queue(product_id, action_type)
  WHERE status IN ('new','snoozed');

CREATE INDEX IF NOT EXISTS jimscanner_trends_action_queue_status_created
  ON jimscanner_trends_action_queue(status, created_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_action_queue_product
  ON jimscanner_trends_action_queue(product_id);

CREATE INDEX IF NOT EXISTS jimscanner_trends_action_queue_priority
  ON jimscanner_trends_action_queue(priority_score DESC, created_at DESC)
  WHERE status = 'new';

ALTER TABLE jimscanner_trends_action_queue ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만 — 정책 미정의 = anon 접근 차단.

-- updated_at 자동 갱신
CREATE OR REPLACE FUNCTION jimscanner_trends_action_queue_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_trends_action_queue_updated_at ON jimscanner_trends_action_queue;
CREATE TRIGGER jimscanner_trends_action_queue_updated_at
  BEFORE UPDATE ON jimscanner_trends_action_queue
  FOR EACH ROW EXECUTE FUNCTION jimscanner_trends_action_queue_set_updated_at();


-- ─────────────────────────────────────────────────────────────
-- 트리거 룰 생성 함수 — cron 또는 수동 호출.
-- 룰 1) register: final_score 가 처음으로 ≥60 진입한 product
-- 룰 2) reprice : 핀된(jimscanner_trends_pins) keyword 와 매칭되는
--                 product 중 supplier_score ≥ 70 (도매가 좋음)
-- 룰 3) derecord: 최근 30일 final_score 평균이 직전 30일 대비 ≤ -20
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_trends_action_queue_generate()
RETURNS TABLE(action_type text, inserted int) AS $$
DECLARE
  reg_count int := 0;
  rep_count int := 0;
  der_count int := 0;
BEGIN
  -- 1) REGISTER: 최신 score ≥ 60, 활성 카드 없으면 생성
  WITH latest AS (
    SELECT DISTINCT ON (s.product_id)
      s.product_id, s.final_score, s.trend_score, s.commerce_score,
      s.supplier_score, s.computed_at
    FROM jimscanner_trends_scores s
    ORDER BY s.product_id, s.computed_at DESC
  ),
  ins AS (
    INSERT INTO jimscanner_trends_action_queue
      (product_id, action_type, trigger_signal, trigger_rule, priority_score)
    SELECT
      l.product_id,
      'register',
      jsonb_build_object(
        'final_score', l.final_score,
        'trend_score', l.trend_score,
        'commerce_score', l.commerce_score,
        'supplier_score', l.supplier_score,
        'computed_at', l.computed_at
      ),
      'final_score_entry_60',
      l.final_score
    FROM latest l
    WHERE l.final_score >= 60
      AND NOT EXISTS (
        SELECT 1 FROM jimscanner_trends_action_queue q
        WHERE q.product_id = l.product_id
          AND q.action_type = 'register'
          AND q.status IN ('new','snoozed')
      )
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO reg_count FROM ins;

  -- 2) REPRICE: 핀 keyword 와 alias 매칭 + supplier_score ≥ 70
  WITH latest AS (
    SELECT DISTINCT ON (s.product_id)
      s.product_id, s.final_score, s.supplier_score, s.computed_at
    FROM jimscanner_trends_scores s
    ORDER BY s.product_id, s.computed_at DESC
  ),
  pinned_products AS (
    SELECT DISTINCT a.product_id
    FROM jimscanner_trends_aliases a
    JOIN jimscanner_trends_pins p ON p.keyword = a.alias
  ),
  ins AS (
    INSERT INTO jimscanner_trends_action_queue
      (product_id, action_type, trigger_signal, trigger_rule, priority_score)
    SELECT
      l.product_id,
      'reprice',
      jsonb_build_object(
        'final_score', l.final_score,
        'supplier_score', l.supplier_score,
        'pinned', true,
        'computed_at', l.computed_at
      ),
      'pinned_supplier_70',
      l.supplier_score
    FROM latest l
    JOIN pinned_products pp ON pp.product_id = l.product_id
    WHERE l.supplier_score >= 70
      AND NOT EXISTS (
        SELECT 1 FROM jimscanner_trends_action_queue q
        WHERE q.product_id = l.product_id
          AND q.action_type = 'reprice'
          AND q.status IN ('new','snoozed')
      )
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO rep_count FROM ins;

  -- 3) DERECORD: 최근 7일 평균 final_score 가 직전 30일 평균 대비 ≤ -20
  WITH recent AS (
    SELECT product_id, avg(final_score)::numeric AS avg_recent
    FROM jimscanner_trends_scores
    WHERE computed_at >= now() - interval '7 days'
    GROUP BY product_id
  ),
  prior AS (
    SELECT product_id, avg(final_score)::numeric AS avg_prior
    FROM jimscanner_trends_scores
    WHERE computed_at < now() - interval '7 days'
      AND computed_at >= now() - interval '37 days'
    GROUP BY product_id
  ),
  ins AS (
    INSERT INTO jimscanner_trends_action_queue
      (product_id, action_type, trigger_signal, trigger_rule, priority_score)
    SELECT
      r.product_id,
      'derecord',
      jsonb_build_object(
        'avg_recent_7d', r.avg_recent,
        'avg_prior_30d', p.avg_prior,
        'delta', (r.avg_recent - p.avg_prior)
      ),
      'momentum_drop_20',
      (p.avg_prior - r.avg_recent)  -- 큰 하락일수록 priority ↑
    FROM recent r
    JOIN prior p ON p.product_id = r.product_id
    WHERE (r.avg_recent - p.avg_prior) <= -20
      AND NOT EXISTS (
        SELECT 1 FROM jimscanner_trends_action_queue q
        WHERE q.product_id = r.product_id
          AND q.action_type = 'derecord'
          AND q.status IN ('new','snoozed')
      )
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO der_count FROM ins;

  RETURN QUERY VALUES
    ('register', reg_count),
    ('reprice', rep_count),
    ('derecord', der_count);
END;
$$ LANGUAGE plpgsql;
