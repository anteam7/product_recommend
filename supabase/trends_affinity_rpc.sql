-- ────────────────────────────────────────────────────────────
-- 수요 동반언급 친화도 → 묶음 SKU 발굴 RPC (2026-06-02)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/affinity
-- 목적: 같은 출처 문서/방송 내에서 함께 등장한 트렌드 토큰의 '양의 동반언급(complementarity)'을
--       PMI/lift 로 측정해, 자연스럽게 묶을 수 있는 페어를 발굴.
--
-- 동반언급(co-occurrence) 문서 단위:
--   ① jimscanner_trends_keywords : (source, collected_at) 가 같은 묶음 = 동일 스크랩/방송/스레드
--      특히 source='naver_tvtime'(동일 방송 편성), 커뮤니티(82cook/ppomppu 동일 스레드)
--   ② jimscanner_market_raw      : 같은 dedup_key 문서(naver_news 등)의 metadata.tags 배열
--
-- PMI  = log( cooccur * N / (count_a * count_b) )   (양수 = 우연 이상으로 함께 등장)
-- lift = cooccur * N / (count_a * count_b)          (>1 = 양의 보완재 시그널)
--
-- 등록가능 묶음후보 승격: 양쪽 토큰 모두 jimscanner_ggsan_products 매칭(pg_trgm)이 존재해야 함.
-- service_role 로만 호출 (어드민 한정) — SECURITY DEFINER + grant 명시.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_trends_affinity(
  days_window int DEFAULT 30,
  min_sim float DEFAULT 0.20,
  min_cooccur int DEFAULT 2,
  result_limit int DEFAULT 100
)
RETURNS TABLE (
  token_a text,
  token_b text,
  cooccur_count int,
  count_a int,
  count_b int,
  total_docs int,
  pmi real,
  lift real,
  -- ggsan 매칭 A
  goods_no_a text,
  title_a text,
  price_a int,
  sim_a real,
  -- ggsan 매칭 B
  goods_no_b text,
  title_b text,
  price_b int,
  sim_b real,
  -- 묶음 경제성
  bundle_dome_krw int,
  msp_sum_krw int,
  -- 종합 점수 (final_score 체계 재사용)
  affinity_score real
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  -- 1) 문서 ↔ 토큰 (동일 출처 동시 등장 = 천연 co-occurrence 라벨)
  doc_tokens AS (
    -- ① trends_keywords: (source, collected_at) 가 같으면 동일 스크랩/방송/스레드
    SELECT
      'kw::' || k.source || '::' || k.collected_at::text AS doc_id,
      k.keyword AS token
    FROM jimscanner_trends_keywords k
    WHERE k.collected_at > now() - (days_window || ' days')::interval
      AND char_length(k.keyword) >= 2
    UNION
    -- ② market_raw: 같은 문서(dedup_key)의 metadata.tags 배열
    SELECT
      'mr::' || m.source || '::' || m.dedup_key AS doc_id,
      tag AS token
    FROM jimscanner_market_raw m
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(m.metadata->'tags') = 'array'
           THEN m.metadata->'tags' ELSE '[]'::jsonb END
    ) AS tag
    WHERE m.captured_at > now() - (days_window || ' days')::interval
      AND char_length(tag) >= 2
  ),
  dt AS (
    SELECT DISTINCT doc_id, token FROM doc_tokens
  ),
  -- 2) 전체 문서 수 N
  totals AS (
    SELECT COUNT(DISTINCT doc_id)::int AS n_docs FROM dt
  ),
  -- 3) 토큰별 등장 문서 수
  token_freq AS (
    SELECT token, COUNT(DISTINCT doc_id)::int AS df
    FROM dt
    GROUP BY token
  ),
  -- 4) 각 토큰 → ggsan 최적 매칭 (pg_trgm). 매칭되는 토큰만 페어 후보로 남김
  matched_tokens AS (
    SELECT
      tf.token,
      tf.df,
      g.goods_no,
      g.title,
      g.price_krw,
      g.sim,
      g.dome_krw,
      g.msp_krw
    FROM token_freq tf
    CROSS JOIN LATERAL (
      SELECT
        gp.goods_no,
        gp.title,
        gp.price_krw,
        similarity(tf.token, gp.title)::real AS sim,
        gp.price_krw AS dome_krw,
        COALESCE(
          NULLIF((gp.raw_payload->'tiered_msp'->>'1'), '')::int,
          gp.min_sell_price_krw,
          gp.price_krw
        ) AS msp_krw
      FROM jimscanner_ggsan_products gp
      WHERE gp.title % tf.token
      ORDER BY similarity(tf.token, gp.title) DESC
      LIMIT 1
    ) g
    WHERE g.sim >= min_sim
  ),
  -- 5) 매칭 토큰끼리 동반 등장 페어 (a < b, 서로 다른 ggsan 상품)
  pairs AS (
    SELECT
      a.token AS token_a,
      b.token AS token_b,
      COUNT(DISTINCT a.doc_id)::int AS cooccur_count
    FROM dt a
    JOIN dt b ON a.doc_id = b.doc_id AND a.token < b.token
    WHERE a.token IN (SELECT token FROM matched_tokens)
      AND b.token IN (SELECT token FROM matched_tokens)
    GROUP BY a.token, b.token
    HAVING COUNT(DISTINCT a.doc_id) >= min_cooccur
  )
  SELECT
    p.token_a,
    p.token_b,
    p.cooccur_count,
    ma.df AS count_a,
    mb.df AS count_b,
    t.n_docs AS total_docs,
    ln(GREATEST(p.cooccur_count::real * t.n_docs / NULLIF(ma.df::real * mb.df, 0), 1e-9))::real AS pmi,
    (p.cooccur_count::real * t.n_docs / NULLIF(ma.df::real * mb.df, 0))::real AS lift,
    ma.goods_no AS goods_no_a,
    ma.title AS title_a,
    ma.price_krw AS price_a,
    ma.sim AS sim_a,
    mb.goods_no AS goods_no_b,
    mb.title AS title_b,
    mb.price_krw AS price_b,
    mb.sim AS sim_b,
    (COALESCE(ma.dome_krw, 0) + COALESCE(mb.dome_krw, 0))::int AS bundle_dome_krw,
    (COALESCE(ma.msp_krw, 0) + COALESCE(mb.msp_krw, 0))::int AS msp_sum_krw,
    -- affinity_score = lift × log(1+동반횟수) × 매칭품질(sim 기하평균)
    ( (p.cooccur_count::real * t.n_docs / NULLIF(ma.df::real * mb.df, 0))
      * ln(1 + p.cooccur_count)
      * sqrt(GREATEST(ma.sim, 0) * GREATEST(mb.sim, 0))
    )::real AS affinity_score
  FROM pairs p
  JOIN matched_tokens ma ON ma.token = p.token_a
  JOIN matched_tokens mb ON mb.token = p.token_b
  CROSS JOIN totals t
  -- 서로 다른 ggsan 상품만 (동일 상품에 두 토큰이 매칭된 경우 묶음 의미 없음)
  WHERE ma.goods_no <> mb.goods_no
  ORDER BY affinity_score DESC NULLS LAST
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출 (anon/authenticated 차단)
REVOKE ALL ON FUNCTION jimscanner_trends_affinity(int, float, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_trends_affinity(int, float, int, int) TO service_role;
