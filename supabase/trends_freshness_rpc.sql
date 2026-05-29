-- ────────────────────────────────────────────────────────────
-- 신선도 보정 점수 RPC (Stale-Evidence Decay, 2026-05-29)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/freshness
-- 문제: opportunity/recommend 보드는 jimscanner_trends_scores.final_score 만
--       그대로 신뢰한다. 그러나 점수 근거(증거)의 신선도는 소스별로 제각각이며
--       (예: tvtime 04:38, shopping_insight 07:08, naver 계열 error=2),
--       며칠 전 단일 1관측에 의존한 점수와 오늘 다수 소스가 받쳐주는 점수가
--       동일하게 보인다.
-- 해법:
--   (1) 각 product 의 기여 증거 나이 계산
--       — aliases.created_at / source, supplier.collected_at, scores.computed_at
--   (2) 나이 기반 지수 감쇠 계수로 final_score 보정 → freshness_adjusted_score
--       decay = exp( -ln(2) * age_days / half_life_days )   (반감기 모델)
--   (3) 드라이버 소스가 jimscanner_trends_runs 에서 현재 error/partial 면
--       '증거 동결(frozen)' 플래그 + 동결 소스 목록
--   (4) 원점수↔보정점수 델타(delta) 로 'Stale-but-High' 판별
-- 적용: psql + PGPASSWORD (Connection Pooler 6543). 적용은 사람이 수행.
-- 타입: gen:types 전까지 page 에서 `as any` 캐스팅.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_trends_freshness(
  half_life_days float DEFAULT 3.0,   -- 증거 반감기 (일). 3일 = 3일마다 가중치 절반
  result_limit int DEFAULT 300
)
RETURNS TABLE (
  product_id uuid,
  product_name text,
  category_top text,
  final_score numeric,
  computed_at timestamptz,
  alias_count int,
  latest_alias_at timestamptz,
  alias_sources text[],
  supplier_count int,
  latest_supplier_at timestamptz,
  evidence_age_hours numeric,         -- 가장 신선한 증거의 나이(시간)
  oldest_evidence_age_hours numeric,  -- 가장 낡은 증거의 나이(시간)
  decay_factor numeric,               -- 0~1 신선도 가중치
  freshness_adjusted_score numeric,   -- final_score × decay_factor
  delta numeric,                      -- final_score − freshness_adjusted_score (클수록 낡음)
  frozen boolean,                     -- 드라이버 소스가 현재 error/partial
  frozen_sources text[]               -- 동결된 소스 목록
)
LANGUAGE sql
STABLE
AS $$
WITH latest_scores AS (
  SELECT DISTINCT ON (s.product_id)
    s.product_id, s.final_score, s.computed_at
  FROM jimscanner_trends_scores s
  ORDER BY s.product_id, s.computed_at DESC
),
alias_agg AS (
  SELECT
    a.product_id,
    count(*)::int AS alias_count,
    max(a.created_at) AS latest_alias_at,
    array_agg(DISTINCT a.source) FILTER (WHERE a.source IS NOT NULL) AS alias_sources
  FROM jimscanner_trends_aliases a
  GROUP BY a.product_id
),
supplier_agg AS (
  SELECT
    sp.product_id,
    count(*)::int AS supplier_count,
    max(sp.collected_at) AS latest_supplier_at
  FROM jimscanner_trends_supplier sp
  GROUP BY sp.product_id
),
latest_runs AS (
  SELECT DISTINCT ON (r.source)
    r.source, r.status, r.started_at
  FROM jimscanner_trends_runs r
  ORDER BY r.source, r.started_at DESC
),
base AS (
  SELECT
    ls.product_id,
    p.canonical_name AS product_name,
    p.category_top,
    ls.final_score,
    ls.computed_at,
    COALESCE(aa.alias_count, 0) AS alias_count,
    aa.latest_alias_at,
    COALESCE(aa.alias_sources, ARRAY[]::text[]) AS alias_sources,
    COALESCE(sa.supplier_count, 0) AS supplier_count,
    sa.latest_supplier_at,
    -- 증거 후보 3종 중 가장 신선한 / 가장 낡은 시각
    GREATEST(
      COALESCE(aa.latest_alias_at, ls.computed_at),
      COALESCE(sa.latest_supplier_at, ls.computed_at),
      ls.computed_at
    ) AS freshest_at,
    LEAST(
      COALESCE(aa.latest_alias_at, ls.computed_at),
      COALESCE(sa.latest_supplier_at, ls.computed_at),
      ls.computed_at
    ) AS oldest_at
  FROM latest_scores ls
  JOIN jimscanner_trends_products p ON p.id = ls.product_id
  LEFT JOIN alias_agg aa ON aa.product_id = ls.product_id
  LEFT JOIN supplier_agg sa ON sa.product_id = ls.product_id
)
SELECT
  b.product_id,
  b.product_name,
  b.category_top,
  b.final_score,
  b.computed_at,
  b.alias_count,
  b.latest_alias_at,
  b.alias_sources,
  b.supplier_count,
  b.latest_supplier_at,
  (EXTRACT(EPOCH FROM (now() - b.freshest_at)) / 3600.0)::numeric AS evidence_age_hours,
  (EXTRACT(EPOCH FROM (now() - b.oldest_at)) / 3600.0)::numeric AS oldest_evidence_age_hours,
  exp(
    -ln(2) * (EXTRACT(EPOCH FROM (now() - b.freshest_at)) / 86400.0) / NULLIF(half_life_days, 0)
  )::numeric AS decay_factor,
  (b.final_score * exp(
    -ln(2) * (EXTRACT(EPOCH FROM (now() - b.freshest_at)) / 86400.0) / NULLIF(half_life_days, 0)
  ))::numeric AS freshness_adjusted_score,
  (b.final_score - b.final_score * exp(
    -ln(2) * (EXTRACT(EPOCH FROM (now() - b.freshest_at)) / 86400.0) / NULLIF(half_life_days, 0)
  ))::numeric AS delta,
  EXISTS (
    SELECT 1 FROM latest_runs lr
    WHERE lr.status IN ('error', 'partial')
      AND EXISTS (
        SELECT 1 FROM unnest(b.alias_sources) AS src
        WHERE src = lr.source
           OR src ILIKE '%' || lr.source || '%'
           OR lr.source ILIKE '%' || src || '%'
      )
  ) AS frozen,
  COALESCE((
    SELECT array_agg(DISTINCT lr.source)
    FROM latest_runs lr
    WHERE lr.status IN ('error', 'partial')
      AND EXISTS (
        SELECT 1 FROM unnest(b.alias_sources) AS src
        WHERE src = lr.source
           OR src ILIKE '%' || lr.source || '%'
           OR lr.source ILIKE '%' || src || '%'
      )
  ), ARRAY[]::text[]) AS frozen_sources
FROM base b
ORDER BY b.final_score DESC
LIMIT result_limit;
$$;

-- 권한: 어드민 service-role 로 호출 (RLS 우회). anon 차단.
REVOKE ALL ON FUNCTION jimscanner_trends_freshness(float, int) FROM PUBLIC;
