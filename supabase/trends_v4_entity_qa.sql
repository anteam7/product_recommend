-- ────────────────────────────────────────────────────────────
-- PR-4.6: 엔티티 해상도 QA — 분열/과병합/저신뢰 앵커/흡수 후보 (2026-06-01)
-- ────────────────────────────────────────────────────────────
-- jimscanner_trends_aliases 의 alias→canonical 매핑 품질을 점검.
-- alias 매핑은 Haiku confidence 기반이라 분열(under-merge)·과병합(over-merge)이
-- 무음으로 누적된다. canonical 이 N개로 쪼개진 상품은 수요가 1/N 로 희석돼
-- 모든 점수 보드(final_score)에서 과소 랭킹된다.
-- UI: src/app/admin/(dashboard)/trend-radar/entity-qa
-- read-only RLS (service-role 전용) — 기존 trends_* 패턴 동일.
-- ────────────────────────────────────────────────────────────

-- 0) 토큰화 / 자카드 헬퍼 ─────────────────────────────────────
-- 소문자화 → 영숫자/한글 외 구분자로 분할 → 2자 이상 distinct 토큰.
CREATE OR REPLACE FUNCTION jimscanner_trends_tokens(t text)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(array(
    SELECT DISTINCT tok
    FROM unnest(regexp_split_to_array(lower(coalesce(t, '')), '[^0-9a-z가-힣]+')) AS tok
    WHERE char_length(tok) >= 2
  ), '{}'::text[]);
$$;

-- 두 토큰셋의 자카드 유사도 (0~1, 교집합/합집합).
CREATE OR REPLACE FUNCTION jimscanner_trends_jaccard(a text[], b text[])
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN a IS NULL OR b IS NULL
      OR array_length(a, 1) IS NULL OR array_length(b, 1) IS NULL THEN 0
    ELSE round(
      cardinality(array(SELECT unnest(a) INTERSECT SELECT unnest(b)))::numeric
      / nullif(cardinality(array(SELECT unnest(a) UNION SELECT unnest(b))), 0)
    , 3)
  END;
$$;

-- ① 분열(under-merge): 서로 다른 canonical 인데 토큰셋이 유사하거나
--    같은 brand+category_mid 인 후보쌍. 각각 수요가 쪼개져 과소평가.
CREATE OR REPLACE FUNCTION jimscanner_trends_entity_undermerge(
  p_min_sim numeric DEFAULT 0.5, p_limit int DEFAULT 100)
RETURNS TABLE(
  product_a uuid, name_a text, product_b uuid, name_b text,
  brand_a text, brand_b text, cat_a text, cat_b text,
  similarity numeric, same_brand_cat boolean,
  alias_count_a int, alias_count_b int,
  final_a numeric, final_b numeric
) LANGUAGE sql STABLE AS $$
  WITH prod AS (
    SELECT p.id, p.canonical_name, p.brand, p.category_mid, p.category_top, p.alias_count,
      jimscanner_trends_tokens(
        p.canonical_name || ' ' || coalesce(string_agg(a.alias, ' '), '')) AS toks
    FROM jimscanner_trends_products p
    LEFT JOIN jimscanner_trends_aliases a ON a.product_id = p.id
    GROUP BY p.id
  ),
  sc AS (
    SELECT DISTINCT ON (product_id) product_id, final_score
    FROM jimscanner_trends_scores ORDER BY product_id, computed_at DESC
  )
  SELECT pa.id, pa.canonical_name, pb.id, pb.canonical_name,
    pa.brand, pb.brand, pa.category_mid, pb.category_mid,
    jimscanner_trends_jaccard(pa.toks, pb.toks) AS sim,
    (pa.brand IS NOT NULL AND pa.brand = pb.brand
       AND coalesce(pa.category_mid, '') = coalesce(pb.category_mid, '')) AS same_brand_cat,
    pa.alias_count, pb.alias_count, sca.final_score, scb.final_score
  FROM prod pa
  JOIN prod pb ON pa.id < pb.id AND pa.category_top = pb.category_top
  LEFT JOIN sc sca ON sca.product_id = pa.id
  LEFT JOIN sc scb ON scb.product_id = pb.id
  WHERE jimscanner_trends_jaccard(pa.toks, pb.toks) >= p_min_sim
     OR (pa.brand IS NOT NULL AND pa.brand = pb.brand
         AND coalesce(pa.category_mid, '') = coalesce(pb.category_mid, '')
         AND jimscanner_trends_jaccard(pa.toks, pb.toks) >= p_min_sim * 0.5)
  ORDER BY sim DESC
  LIMIT p_limit;
$$;

-- ② 과병합(over-merge): 한 product 안 별칭들의 상호 유사도가 낮음.
--    서로 다른 상품이 뭉쳐 alias_count·점수 왜곡.
CREATE OR REPLACE FUNCTION jimscanner_trends_entity_overmerge(
  p_max_sim numeric DEFAULT 0.15, p_limit int DEFAULT 100)
