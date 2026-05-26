-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — Seed-level Yield & Auto-Prune (2026-05-26)
-- ─────────────────────────────────────────────────────────────
-- 목적:
--   * jimscanner_trends_seeds 의 각 row(카테고리 cid 1개 / keyword_group 1개)
--     단위로 30/90일 수율을 가시화.
--   * '90일 0 pin & 30일 0 신규 매칭 키워드' 시드는 휴면 큐로 제안.
--   * collectors 가 trends_runs 에 triggered_seed_id 를 함께 기록하도록 컬럼 추가.
-- ─────────────────────────────────────────────────────────────

-- 1) trends_runs 에 seed-level 어트리뷰션 컬럼 추가
ALTER TABLE jimscanner_trends_runs
  ADD COLUMN IF NOT EXISTS triggered_seed_id uuid
  REFERENCES jimscanner_trends_seeds(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS jimscanner_trends_runs_seed_at
  ON jimscanner_trends_runs(triggered_seed_id, started_at DESC)
  WHERE triggered_seed_id IS NOT NULL;

-- 2) Seed × Run yield 집계 뷰 (30/90 일)
DROP VIEW IF EXISTS jimscanner_trends_seeds_yield_30d;

CREATE OR REPLACE VIEW jimscanner_trends_seeds_yield_30d AS
WITH r30 AS (
  SELECT
    triggered_seed_id AS seed_id,
    COUNT(*)::int                 AS runs_30d,
    SUM(inserted_count)::int      AS inserted_30d,
    SUM(fetched_count)::int       AS fetched_30d,
    COUNT(*) FILTER (WHERE status = 'error')::int AS errors_30d,
    MAX(started_at)               AS last_run_at
  FROM jimscanner_trends_runs
  WHERE triggered_seed_id IS NOT NULL
    AND started_at > now() - interval '30 days'
  GROUP BY triggered_seed_id
),
r90 AS (
  SELECT
    triggered_seed_id AS seed_id,
    COUNT(*)::int             AS runs_90d,
    SUM(inserted_count)::int  AS inserted_90d
  FROM jimscanner_trends_runs
  WHERE triggered_seed_id IS NOT NULL
    AND started_at > now() - interval '90 days'
  GROUP BY triggered_seed_id
),
-- 시드 config 로 trends_keywords 베스트-에포트 매칭
-- (category seed → category_top = config.name, keyword_group seed → keyword IN config.keywords)
seed_kw_30d AS (
  SELECT
    s.id AS seed_id,
    COUNT(*)::int AS matched_keywords_30d
  FROM jimscanner_trends_seeds s
  JOIN jimscanner_trends_keywords k
    ON k.source = s.source
   AND k.created_at > now() - interval '30 days'
   AND (
     (s.kind = 'category'      AND k.category_top = (s.config->>'name'))
     OR (s.kind = 'keyword_group' AND k.keyword IN (
           SELECT jsonb_array_elements_text(s.config->'keywords')))
   )
  GROUP BY s.id
),
seed_pins_30d AS (
  SELECT s.id AS seed_id, COUNT(DISTINCT p.keyword)::int AS pinned_30d
  FROM jimscanner_trends_seeds s
  JOIN jimscanner_trends_pins p
    ON p.source = s.source
   AND p.pinned_at > now() - interval '30 days'
   AND (
     (s.kind = 'category' AND p.keyword IN (
        SELECT k.keyword FROM jimscanner_trends_keywords k
        WHERE k.source = s.source AND k.category_top = (s.config->>'name')))
     OR (s.kind = 'keyword_group' AND p.keyword IN (
        SELECT jsonb_array_elements_text(s.config->'keywords')))
   )
  GROUP BY s.id
),
seed_pins_90d AS (
  SELECT s.id AS seed_id, COUNT(DISTINCT p.keyword)::int AS pinned_90d
  FROM jimscanner_trends_seeds s
  JOIN jimscanner_trends_pins p
    ON p.source = s.source
   AND p.pinned_at > now() - interval '90 days'
   AND (
     (s.kind = 'category' AND p.keyword IN (
        SELECT k.keyword FROM jimscanner_trends_keywords k
        WHERE k.source = s.source AND k.category_top = (s.config->>'name')))
     OR (s.kind = 'keyword_group' AND p.keyword IN (
        SELECT jsonb_array_elements_text(s.config->'keywords')))
   )
  GROUP BY s.id
)
SELECT
  s.id            AS seed_id,
  s.source,
  s.kind,
  s.label,
  s.config,
  s.is_active,
  s.display_order,
  COALESCE(r30.runs_30d, 0)              AS runs_30d,
  COALESCE(r30.inserted_30d, 0)          AS inserted_30d,
  COALESCE(r30.fetched_30d, 0)           AS fetched_30d,
  COALESCE(r30.errors_30d, 0)            AS errors_30d,
  r30.last_run_at,
  COALESCE(r90.runs_90d, 0)              AS runs_90d,
  COALESCE(r90.inserted_90d, 0)          AS inserted_90d,
  COALESCE(skw30.matched_keywords_30d, 0) AS matched_keywords_30d,
  COALESCE(sp30.pinned_30d, 0)           AS pinned_30d,
  COALESCE(sp90.pinned_90d, 0)           AS pinned_90d,
  -- Cost-per-Pin 추정치: inserted_90d / NULLIF(pinned_90d, 0)
  -- (실제 API/LLM 비용은 호출당 고정으로 가정)
  CASE
    WHEN COALESCE(sp90.pinned_90d, 0) = 0 THEN NULL
    ELSE ROUND(COALESCE(r90.inserted_90d, 0)::numeric / sp90.pinned_90d, 2)
  END AS inserted_per_pin_90d,
  -- 휴면 후보 룰: active 시드인데 90일 동안 pin 0 AND 30일 동안 신규 매칭 0
  (
    s.is_active
    AND COALESCE(sp90.pinned_90d, 0) = 0
    AND COALESCE(skw30.matched_keywords_30d, 0) = 0
  ) AS prune_candidate
FROM jimscanner_trends_seeds s
LEFT JOIN r30          ON r30.seed_id  = s.id
LEFT JOIN r90          ON r90.seed_id  = s.id
LEFT JOIN seed_kw_30d  skw30 ON skw30.seed_id = s.id
LEFT JOIN seed_pins_30d sp30 ON sp30.seed_id = s.id
LEFT JOIN seed_pins_90d sp90 ON sp90.seed_id = s.id;

COMMENT ON VIEW jimscanner_trends_seeds_yield_30d IS
  '시드 단위 30/90일 수율 보드 — runs/inserted 는 trends_runs.triggered_seed_id 정확 어트리뷰션, ' ||
  'pin/matched 는 config(name/keywords) ↔ trends_keywords/trends_pins best-effort 조인.';
