-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 운영자 Pin/Reject 결정 회고 코호트 (2026-05-18)
-- ─────────────────────────────────────────────────────────────
-- 목적: 운영자가 핀/리젝 결정을 내릴 때 그 시점의 final_score·구성요소·시그널을
--       영구 스냅샷으로 저장. 사후 t+N 주의 점수 변화와 비교해 직관 보정 가능.
-- 트리거: jimscanner_trends_keywords.pinned 변경 / jimscanner_trends_pins INSERT/DELETE
-- 운영자 UI: /admin/trend-radar/decisions
-- D5: 운영자 전용 (service-role)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 결정 유형
  decision_type text NOT NULL CHECK (decision_type IN ('pin', 'unpin', 'reject', 'note')),
  -- 'pin'    = 핀 등록 (keywords.pinned false→true 또는 pins INSERT)
  -- 'unpin'  = 핀 해제 (keywords.pinned true→false 또는 pins DELETE)
  -- 'reject' = notes 에 'reject' 토큰 포함된 unpin/note
  -- 'note'   = pinned 상태 변경 없이 notes 만 갱신

  -- 대상 엔티티 (keyword 단위 또는 product 단위, 둘 중 하나만 채움)
  entity_kind text NOT NULL CHECK (entity_kind IN ('keyword', 'product')),
  keyword text,
  source text,
  product_id uuid,

  notes text,

  -- 결정 시점 스냅샷 (사후 비교 기준)
  -- keyword 단위는 best-effort: 매핑된 product 의 최신 score 가져오기
  snapshot_final_score numeric,
  snapshot_trend_score numeric,
  snapshot_commerce_score numeric,
  snapshot_supplier_score numeric,
  snapshot_competition_score numeric,
  snapshot_components jsonb,

  -- 추가 시그널 스냅샷 (확장용 — supplier 갯수, alias_count 등 자유롭게 채움)
  snapshot_signals jsonb NOT NULL DEFAULT '{}'::jsonb,

  decided_by text,                       -- 'trigger:keywords' / 'trigger:pins' / 'manual' / '운영자 email'
  decided_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_decisions_decided_at
  ON jimscanner_trends_decisions(decided_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_decisions_keyword
  ON jimscanner_trends_decisions(keyword, source, decided_at DESC)
  WHERE entity_kind = 'keyword';

CREATE INDEX IF NOT EXISTS jimscanner_trends_decisions_product
  ON jimscanner_trends_decisions(product_id, decided_at DESC)
  WHERE entity_kind = 'product';

CREATE INDEX IF NOT EXISTS jimscanner_trends_decisions_type_at
  ON jimscanner_trends_decisions(decision_type, decided_at DESC);

ALTER TABLE jimscanner_trends_decisions ENABLE ROW LEVEL SECURITY;
-- service-role 만.


-- ─────────────────────────────────────────────────────────────
-- 트리거 1) jimscanner_trends_keywords.pinned 변화 자동 기록
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_trends_log_keyword_decision()
RETURNS trigger AS $$
DECLARE
  v_product_id uuid;
  v_score record;
  v_decision_type text;
