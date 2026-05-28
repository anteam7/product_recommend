-- ────────────────────────────────────────────────────────────
-- Recall Block Watch — 식약처 회수·판매중지·원료금지 사전차단 게이트 (2026-05-29)
-- ────────────────────────────────────────────────────────────
-- 데이터: jimscanner_market_raw(source='mfds_recall')
--   metadata = { product_name, maker, reason, ingredient, notice_date, service, raw }
-- 사용처:
--   1) /admin/trend-radar/safety-gate — 회수 제품·원료 ↔ ggsan 후보 pg_trgm 매칭
--   2) jimscanner_ggsan_recommend — RED 매칭 product 를 추천에서 제외 (안전 필터)
-- 매칭 패턴: tv-ggsan-match 재사용 (ggsan title gin_trgm 인덱스 + similarity)
-- ────────────────────────────────────────────────────────────

-- ── 1) 회수·원료금지 ↔ ggsan 매칭 RPC ──────────────────────────
DROP FUNCTION IF EXISTS jimscanner_mfds_recall_match(float, int, int);

CREATE OR REPLACE FUNCTION jimscanner_mfds_recall_match(
  min_sim float DEFAULT 0.30,
  days_window int DEFAULT 365,
  result_limit int DEFAULT 300
)
RETURNS TABLE (
  recall_id uuid,
  product_name text,
  maker text,
  reason text,
  ingredient text,
  notice_date text,
  source_url text,
  match_kind text,        -- 'product' (제품명) | 'ingredient' (원료 사용금지)
  goods_no text,
  ggsan_title text,
  cate_cd text,
  cate_label text,
  detail_url text,
  image_url text,
  is_imminent boolean,
  sim real
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH recalls AS (
    SELECT
      mr.id AS recall_id,
      COALESCE(NULLIF(mr.metadata->>'product_name', ''), mr.title) AS product_name,
      mr.metadata->>'maker'       AS maker,
      mr.metadata->>'reason'      AS reason,
      NULLIF(mr.metadata->>'ingredient', '') AS ingredient,
      mr.metadata->>'notice_date' AS notice_date,
      mr.source_url
    FROM jimscanner_market_raw mr
    WHERE mr.source = 'mfds_recall'
      AND mr.captured_at > now() - (days_window || ' days')::interval
  ),
  -- (1) 회수 제품명 ↔ ggsan title
  m_product AS (
    SELECT
      rc.recall_id, rc.product_name, rc.maker, rc.reason, rc.ingredient,
      rc.notice_date, rc.source_url,
      'product'::text AS match_kind,
      g.goods_no, g.title AS ggsan_title, g.cate_cd, g.cate_label,
      g.detail_url, g.image_url, g.is_imminent,
      similarity(rc.product_name, g.title) AS sim
    FROM recalls rc
    CROSS JOIN LATERAL (
      SELECT gp.goods_no, gp.title, gp.cate_cd, gp.cate_label,
             gp.detail_url, gp.image_url, gp.is_imminent
      FROM jimscanner_ggsan_products gp
      WHERE rc.product_name IS NOT NULL AND gp.title % rc.product_name
      ORDER BY similarity(rc.product_name, gp.title) DESC
      LIMIT 5
    ) g
    WHERE rc.product_name IS NOT NULL
      AND similarity(rc.product_name, g.title) >= min_sim
  ),
  -- (2) 사용금지/위해 원료명 ↔ ggsan title (원료가 제품명에 노출되는 건기식 특성 활용)
  m_ingredient AS (
    SELECT
      rc.recall_id, rc.product_name, rc.maker, rc.reason, rc.ingredient,
      rc.notice_date, rc.source_url,
      'ingredient'::text AS match_kind,
      g.goods_no, g.title AS ggsan_title, g.cate_cd, g.cate_label,
      g.detail_url, g.image_url, g.is_imminent,
      similarity(rc.ingredient, g.title) AS sim
    FROM recalls rc
    CROSS JOIN LATERAL (
      SELECT gp.goods_no, gp.title, gp.cate_cd, gp.cate_label,
             gp.detail_url, gp.image_url, gp.is_imminent
      FROM jimscanner_ggsan_products gp
      WHERE rc.ingredient IS NOT NULL AND gp.title % rc.ingredient
      ORDER BY similarity(rc.ingredient, gp.title) DESC
      LIMIT 5
    ) g
    WHERE rc.ingredient IS NOT NULL
      AND similarity(rc.ingredient, g.title) >= min_sim
  ),
  unioned AS (
    SELECT * FROM m_product
    UNION ALL
    SELECT * FROM m_ingredient
  )
  SELECT DISTINCT ON (goods_no, match_kind)
    recall_id, product_name, maker, reason, ingredient, notice_date, source_url,
    match_kind, goods_no, ggsan_title, cate_cd, cate_label, detail_url,
    image_url, is_imminent, sim::real
  FROM unioned
  ORDER BY goods_no, match_kind, sim DESC
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_mfds_recall_match(float, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_mfds_recall_match(float, int, int) TO service_role;

-- ── 2) ggsan_recommend 안전 필터 ──────────────────────────────
-- ggsan_recommend_rpc.sql 의 함수에 RED(회수/원료금지 매칭) product 제외 로직을
-- 추가했다. 적용 순서: 이 파일 실행 전에 ggsan_recommend_rpc.sql 을 먼저 실행.
-- (실제 final_score 산출 시 RED 제외는 ggsan_recommend_rpc.sql 본문에 반영됨)
