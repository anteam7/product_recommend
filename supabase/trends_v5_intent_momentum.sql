-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v5 — 구매의도 전환 모멘텀 (intent momentum, 2026-06-02)
-- ─────────────────────────────────────────────────────────────
-- 목적: jimscanner_trends_keywords.classified_intent (informational /
--   commercial / transactional / navigational) 는 이미 시계열로 쌓이지만,
--   기존 4점수(trend/commerce/supplier/competition)는 '의도 구성비의
--   시간 변화'를 점수에 반영하지 않는다.
--
-- 이 마이그레이션은 product_id 별로 rolling 7d / 직전 7d window 의
--   "거래의도 비중(transactional+commercial)" 과 그 비중의 velocity
--   (전환가속도 = 최근7d − 직전7d, 단위 %p) 를 계산하는 RPC 를 추가한다.
--
-- product ↔ keyword 연결: jimscanner_trends_aliases(alias_type='keyword')
--   의 alias 가 jimscanner_trends_keywords.keyword 와 매칭된다.
--
-- 노출 정책: 기존 jimscanner_trends_* 와 동일 (service-role 만 접근).
-- 관련: supabase/trends_v4_seller_tools.sql, supabase/trends.sql
-- ─────────────────────────────────────────────────────────────


-- ─────────────────────────────────────────────────────────────
-- 1) RPC: jimscanner_intent_momentum
--    각 product 의 거래의도 비중 / velocity / base 를 반환.
--    UI 스캐터: x = txn_share_7d, y = velocity.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_intent_momentum(
  p_min_signals int DEFAULT 3   -- 최근 14d 동안 최소 분류 시그널 수 (노이즈 컷)
)
RETURNS TABLE (
  product_id      uuid,
  canonical_name  text,
  category_top    text,
  category_mid    text,
  -- 거래의도(transactional+commercial) 비중, 0~100
  txn_share_7d    numeric,
  txn_share_prev  numeric,    -- 직전 7d (8~14d 전)
  base_share      numeric,    -- 베이스라인 (8~30d 전)
  velocity        numeric,    -- 전환가속도 = txn_share_7d − txn_share_prev (%p)
  signals_7d      int,        -- 최근 7d 분류 시그널 수
  signals_total   int,        -- 최근 14d 분류 시그널 수
  -- 의도 mix (최근 7d) — 스택바/스파크라인용, 0~100
  mix_informational numeric,
  mix_commercial    numeric,
  mix_transactional numeric,
  mix_navigational  numeric,
  has_ggsan       boolean     -- 소싱 가능 여부 (supplier 매칭 존재)
)
LANGUAGE sql
STABLE
AS $$
  WITH kw AS (
    -- product 에 매핑된 keyword 의 분류 시계열 (최근 30d)
    SELECT
      a.product_id,
      k.classified_intent AS intent,
      k.collected_at,
      (now() - k.collected_at) AS age
    FROM jimscanner_trends_aliases a
    JOIN jimscanner_trends_keywords k
      ON k.keyword = a.alias
    WHERE a.alias_type = 'keyword'
      AND k.classified_intent IS NOT NULL
      AND k.collected_at >= now() - interval '30 days'
  ),
  agg AS (
    SELECT
      product_id,
      -- 최근 7d
      count(*) FILTER (WHERE age <= interval '7 days')                                   AS n7,
      count(*) FILTER (WHERE age <= interval '7 days'
                          AND intent IN ('transactional','commercial'))                  AS txn7,
      -- 직전 7d (8~14d)
      count(*) FILTER (WHERE age > interval '7 days' AND age <= interval '14 days')       AS nprev,
      count(*) FILTER (WHERE age > interval '7 days' AND age <= interval '14 days'
                          AND intent IN ('transactional','commercial'))                  AS txnprev,
      -- base (8~30d)
      count(*) FILTER (WHERE age > interval '7 days' AND age <= interval '30 days')        AS nbase,
      count(*) FILTER (WHERE age > interval '7 days' AND age <= interval '30 days'
                          AND intent IN ('transactional','commercial'))                  AS txnbase,
      -- mix (최근 7d)
      count(*) FILTER (WHERE age <= interval '7 days' AND intent = 'informational')        AS m_info,
      count(*) FILTER (WHERE age <= interval '7 days' AND intent = 'commercial')           AS m_comm,
      count(*) FILTER (WHERE age <= interval '7 days' AND intent = 'transactional')        AS m_txn,
      count(*) FILTER (WHERE age <= interval '7 days' AND intent = 'navigational')         AS m_nav,
      count(*) FILTER (WHERE age <= interval '14 days')                                    AS ntotal
    FROM kw
    GROUP BY product_id
  )
  SELECT
    p.id AS product_id,
    p.canonical_name,
    p.category_top,
    p.category_mid,
    ROUND(CASE WHEN agg.n7    > 0 THEN 100.0 * agg.txn7    / agg.n7    ELSE 0 END, 1) AS txn_share_7d,
    ROUND(CASE WHEN agg.nprev > 0 THEN 100.0 * agg.txnprev / agg.nprev ELSE 0 END, 1) AS txn_share_prev,
    ROUND(CASE WHEN agg.nbase > 0 THEN 100.0 * agg.txnbase / agg.nbase ELSE 0 END, 1) AS base_share,
    ROUND(
      (CASE WHEN agg.n7    > 0 THEN 100.0 * agg.txn7    / agg.n7    ELSE 0 END)
      - (CASE WHEN agg.nprev > 0 THEN 100.0 * agg.txnprev / agg.nprev ELSE 0 END)
    , 1) AS velocity,
    agg.n7::int     AS signals_7d,
    agg.ntotal::int AS signals_total,
    ROUND(CASE WHEN agg.n7 > 0 THEN 100.0 * agg.m_info / agg.n7 ELSE 0 END, 1) AS mix_informational,
    ROUND(CASE WHEN agg.n7 > 0 THEN 100.0 * agg.m_comm / agg.n7 ELSE 0 END, 1) AS mix_commercial,
    ROUND(CASE WHEN agg.n7 > 0 THEN 100.0 * agg.m_txn  / agg.n7 ELSE 0 END, 1) AS mix_transactional,
    ROUND(CASE WHEN agg.n7 > 0 THEN 100.0 * agg.m_nav  / agg.n7 ELSE 0 END, 1) AS mix_navigational,
    EXISTS (
      SELECT 1 FROM jimscanner_trends_supplier s WHERE s.product_id = p.id
    ) AS has_ggsan
  FROM agg
  JOIN jimscanner_trends_products p ON p.id = agg.product_id
  WHERE agg.ntotal >= p_min_signals
  ORDER BY velocity DESC;
$$;


-- ─────────────────────────────────────────────────────────────
-- 2) recompute_scores 확장 메모 (score_components.intent_shift)
-- ─────────────────────────────────────────────────────────────
-- 점수 재계산 cron(또는 survey 스크립트)이 jimscanner_trends_scores 를
-- 적재할 때, 위 RPC 결과를 product_id 별로 join 해서
-- score_components 에 아래 형태로 함께 적재한다:
--
--   "intent_shift": {
--     "txn_share_7d":  62.5,
--     "txn_share_prev":41.0,
--     "base_share":    38.2,
--     "velocity":      21.5,      -- %p (양수 = 거래단계로 가속)
--     "signals_7d":    9,
--     "mix": {"informational":20,"commercial":35,"transactional":40,"navigational":5}
--   }
--
-- '막 거래단계 진입' 트리거: base_share 가 낮고(<40) velocity 가 높음(>15).
-- commerce_score 보정 항으로 velocity 를 가산(클램프 0~100)하는 방안은
-- recompute cron 구현 시점에 결정 (UI 는 RPC 를 직접 호출하므로 비차단).
