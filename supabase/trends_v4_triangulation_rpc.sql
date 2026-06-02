-- ────────────────────────────────────────────────────────────
-- 교차출처 삼각검증 RPC (PR-TRIANGULATION, 2026-06-02)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/triangulation 보드
--
-- 목적:
--   수집원 18종을 '출처 패밀리' 5종으로 묶어, 상품별로 "독립적으로
--   몇 개 패밀리가 동시에 이 상품을 언급했는가"를 독립성 가중으로 집계.
--   단일출처(봇/시딩/프로모 의심) vs 다출처 확증 수요를 분리한다.
--
--   패밀리(5):
--     commerce   — naver_shopping_hot/insight, musinsa(_best), aliex(press), coupang
--     community  — 82cook, natepan, ppomppu, dcinside, clien(_park), quasarzone(_sale)
--     news       — daum(_news), naver_news, naver_blog, kca_press,
--                  google_suggest, naver_search_trend
--     tv         — naver_tvtime
--     wholesale  — domeggook, ggsan, 1688, ownerclan
--
-- 독립성 가중 확증도(corroboration, 0~100):
--   각 패밀리를 독립적인 증거원으로 보고
--     q_f = 0  (패밀리 부재)
--     q_f = min(0.9, 0.5 + 0.1 * (해당 패밀리 alias 수)) * avg_confidence_factor
--   corroboration = 100 * (1 - ∏_f (1 - q_f))
--   → 1패밀리 ~0.6, 2패밀리 ~0.84, 3패밀리 ~0.93 (기하급수적 신뢰 상승).
--   이 값이 score_components.trend.source_consensus 로 환류될 후보다.
--
-- service_role 로만 호출 (어드민 한정) — SECURITY DEFINER + grant 명시
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_trends_triangulation(
  category_filter text DEFAULT NULL,   -- 'health' | 'living' | 'digital' | NULL(전체)
  min_families int DEFAULT 1,          -- 이 패밀리 수 이상만 반환
  result_limit int DEFAULT 300
)
RETURNS TABLE (
  product_id uuid,
  canonical_name text,
  category_top text,
  total_aliases int,
  family_count int,
  commerce_n int,
  community_n int,
  news_n int,
  tv_n int,
  wholesale_n int,
  other_n int,
  corroboration numeric,
  trend_score numeric,
  final_score numeric,
  last_seen_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH fam AS (
    SELECT
      a.product_id,
      CASE
        WHEN a.source IN (
          'naver_shopping_hot', 'naver_shopping_insight', 'naver_shopping_trend',
          'musinsa', 'musinsa_best', 'aliex', 'aliexpress', 'coupang'
        ) THEN 'commerce'
        WHEN a.source IN (
          '82cook', 'natepan', 'ppomppu', 'dcinside', 'clien', 'clien_park',
          'quasarzone', 'quasarzone_sale'
        ) THEN 'community'
        WHEN a.source IN (
          'daum', 'daum_news', 'naver_news', 'naver_blog', 'kca_press',
          'google_suggest', 'naver_search_trend'
        ) THEN 'news'
        WHEN a.source IN ('naver_tvtime') THEN 'tv'
        WHEN a.source IN ('domeggook', 'ggsan', '1688', 'ownerclan') THEN 'wholesale'
        ELSE 'other'
      END AS family,
      a.confidence
    FROM jimscanner_trends_aliases a
    WHERE a.source IS NOT NULL
  ),
  per_family AS (
    SELECT
      product_id,
      family,
      COUNT(*)::int AS n,
      AVG(confidence)::numeric AS avg_conf
    FROM fam
    GROUP BY product_id, family
  ),
  agg AS (
    SELECT
      product_id,
      SUM(n)::int AS total_aliases,
      COUNT(*) FILTER (WHERE family <> 'other')::int AS family_count,
      COALESCE(SUM(n) FILTER (WHERE family = 'commerce'), 0)::int  AS commerce_n,
      COALESCE(SUM(n) FILTER (WHERE family = 'community'), 0)::int AS community_n,
      COALESCE(SUM(n) FILTER (WHERE family = 'news'), 0)::int      AS news_n,
      COALESCE(SUM(n) FILTER (WHERE family = 'tv'), 0)::int        AS tv_n,
      COALESCE(SUM(n) FILTER (WHERE family = 'wholesale'), 0)::int AS wholesale_n,
      COALESCE(SUM(n) FILTER (WHERE family = 'other'), 0)::int     AS other_n,
      -- 독립성 가중 확증도: 패밀리를 독립 증거원으로 본 1 - ∏(1 - q_f)
      -- q_f = min(0.9, 0.5 + 0.1*n) * clamp(avg_conf,0.3,1.0)  (other 패밀리 제외)
      (100.0 * (1.0 - EXP(SUM(
        CASE WHEN family = 'other' THEN 0.0
        ELSE LN(GREATEST(1e-6,
          1.0 - LEAST(0.9, 0.5 + 0.1 * n) * LEAST(1.0, GREATEST(0.3, COALESCE(avg_conf, 0.5)))
        )) END
      ))))::numeric AS corroboration
    FROM per_family
    GROUP BY product_id
  )
  SELECT
    agg.product_id,
    p.canonical_name,
    p.category_top,
    agg.total_aliases,
    agg.family_count,
    agg.commerce_n,
    agg.community_n,
    agg.news_n,
    agg.tv_n,
    agg.wholesale_n,
    agg.other_n,
    ROUND(agg.corroboration, 1) AS corroboration,
    s.trend_score,
    s.final_score,
    p.last_seen_at
  FROM agg
  JOIN jimscanner_trends_products p ON p.id = agg.product_id
  LEFT JOIN LATERAL (
    SELECT trend_score, final_score
    FROM jimscanner_trends_scores sc
    WHERE sc.product_id = agg.product_id
    ORDER BY sc.computed_at DESC
    LIMIT 1
  ) s ON TRUE
  WHERE (category_filter IS NULL OR p.category_top = category_filter)
    AND agg.family_count >= min_families
  ORDER BY agg.corroboration DESC, agg.family_count DESC, agg.total_aliases DESC
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출 (anon/authenticated 차단)
REVOKE ALL ON FUNCTION jimscanner_trends_triangulation(text, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_trends_triangulation(text, int, int) TO service_role;
