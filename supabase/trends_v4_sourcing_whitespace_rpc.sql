-- ────────────────────────────────────────────────────────────
-- 소싱 공백 RPC — 수요검증·도매미연결 상품 우선 발굴 (PR-WHITESPACE-1, 2026-05-30)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/sourcing-gap 페이지
--
-- 13번(임계직하 액션큐)과 달리 '점수 임계'가 아니라 '공급 커버리지 부재'를
-- 조직축으로 삼는 역(逆)조인 지도. 입증 수요(trend_score·commerce_score 검증)는 있는데
-- 도매 소싱 경로(jimscanner_trends_supplier + ggsan 카탈로그)가 없는 상품을 집계한다.
--
-- 흐름:
--   ① jimscanner_trends_scores 최신 점수 (DISTINCT ON product_id, computed_at DESC)
--   ② trend_score·commerce_score 임계 통과 = '수요 검증' 후보
--   ③ jimscanner_trends_supplier LEFT JOIN — 마진을 안 깨는 viable supplier 존재 여부
--   ④ ggsan 카탈로그 pg_trgm fuzzy (canonical_name % title) — 가장 근접한 후보 3개
--   ⑤ viable supplier 0건 AND ggsan 강매칭(>= connect_sim) 부재 = '소싱 공백'
--
-- service_role 로만 호출 (어드민 한정) — SECURITY DEFINER + grant 명시
-- 의존: pg_trgm (trends_v4_ggsan.sql 에서 생성)
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_sourcing_whitespace(
  days_window    int   DEFAULT 30,     -- 점수 최신성 윈도우 (computed_at)
  min_trend      numeric DEFAULT 50,   -- 수요 검증: trend_score 임계
  min_commerce   numeric DEFAULT 50,   -- 수요 검증: commerce_score 임계
  connect_sim    float DEFAULT 0.35,   -- 이 이상 ggsan 매칭이면 '연결됨'으로 간주
  cand_sim       float DEFAULT 0.15,   -- 근접 후보 노출 최소 유사도
  max_moq        int   DEFAULT 1,      -- 위탁 1인셀러: MOQ 1 초과면 마진/현금흐름 깸
  max_lead_days  int   DEFAULT 10,     -- 리드타임 임계 (초과 시 viable 아님)
  result_limit   int   DEFAULT 200
)
RETURNS TABLE (
  product_id      uuid,
  canonical_name  text,
  category_top    text,
  category_mid    text,
  brand           text,
  trend_score     numeric,
  commerce_score  numeric,
  supplier_score  numeric,
  final_score     numeric,
  computed_at     timestamptz,
  demand_score    numeric,       -- trend + commerce (정렬·랭킹용)
  supplier_count  int,           -- 전체 supplier row 수
  viable_supplier_count int,     -- 마진 안 깨는 supplier 수 (moq/lead 통과)
  best_ggsan_sim  real,          -- 가장 근접한 ggsan 후보 유사도
  ggsan_candidates jsonb,        -- 근접 ggsan 후보 top 3 (goods_no,title,price,sim,...)
  is_whitespace   boolean        -- 수요검증 O + 공급경로 X
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH latest_scores AS (
    -- 상품별 최신 점수 row
    SELECT DISTINCT ON (s.product_id)
      s.product_id, s.trend_score, s.commerce_score, s.supplier_score,
      s.final_score, s.computed_at
    FROM jimscanner_trends_scores s
    WHERE s.computed_at > now() - (days_window || ' days')::interval
    ORDER BY s.product_id, s.computed_at DESC
  ),
  validated AS (
    -- 수요 검증 통과 후보 (trend·commerce 임계 동시 통과)
    SELECT
      p.id AS product_id, p.canonical_name, p.category_top, p.category_mid, p.brand,
      ls.trend_score, ls.commerce_score, ls.supplier_score, ls.final_score, ls.computed_at
    FROM latest_scores ls
    JOIN jimscanner_trends_products p ON p.id = ls.product_id
    WHERE ls.trend_score >= min_trend
      AND ls.commerce_score >= min_commerce
  ),
  supplier_agg AS (
    -- supplier 연결 집계 (viable = moq/lead 마진 안 깸)
    SELECT
      sup.product_id,
      COUNT(*)::int AS supplier_count,
      COUNT(*) FILTER (
        WHERE (sup.moq IS NULL OR sup.moq <= max_moq)
          AND (sup.lead_time_days IS NULL OR sup.lead_time_days <= max_lead_days)
      )::int AS viable_supplier_count
    FROM jimscanner_trends_supplier sup
    GROUP BY sup.product_id
  ),
  ggsan_match AS (
    -- canonical_name 기준 ggsan 카탈로그 fuzzy 매칭 top 3 (pg_trgm % 인덱스 활용)
    SELECT
      v.product_id,
      MAX(g.sim) AS best_ggsan_sim,
      jsonb_agg(
        jsonb_build_object(
          'goods_no', g.goods_no,
          'title', g.title,
          'price_krw', g.price_krw,
          'cate_label', g.cate_label,
          'image_url', g.image_url,
          'detail_url', g.detail_url,
          'is_imminent', g.is_imminent,
          'sim', g.sim
        ) ORDER BY g.sim DESC
      ) AS ggsan_candidates
    FROM validated v
    CROSS JOIN LATERAL (
      SELECT
        gp.goods_no, gp.title, gp.price_krw, gp.cate_label,
        gp.image_url, gp.detail_url, gp.is_imminent,
        similarity(v.canonical_name, gp.title)::real AS sim
      FROM jimscanner_ggsan_products gp
      WHERE gp.title % v.canonical_name
        AND COALESCE(gp.status, 'active') <> 'removed'
      ORDER BY similarity(v.canonical_name, gp.title) DESC
      LIMIT 3
    ) g
    WHERE g.sim >= cand_sim
    GROUP BY v.product_id
  )
  SELECT
    v.product_id,
    v.canonical_name,
    v.category_top,
    v.category_mid,
    v.brand,
    v.trend_score,
    v.commerce_score,
    v.supplier_score,
    v.final_score,
    v.computed_at,
    (v.trend_score + v.commerce_score) AS demand_score,
    COALESCE(sa.supplier_count, 0) AS supplier_count,
    COALESCE(sa.viable_supplier_count, 0) AS viable_supplier_count,
    COALESCE(gm.best_ggsan_sim, 0)::real AS best_ggsan_sim,
    COALESCE(gm.ggsan_candidates, '[]'::jsonb) AS ggsan_candidates,
    (
      COALESCE(sa.viable_supplier_count, 0) = 0
      AND COALESCE(gm.best_ggsan_sim, 0) < connect_sim
    ) AS is_whitespace
  FROM validated v
  LEFT JOIN supplier_agg sa ON sa.product_id = v.product_id
  LEFT JOIN ggsan_match  gm ON gm.product_id = v.product_id
  ORDER BY
    -- 공백 우선, 그 안에서 수요 강도 순
    (CASE WHEN COALESCE(sa.viable_supplier_count, 0) = 0
            AND COALESCE(gm.best_ggsan_sim, 0) < connect_sim THEN 1 ELSE 0 END) DESC,
    (v.trend_score + v.commerce_score) DESC
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출 (anon/authenticated 차단)
REVOKE ALL ON FUNCTION jimscanner_sourcing_whitespace(int, numeric, numeric, float, float, int, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_sourcing_whitespace(int, numeric, numeric, float, float, int, int, int) TO service_role;
