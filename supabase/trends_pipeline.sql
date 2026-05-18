-- 발굴→수익화 5단계 칸반: 운영자 워크플로 진척 보드
-- 적용: psql + connection pooler (6543). 적용 후 코드에서 `as any` 캐스팅 유지.
--
-- 의존: jimscanner_trends_products (product_id)
-- 핀 토글 시 자동으로 sourcing 단계 row 삽입 (앱 코드에서 처리)

-- 단계 enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'jimscanner_trends_pipeline_stage') THEN
    CREATE TYPE jimscanner_trends_pipeline_stage AS ENUM (
      'discovery',    -- 발굴 (스코어링됨, 검토 대기)
      'sourcing',     -- 소싱 (핀됨, 공급망 확인 중)
      'listing',      -- 리스팅 (위탁 등록 중)
      'live',         -- 라이브 (판매 중)
      'profitable',   -- 수익화 (목표 마진 도달)
      'rejected'      -- 반려 (보류 / 포기)
    );
  END IF;
END$$;

-- 현재 단계 (product_id 당 최대 1 row)
CREATE TABLE IF NOT EXISTS jimscanner_trends_pipeline_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  stage jimscanner_trends_pipeline_stage NOT NULL,
  entered_at timestamptz NOT NULL DEFAULT now(),
  owner_email text,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id)
);

CREATE INDEX IF NOT EXISTS idx_jimscanner_trends_pipeline_stages_stage
  ON jimscanner_trends_pipeline_stages(stage, entered_at DESC);

-- 단계 전환 로그 (회고 / 캘리브레이션용 ground truth)
CREATE TABLE IF NOT EXISTS jimscanner_trends_stage_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  from_stage jimscanner_trends_pipeline_stage,
  to_stage jimscanner_trends_pipeline_stage NOT NULL,
  transitioned_at timestamptz NOT NULL DEFAULT now(),
  transitioned_by text,
  dwell_ms bigint,
  notes text
);

CREATE INDEX IF NOT EXISTS idx_jimscanner_trends_stage_transitions_product
  ON jimscanner_trends_stage_transitions(product_id, transitioned_at DESC);

CREATE INDEX IF NOT EXISTS idx_jimscanner_trends_stage_transitions_to_stage
  ON jimscanner_trends_stage_transitions(to_stage, transitioned_at DESC);

-- 트리거: updated_at 자동 갱신
CREATE OR REPLACE FUNCTION jimscanner_trends_pipeline_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS trg_jimscanner_trends_pipeline_stages_updated
  ON jimscanner_trends_pipeline_stages;
CREATE TRIGGER trg_jimscanner_trends_pipeline_stages_updated
  BEFORE UPDATE ON jimscanner_trends_pipeline_stages
  FOR EACH ROW EXECUTE FUNCTION jimscanner_trends_pipeline_touch_updated_at();

-- RLS: 어드민 페이지에서 service-role 키로만 접근하므로 RLS off (admin-only 정책)
ALTER TABLE jimscanner_trends_pipeline_stages DISABLE ROW LEVEL SECURITY;
ALTER TABLE jimscanner_trends_stage_transitions DISABLE ROW LEVEL SECURITY;
