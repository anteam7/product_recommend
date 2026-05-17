-- ──────────────────────────────────────────────────────────────
-- Triage Inbox: 미분류 시그널 키보드 단축키 일괄 처리 (2026-05-18)
-- ──────────────────────────────────────────────────────────────
-- 어드민이 J/K, 1~9, P/X/S/N/A 단축키로 미분류 product 를 빠르게 정리.
-- 1) jimscanner_trends_products 에 triage 상태 컬럼 추가
-- 2) jimscanner_classify_events 감사 테이블
-- 3) jimscanner_classify_apply RPC (UPDATE + audit 동시 처리)
-- ──────────────────────────────────────────────────────────────

ALTER TABLE jimscanner_trends_products
  ADD COLUMN IF NOT EXISTS classify_status text,           -- 'classified' | 'pinned' | 'rejected' | 'snoozed'
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz,
  ADD COLUMN IF NOT EXISTS triage_note text,
  ADD COLUMN IF NOT EXISTS triaged_at timestamptz,
  ADD COLUMN IF NOT EXISTS triaged_by text;

CREATE INDEX IF NOT EXISTS jimscanner_trends_products_inbox
  ON jimscanner_trends_products(updated_at DESC)
  WHERE classify_status IS NULL OR classify_status = 'snoozed';

CREATE TABLE IF NOT EXISTS jimscanner_classify_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  actor_email text,
  action text NOT NULL,                       -- 'classified' | 'pinned' | 'rejected' | 'snoozed' | 'note' | 'accept_llm'
  prev_category_top text,
  prev_category_mid text,
  prev_intent_label text,
  next_category_top text,
  next_category_mid text,
  next_intent_label text,
  note text,
  snoozed_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_classify_events_product
  ON jimscanner_classify_events(product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_classify_events_actor_day
  ON jimscanner_classify_events(actor_email, created_at DESC);

ALTER TABLE jimscanner_classify_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION jimscanner_classify_apply(
  p_product_id    uuid,
  p_category_top  text,
  p_category_mid  text,
  p_intent_label  text,
  p_status        text,        -- 'classified' | 'pinned' | 'rejected' | 'snoozed' | 'note'
  p_note          text,
  p_actor         text,
  p_snooze_days   int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_prev    record;
  v_snooze  timestamptz;
BEGIN
  SELECT category_top, category_mid, intent_label
    INTO v_prev
    FROM jimscanner_trends_products
   WHERE id = p_product_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product not found: %', p_product_id;
  END IF;

  IF p_status = 'snoozed' THEN
    v_snooze := now() + (COALESCE(p_snooze_days, 7) || ' days')::interval;
  END IF;

  UPDATE jimscanner_trends_products
     SET category_top = CASE
                          WHEN p_status IN ('classified','pinned') AND p_category_top IS NOT NULL
                            THEN p_category_top
                          ELSE category_top
                        END,
         category_mid = CASE
                          WHEN p_status IN ('classified','pinned')
                            THEN COALESCE(p_category_mid, category_mid)
                          ELSE category_mid
                        END,
         intent_label = CASE
                          WHEN p_status IN ('classified','pinned')
                            THEN COALESCE(p_intent_label, intent_label)
                          ELSE intent_label
                        END,
         classify_status   = p_status,
         snoozed_until     = v_snooze,
         triage_note       = COALESCE(p_note, triage_note),
         triaged_at        = now(),
         triaged_by        = p_actor,
         llm_classified_at = CASE
                               WHEN p_status = 'classified' AND llm_classified_at IS NULL
                                 THEN now()
                               ELSE llm_classified_at
                             END,
         updated_at        = now()
   WHERE id = p_product_id;

  INSERT INTO jimscanner_classify_events (
    product_id, actor_email, action,
    prev_category_top, prev_category_mid, prev_intent_label,
    next_category_top, next_category_mid, next_intent_label,
    note, snoozed_until
  ) VALUES (
    p_product_id, p_actor, p_status,
    v_prev.category_top, v_prev.category_mid, v_prev.intent_label,
    p_category_top, p_category_mid, p_intent_label,
    p_note, v_snooze
  );

  RETURN jsonb_build_object(
    'ok', true,
    'product_id', p_product_id,
    'status', p_status,
    'snoozed_until', v_snooze
  );
END;
$$;

REVOKE ALL ON FUNCTION jimscanner_classify_apply(uuid,text,text,text,text,text,text,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_classify_apply(uuid,text,text,text,text,text,text,int) TO service_role;
