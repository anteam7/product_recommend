-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 — 브랜드 무중력 지대 (Brand Vacuum)
-- ─────────────────────────────────────────────────────────────
-- 목적: 검색 수요가 특정 브랜드에 잠겨있는지(브랜드 락인) vs
--       일반명사로 흩어져 있는지(제네릭)를 측정.
--       제네릭 수요가 높을수록 ggsan 노브랜드 상품으로 진입 가능.
--
-- 신호 정의:
--   generic_demand_ratio = (브랜드 토큰 미포함 alias 수 / 총 alias 수)
--     - 1.0 에 가까움 = '차량용 청소기'처럼 일반명사 검색 → 화이트라벨 진입 가능
--     - 0.0 에 가까움 = '다이슨'처럼 브랜드 락인 → 노브랜드로 못 이김
--
--   brand lexicon = jimscanner_trends_products.brand 의 distinct 값
--     (한 상품의 brand 토큰이 다른 상품의 alias 에 등장하면 그 alias 는 branded 로 간주)
--
-- 노출 정책: 기존 jimscanner_trends_* 와 동일 — service-role(어드민) 전용.
--   뷰는 base 테이블 RLS 를 상속(security_invoker)하므로 별도 정책 불필요.
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW jimscanner_trends_brand_vacuum
WITH (security_invoker = true) AS
WITH brand_lex AS (
  -- 브랜드 사전: 길이 2자 이상인 distinct 브랜드명만 (오탐 방지)
  SELECT DISTINCT lower(trim(brand)) AS token
  FROM jimscanner_trends_products
  WHERE brand IS NOT NULL
    AND length(trim(brand)) >= 2
),
alias_flag AS (
  SELECT
    a.product_id,
    a.alias,
    EXISTS (
      SELECT 1 FROM brand_lex b
      WHERE lower(a.alias) LIKE '%' || b.token || '%'
    ) AS is_branded
  FROM jimscanner_trends_aliases a
),
agg AS (
  SELECT
    product_id,
    count(*)                                   AS total_aliases,
    count(*) FILTER (WHERE NOT is_branded)     AS generic_aliases,
    count(*) FILTER (WHERE is_branded)         AS branded_aliases,
    -- 대표 일반명 키워드: 브랜드 미포함 alias 중 가장 짧은 것 (가장 일반명사적)
    (array_agg(alias ORDER BY length(alias)) FILTER (WHERE NOT is_branded))[1] AS rep_generic_keyword
  FROM alias_flag
  GROUP BY product_id
),
latest_score AS (
  SELECT DISTINCT ON (product_id)
    product_id,
    trend_score,
    commerce_score,
    supplier_score,
    competition_score,
    final_score
  FROM jimscanner_trends_scores
  ORDER BY product_id, computed_at DESC
)
SELECT
  p.id                                         AS product_id,
  p.canonical_name,
  p.category_top,
  p.brand,
  COALESCE(ag.total_aliases, 0)                AS total_aliases,
  COALESCE(ag.generic_aliases, 0)              AS generic_aliases,
  COALESCE(ag.branded_aliases, 0)              AS branded_aliases,
  CASE
    WHEN COALESCE(ag.total_aliases, 0) = 0 THEN NULL
    ELSE round(ag.generic_aliases::numeric / ag.total_aliases, 4)
  END                                          AS generic_demand_ratio,
  ag.rep_generic_keyword,
  ls.trend_score,
  ls.commerce_score,
  ls.supplier_score,
  ls.competition_score,
  ls.final_score
FROM jimscanner_trends_products p
LEFT JOIN agg          ag ON ag.product_id = p.id
LEFT JOIN latest_score ls ON ls.product_id = p.id;

COMMENT ON VIEW jimscanner_trends_brand_vacuum IS
  '브랜드 무중력 지대: 제네릭 수요비율(generic_demand_ratio) × trend × supplier 로 화이트라벨 진입가능 상품 발굴. ggsan 노브랜드 진입 신호.';
