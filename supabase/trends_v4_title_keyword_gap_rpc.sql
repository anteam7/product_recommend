-- ────────────────────────────────────────────────────────────
-- 리스팅 제목 키워드 화이트스페이스 RPC (2026-06-01)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/title-gap, /admin/trend-radar/products/[id]
-- aliases 의 두 alias_type 를 상품별로 자가 안티조인:
--   keyword(실제 검색어, source=naver_*) 토큰  -  product_title(경쟁사 제목) 토큰
--   = '검색은 되는데 경쟁사 제목엔 빠진' 화이트스페이스 키워드
-- 각 토큰은 jimscanner_trends_keywords.volume_relative 로 가중.
-- service_role 만 호출 (어드민 한정) — SECURITY DEFINER + grant 명시.
-- ────────────────────────────────────────────────────────────

-- 1) 한글/영숫자 토크나이저 — 공백분리 + 한글 2-gram
--    "수면 영양제" → {수면, 영양제, 영양, 양제} (2-gram 으로 제목 부분일치 흡수)
CREATE OR REPLACE FUNCTION jimscanner_korean_tokens(input text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  WITH cleaned AS (
    SELECT lower(regexp_replace(coalesce(input, ''), '[^0-9a-z가-힣]+', ' ', 'g')) AS s
  ),
  words AS (
    SELECT w
    FROM cleaned, regexp_split_to_table(s, '\s+') AS w
    WHERE length(w) >= 2
  ),
  grams AS (
    -- 전체 단어 토큰
    SELECT w AS tok FROM words
    UNION
    -- 3글자 이상 한글 단어는 연속 2-gram 도 추가 (제목/검색어 부분일치 매칭용)
    SELECT substring(w FROM i FOR 2) AS tok
    FROM words, generate_series(1, length(w) - 1) AS i
    WHERE w ~ '[가-힣]' AND length(w) > 2
  )
  SELECT COALESCE(array_agg(DISTINCT tok), ARRAY[]::text[])
  FROM grams
  WHERE length(tok) >= 2;
$$;


-- 2) 상품별 제목 화이트스페이스 안티조인
--    반환: 상품 × 미사용 토큰 한 row. UI 에서 상품별로 집계해 칩/랭킹 렌더.
CREATE OR REPLACE FUNCTION jimscanner_title_keyword_gap(
  min_volume numeric DEFAULT 0,
  result_limit int DEFAULT 1000,
  target_product uuid DEFAULT NULL
)
RETURNS TABLE (
  product_id uuid,
  canonical_name text,
  category_top text,
  category_mid text,
  gap_token text,
  volume numeric,
  source_keywords text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH kw_vol AS (
    -- 키워드 문자열별 최대 상대검색량
    SELECT keyword, MAX(volume_relative) AS vol
    FROM jimscanner_trends_keywords
    WHERE volume_relative IS NOT NULL
    GROUP BY keyword
  ),
  kw_aliases AS (
    -- alias_type='keyword' (실제 검색어) — 그 검색어의 상대검색량을 매칭
    SELECT a.product_id, a.alias, COALESCE(kv.vol, 0) AS vol
    FROM jimscanner_trends_aliases a
    LEFT JOIN kw_vol kv ON kv.keyword = a.alias
    WHERE a.alias_type = 'keyword'
      AND (target_product IS NULL OR a.product_id = target_product)
  ),
  kw_tokens AS (
    -- 검색어 토큰 집합 (토큰별 max 검색량 + 출처 검색어 목록)
    SELECT
      ka.product_id,
      tok,
      MAX(ka.vol) AS vol,
      array_agg(DISTINCT ka.alias) AS src
    FROM kw_aliases ka, unnest(jimscanner_korean_tokens(ka.alias)) AS tok
    GROUP BY ka.product_id, tok
  ),
  title_tokens AS (
    -- alias_type='product_title' (경쟁사 제목) 토큰 집합 — 차감 대상
    SELECT DISTINCT a.product_id, tok
    FROM jimscanner_trends_aliases a, unnest(jimscanner_korean_tokens(a.alias)) AS tok
    WHERE a.alias_type = 'product_title'
      AND (target_product IS NULL OR a.product_id = target_product)
  ),
  gap AS (
    -- 안티조인: 검색어엔 있으나 경쟁사 제목엔 없는 토큰
    SELECT kt.product_id, kt.tok, kt.vol, kt.src
    FROM kw_tokens kt
    LEFT JOIN title_tokens tt
      ON tt.product_id = kt.product_id AND tt.tok = kt.tok
    WHERE tt.tok IS NULL
      AND kt.vol >= min_volume
  )
  SELECT
    g.product_id,
    p.canonical_name,
    p.category_top,
    p.category_mid,
    g.tok AS gap_token,
    g.vol AS volume,
    g.src AS source_keywords
  FROM gap g
  JOIN jimscanner_trends_products p ON p.id = g.product_id
  ORDER BY g.vol DESC, g.product_id, g.tok
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출 (anon/authenticated 차단)
REVOKE ALL ON FUNCTION jimscanner_korean_tokens(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION jimscanner_title_keyword_gap(numeric, int, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_title_keyword_gap(numeric, int, uuid) TO service_role;
