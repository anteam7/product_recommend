-- ────────────────────────────────────────────────────────────
-- 콜드스타트 신상 조기포착 RPC (V0, 2026-06-05)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/newcomers
-- 문제:
--   recompute 의 final_score 는 trend_score(점수 시계열 velocity)에 의존.
--   이력이 얇은 신상은 velocity 가 0/미정의로 잡혀 성숙 상품에 매몰됨
--   (= 이미 떴을 때만 보임 → 소싱 타이밍 지각).
-- 해법:
--   first_seen_at 이 최근 hours_window 시간 내인 신규 canonical product 를
--   트래젝토리(velocity) 없이 '연령 정규화 cold-start 점수' 로 별도 랭킹.
--   초기 신호: 등장 직후 윈도우 내 alias 출처 폭(distinct source) ·
--              초기 다출처 합의(early consensus) · commerce/supplier_score.
-- 노출 정책: service-role 만 (기존 jimscanner_* 패턴과 동일).
-- 관련: supabase/trends_v4_seller_tools.sql, supabase/ggsan_recommend_rpc.sql
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_newcomer_radar(
  hours_window int DEFAULT 72,
  min_sources  int DEFAULT 1,
  ggsan_min_sim float DEFAULT 0.30,
  result_limit int DEFAULT 100
)
RETURNS TABLE (
  product_id uuid,
  canonical_name text,
  category_top text,
  category_mid text,
  brand text,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  age_hours real,
  alias_count int,
  -- 초기 신호
  source_count int,        -- 윈도우 내 등장한 distinct alias source 수
  sources text[],          -- 출처 목록
  early_consensus int,     -- 윈도우 내(등장 직후) 생성된 alias 수
  commerce_score real,     -- 최신 score 컴포넌트
  supplier_score real,
  -- ggsan 소싱 매칭
  ggsan_match boolean,
  ggsan_top_title text,
  -- 연령 정규화 cold-start 점수 (정렬키)
  recency real,            -- 0~1 (1 = 방금 등장)
  cold_start_score real
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  -- 1) 최근 hours_window 시간 내 첫 등장한 신상만
  newbies AS (
    SELECT
      p.id, p.canonical_name, p.category_top, p.category_mid, p.brand,
      p.first_seen_at, p.last_seen_at, p.alias_count,
      EXTRACT(EPOCH FROM (now() - p.first_seen_at)) / 3600.0 AS age_h
    FROM jimscanner_trends_products p
    WHERE p.first_seen_at > now() - (hours_window || ' hours')::interval
  ),
  -- 2) alias 출처 폭 + 초기 다출처 합의
  --    등장 직후 윈도우 내 생성된 alias 만 (초기 신호 한정)
  alias_sig AS (
    SELECT
      a.product_id,
      COUNT(DISTINCT a.source)::int AS source_count,
      ARRAY_AGG(DISTINCT a.source) FILTER (WHERE a.source IS NOT NULL) AS sources,
      COUNT(*)::int AS early_consensus
    FROM jimscanner_trends_aliases a
    JOIN newbies n ON n.id = a.product_id
    WHERE a.created_at <= n.first_seen_at + (hours_window || ' hours')::interval
    GROUP BY a.product_id
  ),
  -- 3) 최신 score 컴포넌트 (trend/velocity 는 의도적으로 배제)
  latest_score AS (
    SELECT DISTINCT ON (s.product_id)
      s.product_id, s.commerce_score, s.supplier_score
    FROM jimscanner_trends_scores s
    JOIN newbies n ON n.id = s.product_id
    ORDER BY s.product_id, s.computed_at DESC
  ),
  -- 4) ggsan 도매 매칭 (canonical_name trigram)
  ggsan AS (
    SELECT
      n.id AS product_id,
      gp.title AS ggsan_top_title
    FROM newbies n
    CROSS JOIN LATERAL (
      SELECT g.title
      FROM jimscanner_ggsan_products g
      WHERE g.title % n.canonical_name
      ORDER BY similarity(g.title, n.canonical_name) DESC
      LIMIT 1
    ) gp
    WHERE similarity(gp.ggsan_top_title, n.canonical_name) >= ggsan_min_sim
  ),
  assembled AS (
    SELECT
      n.id AS product_id,
      n.canonical_name, n.category_top, n.category_mid, n.brand,
      n.first_seen_at, n.last_seen_at, n.age_h::real AS age_hours, n.alias_count,
      COALESCE(asig.source_count, 0) AS source_count,
      COALESCE(asig.sources, ARRAY[]::text[]) AS sources,
      COALESCE(asig.early_consensus, 0) AS early_consensus,
      COALESCE(ls.commerce_score, 0)::real AS commerce_score,
      COALESCE(ls.supplier_score, 0)::real AS supplier_score,
      (gg.product_id IS NOT NULL) AS ggsan_match,
      COALESCE(gg.ggsan_top_title, '') AS ggsan_top_title,
      -- 연령 정규화: 방금 등장(age=0) → 1, 윈도우 끝 → 0
      GREATEST(0.0, 1.0 - (n.age_h / GREATEST(hours_window::real, 1.0)))::real AS recency
    FROM newbies n
    LEFT JOIN alias_sig asig ON asig.product_id = n.id
    LEFT JOIN latest_score ls ON ls.product_id = n.id
    LEFT JOIN ggsan gg ON gg.product_id = n.id
  )
  SELECT
    a.product_id, a.canonical_name, a.category_top, a.category_mid, a.brand,
    a.first_seen_at, a.last_seen_at, a.age_hours, a.alias_count,
    a.source_count, a.sources, a.early_consensus,
    a.commerce_score, a.supplier_score,
    a.ggsan_match, a.ggsan_top_title,
    a.recency,
    -- cold-start 점수: 초기 신호 강도 × 연령 정규화 가중
    --   출처 폭(가장 강한 cold-start 시그널) + 초기 합의 + 커머스/공급 + ggsan 보너스
    (
      (
        LEAST(a.source_count, 6) * 14.0
        + LEAST(a.early_consensus, 10) * 3.0
        + a.commerce_score * 0.25
        + a.supplier_score * 0.25
        + (CASE WHEN a.ggsan_match THEN 12.0 ELSE 0.0 END)
      ) * (0.4 + 0.6 * a.recency)
    )::real AS cold_start_score
  FROM assembled a
  WHERE a.source_count >= min_sources
  ORDER BY cold_start_score DESC, a.first_seen_at DESC
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출
REVOKE ALL ON FUNCTION jimscanner_newcomer_radar(int, int, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_newcomer_radar(int, int, float, int) TO service_role;
