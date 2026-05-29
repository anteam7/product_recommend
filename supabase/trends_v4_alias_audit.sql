-- ────────────────────────────────────────────────────────────
-- 캐노니컬 병합 무결성 감사 — Alias 오병합/과소병합 진단 (2026-05-30)
-- ────────────────────────────────────────────────────────────
-- 배경: 위탁 발굴 전 분석(수요·경쟁·점수)이 모두 '캐노니컬 상품'(jimscanner_trends_products)
--       단위로 집계된다. alias→product 병합(LLM confidence≈0.7 / manual 1.0)이 틀리면
--       모든 지표가 조용히 오염되는데, 사후 검증 장치가 전무했다.
-- 이 마이그레이션:
--   1) jimscanner_trends_alias_audit  뷰  — product별 alias 위생 지표(LLM 비중·저신뢰 비중·평균 confidence)
--   2) jimscanner_trends_alias_overrides 테이블 — 운영자 1클릭 분할/병합/확정 액션 로그(감사 추적)
--
-- 오병합(한 클러스터에 이질적 alias 혼입)·과소병합(중복 캐노니컬) 후보 점수는
-- 페이지(/admin/trend-radar/integrity)에서 token Jaccard 코히어런스로 계산한다.
-- (Postgres pg_trgm 없이도 동작하도록 무거운 pairwise 계산은 앱 레이어에서 수행)
--
-- 노출 정책: 기존 jimscanner_trends_* 패턴과 동일 — RLS enable, 정책 미정의 = service-role 전용.
-- ────────────────────────────────────────────────────────────


-- 1) product별 alias 위생 지표 뷰
--    UI 의 '고LLM비중' 탭 + 오병합/과소병합 후보의 신뢰도 컨텍스트로 사용.
CREATE OR REPLACE VIEW jimscanner_trends_alias_audit AS
SELECT
  p.id                                   AS product_id,
  p.canonical_name,
  p.category_top,
  p.category_mid,
  COUNT(a.id)                            AS alias_count,
  COUNT(a.id) FILTER (WHERE a.classified_by = 'llm_haiku'
                        OR a.classified_by ILIKE 'llm%')          AS llm_count,
  COUNT(a.id) FILTER (WHERE a.confidence < 0.7)                   AS low_conf_count,
  COUNT(a.id) FILTER (WHERE a.classified_by = 'manual'
                        OR a.confidence >= 1.0)                   AS manual_count,
  COUNT(DISTINCT a.alias_type)                                    AS alias_type_count,
  COUNT(DISTINCT a.source)                                        AS source_count,
  ROUND(AVG(a.confidence)::numeric, 3)                           AS avg_confidence,
  MIN(a.confidence)                                              AS min_confidence,
  -- LLM/저신뢰 비중 (0~1). alias_count=0 이면 0.
  CASE WHEN COUNT(a.id) = 0 THEN 0
       ELSE ROUND(
         COUNT(a.id) FILTER (WHERE a.classified_by ILIKE 'llm%' OR a.confidence < 0.7)::numeric
         / COUNT(a.id), 3)
  END                                                            AS llm_low_ratio
FROM jimscanner_trends_products p
LEFT JOIN jimscanner_trends_aliases a ON a.product_id = p.id
GROUP BY p.id, p.canonical_name, p.category_top, p.category_mid;

COMMENT ON VIEW jimscanner_trends_alias_audit IS
  'product별 alias 병합 위생 지표 — LLM/저신뢰 비중, 평균 confidence. /admin/trend-radar/integrity 고LLM비중 탭 소스.';


-- 2) 운영자 병합/분할/확정 액션 로그 (감사 추적 + 멱등성 참고)
--    실제 데이터 변경은 server action 이 jimscanner_trends_aliases / _products 에 직접 수행하고,
--    여기엔 '누가 무엇을 했는지' 기록만 남긴다.
CREATE TABLE IF NOT EXISTS jimscanner_trends_alias_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  action text NOT NULL,                  -- 'confirm' | 'split' | 'merge'
  alias text,                            -- confirm/split 대상 alias
  alias_type text,
  from_product_id uuid,                  -- split/merge 원본 product
  to_product_id uuid,                    -- split: 신규 product / merge: 흡수 product
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_alias_overrides_created
  ON jimscanner_trends_alias_overrides(created_at DESC);

ALTER TABLE jimscanner_trends_alias_overrides ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE jimscanner_trends_alias_overrides IS
  '캐노니컬 병합 무결성 감사 — 운영자 1클릭 분할/병합/확정 액션 로그(감사 추적).';
