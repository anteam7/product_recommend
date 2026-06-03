-- ────────────────────────────────────────────────────────────
-- 가격대(price-tier) 화이트스페이스 RPC (PR-OPP-PRICE, 2026-06-03)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/opportunity-price 페이지
-- ggsan 위탁 후보를 '예상 판매가 버킷' × '카테고리' 그리드로 줄세워,
-- 수요는 높은데 경쟁이 빈 가격 포켓(whitespace)을 발굴.
--
-- 각 ggsan 후보에 쿠팡 가격공식(SHIP=3000, FEE=10.6%, VAT=÷11; coupang_pricing_model)을
-- 적용해 예상 판매가/마진을 산출하고, 제목 trigram 으로 최근접 trends_product 를 찾아
-- 그 최신 trend_score(수요) / competition_score(경쟁) 를 끌어온다.
--
-- 신규 테이블 없음 — 기존 jimscanner_ggsan_products + jimscanner_trends_scores 재배열.
-- service_role 로만 호출 (어드민 한정).
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_price_tier_whitespace(
  min_sim float DEFAULT 0.20
)
RETURNS TABLE (
  goods_no text,
  title text,
  cate_cd text,
  cate_label text,
  price_krw int,
  real_cost int,
  expected_sell int,
  expected_margin int,
  expected_margin_pct numeric,
  price_tier text,
  is_imminent boolean,
  detail_url text,
  demand_signal numeric,        -- 최근접 trends_product 의 trend_score (수요)
  competition_score numeric     -- 최근접 trends_product 의 competition_score (경쟁)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH latest_scores AS (
    -- product 별 최신 score 1건
    SELECT DISTINCT ON (s.product_id)
      s.product_id,
      p.canonical_name,
      s.trend_score,
      s.competition_score
    FROM jimscanner_trends_scores s
    JOIN jimscanner_trends_products p ON p.id = s.product_id
    ORDER BY s.product_id, s.computed_at DESC
  ),
  priced AS (
    SELECT
      g.goods_no,
      g.title,
      g.cate_cd,
      g.cate_label,
      g.price_krw,
      g.is_imminent,
      g.detail_url,
      -- 쿠팡 가격공식: realCost = 도매가 + 배송 3000
      (g.price_krw + 3000) AS real_cost,
      -- 예상 판매가 = ceil(realCost / 0.65 / 100) * 100  (총마크업 35% 기준 하한)
      (ceil((g.price_krw + 3000) / 0.65 / 100.0) * 100)::int AS expected_sell
    FROM jimscanner_ggsan_products g
    WHERE g.price_krw IS NOT NULL
      AND g.price_krw > 0
      AND COALESCE(g.status, 'active') <> 'removed'
  )
  SELECT
    pr.goods_no,
    pr.title,
    pr.cate_cd,
    pr.cate_label,
    pr.price_krw,
    pr.real_cost,
    pr.expected_sell,
    -- margin = 판매가 - realCost - 수수료(10.6%) - VAT(÷11)
    (pr.expected_sell
      - pr.real_cost
      - round(pr.expected_sell * 0.106)
      - round(pr.expected_sell / 11.0))::int AS expected_margin,
    round(
      (pr.expected_sell
        - pr.real_cost
        - round(pr.expected_sell * 0.106)
        - round(pr.expected_sell / 11.0)
      )::numeric / NULLIF(pr.expected_sell, 0) * 100, 1
    ) AS expected_margin_pct,
    CASE
      WHEN pr.expected_sell < 10000  THEN 't1_under10k'
      WHEN pr.expected_sell < 30000  THEN 't2_10_30k'
      WHEN pr.expected_sell < 50000  THEN 't3_30_50k'
      WHEN pr.expected_sell < 100000 THEN 't4_50_100k'
      ELSE 't5_over100k'
    END AS price_tier,
    pr.is_imminent,
    pr.detail_url,
    m.trend_score AS demand_signal,
    m.competition_score
  FROM priced pr
  LEFT JOIN LATERAL (
    SELECT ls.trend_score, ls.competition_score
    FROM latest_scores ls
    WHERE ls.canonical_name % pr.title          -- pg_trgm 인덱스 활용
    ORDER BY similarity(ls.canonical_name, pr.title) DESC
    LIMIT 1
  ) m ON true;
$$;

-- 어드민 service-role 만 호출 (anon/authenticated 차단)
REVOKE ALL ON FUNCTION jimscanner_price_tier_whitespace(float) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_price_tier_whitespace(float) TO service_role;
