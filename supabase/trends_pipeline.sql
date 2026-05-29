-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 — 발굴 후보 파이프라인 추적 (2026-05-30)
-- ─────────────────────────────────────────────────────────────
-- 60개 분석 보드는 '신호 생성'만 할 뿐, 운영자가 후보를
--   '검토 → 소싱확정 → 등록 → 판매' 로 끌고 가는 추적 레이어가 없었음.
-- 본 테이블은 product 단위 단계(stage) 추적 + 이탈사유(dropped_reason)를
--   기록해 퍼널 전환율 / 단계 체류일(dwell-time) / 병목 분석을 가능케 함.
--
-- 노출 정책: 기존 jimscanner_trends_* 패턴과 동일 — RLS enable + 정책 X
--   = service-role(어드민) 만 접근.
-- 관련: ROI 피드백(#7), score 백테스트(#20) 의 라벨 공급원.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_pipeline (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  -- 발굴 → 검토 → 소싱확정 → 등록 → 판매 (+ 이탈)
  stage text NOT NULL DEFAULT 'discovered'
    CHECK (stage IN ('discovered','reviewing','sourcing','listed','selling','dropped')),

  -- 현재 stage 로 전환된 시각 (체류일 dwell-time 계산 기준)
  stage_changed_at timestamptz NOT NULL DEFAULT now(),

  -- stage = 'dropped' 일 때만 의미. 어디서 가장 많이 죽는지 분석.
  dropped_reason text
    CHECK (dropped_reason IS NULL OR dropped_reason IN
      ('마진부족','반품위험','소싱불가','경쟁과포화','인증장벽','기타')),

  assigned_at timestamptz NOT NULL DEFAULT now(),  -- 파이프라인 최초 진입(담당) 시각
  note text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- 한 상품은 파이프라인에 1행만 (현재 단계). 단계 전환 이력은 below 의 history 테이블.
  UNIQUE (product_id)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_pipeline_stage
  ON jimscanner_trends_pipeline(stage, stage_changed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_pipeline_product
  ON jimscanner_trends_pipeline(product_id);

ALTER TABLE jimscanner_trends_pipeline ENABLE ROW LEVEL SECURITY;

-- updated_at 자동 갱신 (기존 products 패턴 재사용)
CREATE OR REPLACE FUNCTION jimscanner_trends_pipeline_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_trends_pipeline_updated_at ON jimscanner_trends_pipeline;
CREATE TRIGGER jimscanner_trends_pipeline_updated_at
  BEFORE UPDATE ON jimscanner_trends_pipeline
  FOR EACH ROW EXECUTE FUNCTION jimscanner_trends_pipeline_set_updated_at();


-- ─────────────────────────────────────────────────────────────
-- 단계 전환 이력 (퍼널 전환율 / 단계별 체류일 p50·p90 분석 원천)
--   pipeline.stage_changed_at 은 '현재' 만 알지만, 이력 테이블로
--   "discovered→reviewing 전환에 평균 며칠?" 같은 dwell-time 분석 가능.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jimscanner_trends_pipeline_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  from_stage text,                  -- NULL = 최초 진입
  to_stage text NOT NULL,
  dropped_reason text,
  note text,

  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_pipeline_history_product_at
  ON jimscanner_trends_pipeline_history(product_id, changed_at);

CREATE INDEX IF NOT EXISTS jimscanner_trends_pipeline_history_to_stage
  ON jimscanner_trends_pipeline_history(to_stage, changed_at);

ALTER TABLE jimscanner_trends_pipeline_history ENABLE ROW LEVEL SECURITY;
