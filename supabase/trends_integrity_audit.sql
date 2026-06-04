-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 — Canonical 엔티티해상도 정합성 감사 (2026-06-05)
-- ─────────────────────────────────────────────────────────────
-- v4 전체 점수(final_score·trend_score)는 alias→canonical 병합이 옳다는
-- 가정 위에 선다. classify-trends-llm.mjs 가 canonical_name 을 LLM(conf~0.7)으로
-- 생성하므로 다음 두 오류가 점수를 왜곡한다:
--   ① false aggregation — 서로 다른 상품이 한 canonical 로 합쳐져 점수 과대
--   ② undercount — 같은 상품이 여러 canonical 로 쪼개져 신호 분산
-- 이 마이그레이션은 그 전제 자체를 검증하는 감사 레이어를 추가한다.
--
-- 노출 정책: 기존 jimscanner_trends_* 와 동일 — RLS enable + 정책 미정의
--   = service-role(어드민) 만 접근.
-- 관련: src/app/admin/(dashboard)/trend-radar/integrity/page.tsx
--       src/app/api/admin/trends/integrity/route.ts
-- ─────────────────────────────────────────────────────────────

-- canonical_name trigram 유사도 계산용
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS jimscanner_trends_products_canonical_trgm
  ON jimscanner_trends_products USING gin (canonical_name gin_trgm_ops);


-- 0) 무시 처리된 감사 항목 (운영자가 [무시] 누른 쌍/고아)
--    finding_key = kind + ':' + product_a_id + ':' + (product_b_id|product_b_name)
CREATE TABLE IF NOT EXISTS jimscanner_trends_integrity_ignored (
  finding_key text PRIMARY KEY,
  kind text NOT NULL,
  note text,
  ignored_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE jimscanner_trends_integrity_ignored ENABLE ROW LEVEL SECURITY;


-- 1) 정합성 감사 뷰
--    kind 컬럼으로 세 종류의 의심 항목을 union:
--      'duplicate_suspect' — 카테고리 동일 + canonical_name 유사도 높은 product 쌍 (undercount)
--      'hetero_merge'      — 한 product 의 alias 평균 confidence 가 낮은 클러스터 (false aggregation)
--      'orphan_alias'      — confidence < 0.6 인 저신뢰 매핑
CREATE OR REPLACE VIEW jimscanner_trends_integrity_audit AS
WITH dup AS (
  -- (a) 중복 의심: 분산된 canonical 끼리 — 병합 후보
  SELECT
    'duplicate_suspect'::text AS kind,
    p1.id                     AS product_a_id,
    p1.canonical_name         AS product_a_name,
    p2.id                     AS product_b_id,
    p2.canonical_name         AS product_b_name,
    p1.category_top           AS category,
    round(similarity(p1.canonical_name, p2.canonical_name)::numeric, 3) AS score,
    jsonb_build_object(
      'a_alias_count', p1.alias_count,
      'b_alias_count', p2.alias_count,
      'a_brand', p1.brand,
      'b_brand', p2.brand,
      'a_category_mid', p1.category_mid,
      'b_category_mid', p2.category_mid,
      'a_last_seen', p1.last_seen_at,
      'b_last_seen', p2.last_seen_at
    ) AS detail
  FROM jimscanner_trends_products p1
  JOIN jimscanner_trends_products p2
    ON p1.category_top = p2.category_top
   AND p1.id < p2.id
   AND similarity(p1.canonical_name, p2.canonical_name) >= 0.45
),
hetero AS (
  -- (b) 이질 병합 의심: alias 평균 confidence 낮음 = 잘못 합쳐졌을 가능성
  SELECT
    'hetero_merge'::text AS kind,
    p.id                 AS product_a_id,
    p.canonical_name     AS product_a_name,
    NULL::uuid           AS product_b_id,
    NULL::text           AS product_b_name,
    p.category_top       AS category,
    round(avg(a.confidence)::numeric, 3) AS score,
    jsonb_build_object(
      'alias_count', count(a.id),
      'avg_confidence', round(avg(a.confidence)::numeric, 3),
      'min_confidence', round(min(a.confidence)::numeric, 3),
      'distinct_sources', count(DISTINCT a.source),
      'aliases', (array_agg(jsonb_build_object('alias', a.alias, 'confidence', a.confidence, 'source', a.source) ORDER BY a.confidence))[1:10]
    ) AS detail
  FROM jimscanner_trends_products p
  JOIN jimscanner_trends_aliases a ON a.product_id = p.id
  GROUP BY p.id, p.canonical_name, p.category_top
  HAVING count(a.id) >= 3 AND avg(a.confidence) < 0.7
),
orphan AS (
  -- (c) 고아 alias: 저신뢰 매핑 — 분리 또는 재지정 후보
  SELECT
    'orphan_alias'::text AS kind,
    p.id                 AS product_a_id,
    p.canonical_name     AS product_a_name,
    NULL::uuid           AS product_b_id,
    a.alias              AS product_b_name,
    p.category_top       AS category,
    round(a.confidence::numeric, 3) AS score,
    jsonb_build_object(
      'alias', a.alias,
      'alias_type', a.alias_type,
      'source', a.source,
      'classified_by', a.classified_by,
      'confidence', a.confidence
    ) AS detail
  FROM jimscanner_trends_aliases a
  JOIN jimscanner_trends_products p ON p.id = a.product_id
  WHERE a.confidence < 0.6
)
SELECT * FROM dup
UNION ALL SELECT * FROM hetero
UNION ALL SELECT * FROM orphan;


-- 2) alias_count 재계산 헬퍼 (병합/분리 액션 후 호출)
CREATE OR REPLACE FUNCTION jimscanner_trends_recount_aliases(p_ids uuid[])
RETURNS void AS $$
  UPDATE jimscanner_trends_products pr
  SET alias_count = (
        SELECT count(*) FROM jimscanner_trends_aliases al WHERE al.product_id = pr.id
      ),
      updated_at = now()
  WHERE pr.id = ANY(p_ids);
$$ LANGUAGE sql;
