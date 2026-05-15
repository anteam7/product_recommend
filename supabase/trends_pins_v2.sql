-- Pin 포트폴리오 헬스보드 (idea #핀-포트폴리오-헬스보드)
-- 2026-05-16
--
-- 목적:
--   기존 jimscanner_trends_pins 은 (keyword, source, notes, pinned_at) 만 가졌다.
--   진입 후 운영을 위해 핀 시점의 4점수 스냅샷을 박제하고, 시계열 점수와 조인하여
--   Δfinal/Δdimension 을 계산하는 RPC 를 추가한다.

-- 1) 컬럼 확장: 진입 시점 점수 스냅샷 + 상태
ALTER TABLE jimscanner_trends_pins
  ADD COLUMN IF NOT EXISTS entry_final_score       numeric,
  ADD COLUMN IF NOT EXISTS entry_trend_score       numeric,
  ADD COLUMN IF NOT EXISTS entry_commerce_score    numeric,
  ADD COLUMN IF NOT EXISTS entry_supplier_score    numeric,
  ADD COLUMN IF NOT EXISTS entry_competition_score numeric,
  ADD COLUMN IF NOT EXISTS entry_components_json   jsonb,
  ADD COLUMN IF NOT EXISTS product_id              uuid,
  ADD COLUMN IF NOT EXISTS status                  text NOT NULL DEFAULT 'live',
  ADD COLUMN IF NOT EXISTS exited_at               timestamptz,
  ADD COLUMN IF NOT EXISTS exit_reason             text;

-- 가능 상태: 'live' | 'exit_win' | 'exit_loss' | 'exit_dead'
-- 'live' = 추적중, exit_* = 운영자가 마킹한 사후 결과 (#15 백테스트 학습 피드)
CREATE INDEX IF NOT EXISTS jimscanner_trends_pins_status
  ON jimscanner_trends_pins(status, pinned_at DESC);

-- 2) RPC: 핀 포트폴리오 헬스
--    각 핀에 대해 (entry score vs 최신 score) 비교 + Δ 계산.
--    pin 시점 product_id 없는 항목은 jimscanner_trends_aliases(alias=keyword) 로 best-effort 매핑.
CREATE OR REPLACE FUNCTION jimscanner_pin_portfolio_health(days_window int DEFAULT 30)
RETURNS TABLE (
  keyword            text,
  source             text,
  pinned_at          timestamptz,
  status             text,
  notes              text,
  product_id         uuid,
  product_name       text,
  category_top       text,
  entry_final        numeric,
  entry_trend        numeric,
  entry_commerce     numeric,
  entry_supplier     numeric,
  entry_competition  numeric,
  current_final      numeric,
  current_trend      numeric,
  current_commerce   numeric,
  current_supplier   numeric,
  current_competition numeric,
  delta_final        numeric,
  delta_trend        numeric,
  delta_commerce     numeric,
  delta_supplier     numeric,
  delta_competition  numeric,
  days_since_pin     int,
  last_score_at      timestamptz,
  signal_alive       boolean
)
LANGUAGE sql
STABLE
AS $$
  WITH pinned AS (
    SELECT
      p.keyword,
      p.source,
      p.pinned_at,
      p.status,
      p.notes,
      p.entry_final_score       AS entry_final_stored,
      p.entry_trend_score       AS entry_trend_stored,
      p.entry_commerce_score    AS entry_commerce_stored,
      p.entry_supplier_score    AS entry_supplier_stored,
      p.entry_competition_score AS entry_competition_stored,
      COALESCE(
        p.product_id,
        (SELECT a.product_id FROM jimscanner_trends_aliases a
          WHERE a.alias = p.keyword ORDER BY a.confidence DESC NULLS LAST LIMIT 1)
      ) AS resolved_product_id
    FROM jimscanner_trends_pins p
  ),
  entry_scores AS (
    -- 핀 시점에 박제된 값이 없으면 pinned_at 이전 가장 가까운 score row 로 backfill
    SELECT
      pn.keyword,
      pn.source,
      COALESCE(pn.entry_final_stored,       s.final_score)        AS e_final,
      COALESCE(pn.entry_trend_stored,       s.trend_score)        AS e_trend,
      COALESCE(pn.entry_commerce_stored,    s.commerce_score)     AS e_commerce,
      COALESCE(pn.entry_supplier_stored,    s.supplier_score)     AS e_supplier,
      COALESCE(pn.entry_competition_stored, s.competition_score)  AS e_competition
    FROM pinned pn
    LEFT JOIN LATERAL (
      SELECT * FROM jimscanner_trends_scores ss
       WHERE ss.product_id = pn.resolved_product_id
         AND ss.computed_at <= pn.pinned_at
       ORDER BY ss.computed_at DESC
       LIMIT 1
    ) s ON true
  ),
  latest_scores AS (
    SELECT DISTINCT ON (pn.keyword, pn.source)
      pn.keyword,
      pn.source,
      s.final_score        AS c_final,
      s.trend_score        AS c_trend,
      s.commerce_score     AS c_commerce,
      s.supplier_score     AS c_supplier,
      s.competition_score  AS c_competition,
      s.computed_at        AS c_at
    FROM pinned pn
    LEFT JOIN jimscanner_trends_scores s
      ON s.product_id = pn.resolved_product_id
    ORDER BY pn.keyword, pn.source, s.computed_at DESC NULLS LAST
  )
  SELECT
    pn.keyword,
    pn.source,
    pn.pinned_at,
    pn.status,
    pn.notes,
    pn.resolved_product_id          AS product_id,
    pr.canonical_name               AS product_name,
    pr.category_top,
    es.e_final                      AS entry_final,
    es.e_trend                      AS entry_trend,
    es.e_commerce                   AS entry_commerce,
    es.e_supplier                   AS entry_supplier,
    es.e_competition                AS entry_competition,
    ls.c_final                      AS current_final,
    ls.c_trend                      AS current_trend,
    ls.c_commerce                   AS current_commerce,
    ls.c_supplier                   AS current_supplier,
    ls.c_competition                AS current_competition,
    (ls.c_final       - es.e_final)       AS delta_final,
    (ls.c_trend       - es.e_trend)       AS delta_trend,
    (ls.c_commerce    - es.e_commerce)    AS delta_commerce,
    (ls.c_supplier    - es.e_supplier)    AS delta_supplier,
    (ls.c_competition - es.e_competition) AS delta_competition,
    GREATEST(0, EXTRACT(EPOCH FROM (now() - pn.pinned_at))::int / 86400) AS days_since_pin,
    ls.c_at AS last_score_at,
    (ls.c_at IS NOT NULL AND ls.c_at > now() - make_interval(days => days_window)) AS signal_alive
  FROM pinned pn
  LEFT JOIN entry_scores  es ON es.keyword = pn.keyword AND es.source = pn.source
  LEFT JOIN latest_scores ls ON ls.keyword = pn.keyword AND ls.source = pn.source
  LEFT JOIN jimscanner_trends_products pr ON pr.id = pn.resolved_product_id
  ORDER BY pn.pinned_at DESC;
$$;

GRANT EXECUTE ON FUNCTION jimscanner_pin_portfolio_health(int) TO service_role;
