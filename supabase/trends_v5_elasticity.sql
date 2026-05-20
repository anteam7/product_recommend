-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v5 — 가격탄력성(ε) 추정 (2026-05-20)
-- ─────────────────────────────────────────────────────────────
-- 목적: 동일 product_id 에 매핑된 multi-supplier 가격포인트(도매꾹·1688·알리·temu)
--       × 시점별 수요지표(commerce_score) 로 log-log 회귀 (ln Q = α + ε·ln P)
--       하여 가격탄력성 ε 을 추정한다.
-- 운영: 일 1회 recompute. snapshot table 이라 매 실행마다 전체 truncate + 재삽입.
-- 적재: service-role 만 (RLS enable, 정책 없음).
-- 관련: docs/trend-radar-v4-execution-plan.md, supabase/trends_v4_seller_tools.sql
-- ─────────────────────────────────────────────────────────────


-- 1) Elasticity snapshot (product_id 당 최신 추정 1행)
CREATE TABLE IF NOT EXISTS jimscanner_trends_elasticity (
  product_id uuid PRIMARY KEY REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  epsilon numeric,                     -- 가격탄력성. NULL = 추정불가.
  std_err numeric,                     -- SE(ε)
  r2 numeric,                          -- 결정계수
  sample_n int NOT NULL DEFAULT 0,     -- 회귀에 사용된 (P,Q) pair 수
  price_min numeric,                   -- 표본 최소 가격 (KRW)
  price_max numeric,                   -- 표본 최대 가격 (KRW)

  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_elasticity_epsilon
  ON jimscanner_trends_elasticity(epsilon);

CREATE INDEX IF NOT EXISTS jimscanner_trends_elasticity_sample_n
  ON jimscanner_trends_elasticity(sample_n DESC);

ALTER TABLE jimscanner_trends_elasticity ENABLE ROW LEVEL SECURITY;


-- 2) Recompute RPC
--    원리: supplier 가격은 (product, supplier_source) 별 시점이 다르므로
--          일 단위 평균으로 정규화 → score(commerce_score) 의 일 단위 평균과 join
--          → 동일 product 의 (ln P, ln Q) 쌍 ≥3건이면 OLS 회귀.
--    PostgreSQL aggregate `regr_slope / regr_r2 / regr_sxx / regr_syy / regr_count` 사용.
--    SE(ε)² = (1 - r²) * Σ(Q - Q̄)² / ((n-2) * Σ(P - P̄)²)
CREATE OR REPLACE FUNCTION recompute_elasticity()
RETURNS TABLE(product_id uuid, sample_n int, epsilon numeric, r2 numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 전체 재계산 (snapshot 방식)
  DELETE FROM jimscanner_trends_elasticity;

  WITH supplier_daily AS (
    SELECT
      s.product_id AS pid,
      date_trunc('day', s.collected_at) AS day,
      AVG(s.price_krw) AS price_krw
    FROM jimscanner_trends_supplier s
    WHERE s.price_krw IS NOT NULL
      AND s.price_krw > 0
    GROUP BY s.product_id, date_trunc('day', s.collected_at)
  ),
  score_daily AS (
    SELECT
      sc.product_id AS pid,
      date_trunc('day', sc.computed_at) AS day,
      AVG(sc.commerce_score) AS commerce_score
    FROM jimscanner_trends_scores sc
    WHERE sc.commerce_score > 0
    GROUP BY sc.product_id, date_trunc('day', sc.computed_at)
  ),
  joined AS (
    SELECT
      sd.pid,
      ln(sd.price_krw) AS ln_p,
      ln(scd.commerce_score) AS ln_q,
      sd.price_krw
    FROM supplier_daily sd
    JOIN score_daily scd ON scd.pid = sd.pid AND scd.day = sd.day
  ),
  regressed AS (
    SELECT
      pid,
      regr_slope(ln_q, ln_p) AS epsilon,
      regr_r2(ln_q, ln_p) AS r2,
      regr_count(ln_q, ln_p)::int AS sample_n,
      regr_sxx(ln_q, ln_p) AS sxx,
      regr_syy(ln_q, ln_p) AS syy,
      MIN(price_krw) AS price_min,
      MAX(price_krw) AS price_max
    FROM joined
    GROUP BY pid
    HAVING regr_count(ln_q, ln_p) >= 3
       AND regr_sxx(ln_q, ln_p) > 0
  )
  INSERT INTO jimscanner_trends_elasticity
    (product_id, epsilon, std_err, r2, sample_n, price_min, price_max, computed_at)
  SELECT
    r.pid,
    r.epsilon,
    CASE
      WHEN r.sample_n > 2 AND r.sxx > 0 AND r.r2 IS NOT NULL
      THEN sqrt(GREATEST(((1::numeric - r.r2) * r.syy) / ((r.sample_n - 2)::numeric * r.sxx), 0::numeric))
      ELSE NULL
    END,
    r.r2,
    r.sample_n,
    r.price_min,
    r.price_max,
    now()
  FROM regressed r;

  RETURN QUERY
    SELECT e.product_id, e.sample_n, e.epsilon, e.r2
    FROM jimscanner_trends_elasticity e
    ORDER BY e.sample_n DESC NULLS LAST, e.epsilon ASC NULLS LAST;
END;
$$;

COMMENT ON FUNCTION recompute_elasticity() IS
  '동일 product 의 supplier 가격 × commerce_score 일별 시계열로 log-log OLS 를 돌려 ε 을 추정. snapshot.';