RETURNS TABLE(
  product_id uuid, canonical_name text, brand text, category_mid text,
  alias_count int, min_pair_sim numeric, avg_pair_sim numeric,
  worst_a text, worst_b text, final_score numeric
) LANGUAGE sql STABLE AS $$
  WITH al AS (
    SELECT a.product_id, a.alias, jimscanner_trends_tokens(a.alias) AS toks
    FROM jimscanner_trends_aliases a
  ),
  pairs AS (
    SELECT x.product_id, x.alias AS a1, y.alias AS a2,
      jimscanner_trends_jaccard(x.toks, y.toks) AS sim
    FROM al x JOIN al y ON x.product_id = y.product_id AND x.alias < y.alias
  ),
  agg AS (
    SELECT product_id, min(sim) AS min_sim, round(avg(sim), 3) AS avg_sim,
      (array_agg(a1 ORDER BY sim))[1] AS wa,
      (array_agg(a2 ORDER BY sim))[1] AS wb
    FROM pairs GROUP BY product_id
  )
  SELECT p.id, p.canonical_name, p.brand, p.category_mid, p.alias_count,
    agg.min_sim, agg.avg_sim, agg.wa, agg.wb, sc.final_score
  FROM agg
  JOIN jimscanner_trends_products p ON p.id = agg.product_id
  LEFT JOIN LATERAL (
    SELECT final_score FROM jimscanner_trends_scores s
    WHERE s.product_id = p.id ORDER BY computed_at DESC LIMIT 1
  ) sc ON true
  WHERE agg.min_sim <= p_max_sim AND p.alias_count >= 2
  ORDER BY agg.min_sim ASC
  LIMIT p_limit;
$$;

-- ③ 저신뢰 앵커: manual 별칭이 0건이고 최고 confidence < 임계인 product.
--    저신뢰 llm_haiku 별칭만으로 product 가 지탱됨.
CREATE OR REPLACE FUNCTION jimscanner_trends_entity_lowconf_anchor(
  p_max_conf numeric DEFAULT 0.6, p_limit int DEFAULT 100)
RETURNS TABLE(
  product_id uuid, canonical_name text, brand text, alias_count int,
  max_conf numeric, llm_alias_count int, total_alias int,
  manual_alias_count int, final_score numeric
) LANGUAGE sql STABLE AS $$
  WITH stats AS (
    SELECT a.product_id,
      max(a.confidence) AS max_conf,
      count(*) FILTER (WHERE a.classified_by = 'llm_haiku') AS llm_cnt,
      count(*) FILTER (WHERE a.classified_by = 'manual') AS man_cnt,
      count(*) AS total
    FROM jimscanner_trends_aliases a
    GROUP BY a.product_id
  )
  SELECT p.id, p.canonical_name, p.brand, p.alias_count,
    s.max_conf, s.llm_cnt::int, s.total::int, s.man_cnt::int, sc.final_score
  FROM stats s
  JOIN jimscanner_trends_products p ON p.id = s.product_id
  LEFT JOIN LATERAL (
    SELECT final_score FROM jimscanner_trends_scores ss
    WHERE ss.product_id = p.id ORDER BY computed_at DESC LIMIT 1
  ) sc ON true
  WHERE s.man_cnt = 0 AND s.max_conf < p_max_conf
  ORDER BY s.max_conf ASC
  LIMIT p_limit;
$$;

-- ④ 흡수 후보: llm 미분류(llm_classified_at IS NULL) product 중
--    기존 분류된 canonical 과 토큰 매칭되는 건 → 흡수(merge) 후보.
CREATE OR REPLACE FUNCTION jimscanner_trends_entity_absorb(
  p_min_sim numeric DEFAULT 0.4, p_limit int DEFAULT 100)
RETURNS TABLE(
  unclassified_id uuid, unclassified_name text,
  target_id uuid, target_name text, target_brand text,
  similarity numeric, target_alias_count int
) LANGUAGE sql STABLE AS $$
  WITH un AS (
    SELECT p.id, p.canonical_name, p.category_top,
      jimscanner_trends_tokens(p.canonical_name) AS toks
    FROM jimscanner_trends_products p
    WHERE p.llm_classified_at IS NULL
  ),
  cl AS (
    SELECT p.id, p.canonical_name, p.brand, p.category_top, p.alias_count,
      jimscanner_trends_tokens(
        p.canonical_name || ' ' || coalesce(string_agg(a.alias, ' '), '')) AS toks
    FROM jimscanner_trends_products p
    LEFT JOIN jimscanner_trends_aliases a ON a.product_id = p.id
    WHERE p.llm_classified_at IS NOT NULL
    GROUP BY p.id
  )
  SELECT DISTINCT ON (un.id)
    un.id, un.canonical_name, cl.id, cl.canonical_name, cl.brand,
    jimscanner_trends_jaccard(un.toks, cl.toks), cl.alias_count
  FROM un JOIN cl ON un.category_top = cl.category_top
  WHERE jimscanner_trends_jaccard(un.toks, cl.toks) >= p_min_sim
  ORDER BY un.id, jimscanner_trends_jaccard(un.toks, cl.toks) DESC
  LIMIT p_limit;
$$;

-- confidence 히스토그램 (분류 출처별 0.0~0.9 버킷)
CREATE OR REPLACE FUNCTION jimscanner_trends_entity_conf_histogram()
RETURNS TABLE(bucket numeric, classified_by text, cnt int) LANGUAGE sql STABLE AS $$
  SELECT floor(least(coalesce(confidence, 0), 0.999) * 10) / 10 AS bucket,
         coalesce(classified_by, 'unknown') AS classified_by,
         count(*)::int AS cnt
  FROM jimscanner_trends_aliases
  GROUP BY 1, 2
  ORDER BY 1, 2;
$$;
