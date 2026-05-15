-- ────────────────────────────────────────────────────────────
-- ggsan 카테고리×가격버킷 공백(Price Gap) 분석 RPC (V0, 2026-05-15)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/price-gaps
-- 목적: '특정 가격대 자체가 비어 있는' 구조적 공급 공백 발굴.
--   - 공급 트랙: jimscanner_ggsan_products 의 카테고리별 도매가 5,000원 버킷 분포
--   - 수요 트랙: jimscanner_trends_keywords (TV / 검색 / 쇼핑) 중 ggsan 상품과 trgm 매칭된
--     키워드의 occurrences 합을, 매칭된 상품의 cate_cd × 가격 버킷에 할당.
-- 가격대 공백 = 카테고리 내 수요는 있는데 supply_count = 0 인 버킷.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_price_gap_buckets(
  days_window int DEFAULT 30,
  bucket_size int DEFAULT 5000,
  min_sim float DEFAULT 0.20
)
RETURNS TABLE (
  cate_cd text,
  cate_label text,
  bucket_floor int,
  supply_count int,
  demand_count int,
  demand_keywords_sample text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  supply AS (
    SELECT
      gp.cate_cd,
      MAX(gp.cate_label) AS cate_label,
      ((gp.price_krw / bucket_size) * bucket_size)::int AS bucket_floor,
      COUNT(*)::int AS supply_count
    FROM jimscanner_ggsan_products gp
    WHERE gp.price_krw IS NOT NULL
      AND gp.price_krw > 0
      AND gp.cate_cd IS NOT NULL
      AND COALESCE(gp.status, 'active') <> 'removed'
    GROUP BY gp.cate_cd, ((gp.price_krw / bucket_size) * bucket_size)
  ),
  demand_keywords AS (
    SELECT keyword, COUNT(*)::int AS occurrences
    FROM jimscanner_trends_keywords
    WHERE collected_at > now() - (days_window || ' days')::interval
      AND source IN (
        'naver_shopping_hot',
        'naver_search_trend',
        'naver_tvtime',
        'aliex_best',
        'musinsa_best'
      )
    GROUP BY keyword
  ),
  demand_matches AS (
    SELECT
      dk.keyword,
      dk.occurrences,
      gp.cate_cd,
      gp.cate_label,
      ((gp.price_krw / bucket_size) * bucket_size)::int AS bucket_floor
    FROM demand_keywords dk
    CROSS JOIN LATERAL (
      SELECT g.cate_cd, g.cate_label, g.price_krw, g.title
      FROM jimscanner_ggsan_products g
      WHERE g.title % dk.keyword
        AND g.price_krw IS NOT NULL
        AND g.price_krw > 0
        AND g.cate_cd IS NOT NULL
      ORDER BY similarity(dk.keyword, g.title) DESC
      LIMIT 1
    ) gp
    WHERE similarity(dk.keyword, gp.title) >= min_sim
  ),
  demand AS (
    SELECT
      cate_cd,
      MAX(cate_label) AS cate_label,
      bucket_floor,
      SUM(occurrences)::int AS demand_count,
      (ARRAY_AGG(DISTINCT keyword))[1:5] AS demand_keywords_sample
    FROM demand_matches
    GROUP BY cate_cd, bucket_floor
  )
  SELECT
    COALESCE(s.cate_cd, d.cate_cd) AS cate_cd,
    COALESCE(s.cate_label, d.cate_label) AS cate_label,
    COALESCE(s.bucket_floor, d.bucket_floor) AS bucket_floor,
    COALESCE(s.supply_count, 0) AS supply_count,
    COALESCE(d.demand_count, 0) AS demand_count,
    COALESCE(d.demand_keywords_sample, ARRAY[]::text[]) AS demand_keywords_sample
  FROM supply s
  FULL OUTER JOIN demand d
    ON s.cate_cd = d.cate_cd AND s.bucket_floor = d.bucket_floor
  ORDER BY COALESCE(s.cate_cd, d.cate_cd), COALESCE(s.bucket_floor, d.bucket_floor);
$$;

-- 카테고리 내 ggsan 상품 중 가격이 target 가격에 가장 가까운 N개.
-- 어느 방향(미만/이상) 후보를 묶어볼지 클라이언트에서 보여주기 위함.
CREATE OR REPLACE FUNCTION jimscanner_price_gap_nearest(
  p_cate_cd text,
  p_bucket_floor int,
  p_bucket_size int DEFAULT 5000,
  p_limit int DEFAULT 5
)
RETURNS TABLE (
  goods_no text,
  title text,
  price_krw int,
  image_url text,
  detail_url text,
  side text  -- 'below' | 'above'
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  (
    SELECT goods_no, title, price_krw, image_url, detail_url, 'below' AS side
    FROM jimscanner_ggsan_products
    WHERE cate_cd = p_cate_cd
      AND price_krw IS NOT NULL
      AND price_krw < p_bucket_floor
      AND COALESCE(status, 'active') <> 'removed'
    ORDER BY price_krw DESC
    LIMIT p_limit
  )
  UNION ALL
  (
    SELECT goods_no, title, price_krw, image_url, detail_url, 'above' AS side
    FROM jimscanner_ggsan_products
    WHERE cate_cd = p_cate_cd
      AND price_krw IS NOT NULL
      AND price_krw >= p_bucket_floor + p_bucket_size
      AND COALESCE(status, 'active') <> 'removed'
    ORDER BY price_krw ASC
    LIMIT p_limit
  );
$$;

-- 카테고리 내, ggsan 상품과 trgm 매칭이 안 되는 (미매칭) 검색 키워드 Top N.
-- '카테고리 내'의 판정: 같은 cate_cd 안의 어떤 상품과도 min_sim 이상 trgm 매치가 없으면 미매칭.
-- 단 카테고리 전체와 trgm 매치는 약함 — V0는 단순히 '전체 ggsan 과 어디에도 매칭 안 되는 키워드' 로 정의.
CREATE OR REPLACE FUNCTION jimscanner_price_gap_unmatched_keywords(
  p_cate_cd text,
  days_window int DEFAULT 30,
  min_sim float DEFAULT 0.20,
  p_limit int DEFAULT 10
)
RETURNS TABLE (
  keyword text,
  occurrences int,
  sources text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH kw AS (
    SELECT
      keyword,
      COUNT(*)::int AS occurrences,
      ARRAY_AGG(DISTINCT source) AS sources
    FROM jimscanner_trends_keywords
    WHERE collected_at > now() - (days_window || ' days')::interval
      AND source IN (
        'naver_shopping_hot',
        'naver_search_trend',
        'naver_tvtime',
        'aliex_best',
        'musinsa_best'
      )
    GROUP BY keyword
  ),
  matched AS (
    SELECT DISTINCT kw.keyword
    FROM kw
    JOIN jimscanner_ggsan_products gp
      ON gp.cate_cd = p_cate_cd
     AND gp.title % kw.keyword
     AND similarity(kw.keyword, gp.title) >= min_sim
  )
  SELECT kw.keyword, kw.occurrences, kw.sources
  FROM kw
  WHERE kw.keyword NOT IN (SELECT keyword FROM matched)
  ORDER BY kw.occurrences DESC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_price_gap_buckets(int, int, float) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_price_gap_buckets(int, int, float) TO service_role;

REVOKE ALL ON FUNCTION jimscanner_price_gap_nearest(text, int, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_price_gap_nearest(text, int, int, int) TO service_role;

REVOKE ALL ON FUNCTION jimscanner_price_gap_unmatched_keywords(text, int, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_price_gap_unmatched_keywords(text, int, float, int) TO service_role;