BEGIN
  -- 결정 유형 결정
  IF TG_OP = 'INSERT' THEN
    IF NEW.pinned IS TRUE THEN
      v_decision_type := 'pin';
    ELSE
      RETURN NEW;  -- 일반 수집 INSERT (pinned=false) 는 무시
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.pinned IS DISTINCT FROM OLD.pinned THEN
      v_decision_type := CASE WHEN NEW.pinned THEN 'pin' ELSE 'unpin' END;
    ELSIF NEW.notes IS DISTINCT FROM OLD.notes AND COALESCE(NEW.notes, '') <> '' THEN
      v_decision_type := 'note';
    ELSE
      RETURN NEW;  -- 점수·기타 컬럼만 갱신된 자동 수집은 무시
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  -- notes 에 reject 토큰 포함 시 reject 로 분류
  IF v_decision_type = 'unpin' AND COALESCE(NEW.notes, OLD.notes, '') ILIKE '%reject%' THEN
    v_decision_type := 'reject';
  END IF;

  -- 매핑된 canonical product 의 최신 score 조회 (best-effort)
  BEGIN
    SELECT s.product_id, s.final_score, s.trend_score, s.commerce_score,
           s.supplier_score, s.competition_score, s.score_components
      INTO v_score
    FROM jimscanner_trends_aliases a
    JOIN jimscanner_trends_scores s ON s.product_id = a.product_id
    WHERE a.alias = NEW.keyword
    ORDER BY s.computed_at DESC
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_score := NULL;
  END;

  INSERT INTO jimscanner_trends_decisions (
    decision_type, entity_kind, keyword, source, product_id, notes,
    snapshot_final_score, snapshot_trend_score, snapshot_commerce_score,
    snapshot_supplier_score, snapshot_competition_score, snapshot_components,
    snapshot_signals, decided_by, decided_at
  ) VALUES (
    v_decision_type,
    'keyword',
    NEW.keyword,
    NEW.source,
    v_score.product_id,
    NEW.notes,
    v_score.final_score,
    v_score.trend_score,
    v_score.commerce_score,
    v_score.supplier_score,
    v_score.competition_score,
    v_score.score_components,
    jsonb_build_object(
      'rank', NEW.rank,
      'volume_relative', NEW.volume_relative,
      'category_top', NEW.category_top,
      'classified_intent', NEW.classified_intent,
      'domain_score', NEW.domain_score
    ),
    'trigger:keywords',
    now()
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_trends_keywords_log_decision
  ON jimscanner_trends_keywords;
CREATE TRIGGER jimscanner_trends_keywords_log_decision
  AFTER INSERT OR UPDATE OF pinned, notes ON jimscanner_trends_keywords
  FOR EACH ROW EXECUTE FUNCTION jimscanner_trends_log_keyword_decision();


-- ─────────────────────────────────────────────────────────────
-- 트리거 2) jimscanner_trends_pins INSERT / DELETE 기록
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_trends_log_pin_decision()
RETURNS trigger AS $$
DECLARE
  v_score record;
  v_keyword text;
  v_source text;
  v_notes text;
  v_decision_type text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_keyword := NEW.keyword;
    v_source := NEW.source;
    v_notes := NEW.notes;
    v_decision_type := 'pin';
  ELSIF TG_OP = 'DELETE' THEN
    v_keyword := OLD.keyword;
    v_source := OLD.source;
    v_notes := OLD.notes;
    v_decision_type := CASE
      WHEN COALESCE(OLD.notes, '') ILIKE '%reject%' THEN 'reject'
      ELSE 'unpin'
    END;
  ELSE
    RETURN NULL;
  END IF;

  BEGIN
    SELECT s.product_id, s.final_score, s.trend_score, s.commerce_score,
           s.supplier_score, s.competition_score, s.score_components
      INTO v_score
    FROM jimscanner_trends_aliases a
    JOIN jimscanner_trends_scores s ON s.product_id = a.product_id
    WHERE a.alias = v_keyword
    ORDER BY s.computed_at DESC
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_score := NULL;
  END;

  INSERT INTO jimscanner_trends_decisions (
    decision_type, entity_kind, keyword, source, product_id, notes,
    snapshot_final_score, snapshot_trend_score, snapshot_commerce_score,
    snapshot_supplier_score, snapshot_competition_score, snapshot_components,
    decided_by, decided_at
  ) VALUES (
    v_decision_type,
    'keyword',
    v_keyword,
    v_source,
    v_score.product_id,
    v_notes,
    v_score.final_score,
    v_score.trend_score,
    v_score.commerce_score,
    v_score.supplier_score,
    v_score.competition_score,
    v_score.score_components,
    'trigger:pins',
    now()
  );

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_trends_pins_log_decision
  ON jimscanner_trends_pins;
CREATE TRIGGER jimscanner_trends_pins_log_decision
  AFTER INSERT OR DELETE ON jimscanner_trends_pins
  FOR EACH ROW EXECUTE FUNCTION jimscanner_trends_log_pin_decision();


-- ─────────────────────────────────────────────────────────────
-- 헬퍼 RPC: 결정 시점 → t+N일 뒤의 최신 final_score 변화량
--   대시보드에서 코호트 분포 만들 때 사용. product_id 가 있는 결정만 의미 있음.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_trends_decision_followups(
  p_days_after int DEFAULT 7,
  p_since timestamptz DEFAULT (now() - interval '90 days')
)
RETURNS TABLE (
  decision_id uuid,
  decision_type text,
  product_id uuid,
  keyword text,
  decided_at timestamptz,
  snapshot_final numeric,
  followup_final numeric,
  delta numeric
)
LANGUAGE sql STABLE AS $$
  SELECT
    d.id,
    d.decision_type,
    d.product_id,
    d.keyword,
    d.decided_at,
    d.snapshot_final_score,
    fs.final_score,
    fs.final_score - d.snapshot_final_score
  FROM jimscanner_trends_decisions d
  LEFT JOIN LATERAL (
    SELECT s.final_score
    FROM jimscanner_trends_scores s
    WHERE s.product_id = d.product_id
      AND s.computed_at >= d.decided_at + (p_days_after || ' days')::interval
    ORDER BY s.computed_at ASC
    LIMIT 1
  ) fs ON TRUE
  WHERE d.decided_at >= p_since
    AND d.product_id IS NOT NULL
    AND d.snapshot_final_score IS NOT NULL;
$$;
