-- ────────────────────────────────────────────────────────────
-- 입고 골든윈도우: ggsan 신규입고 SKU ↔ 수요(trends) fuzzy 매칭 RPC
-- (PR-GGSAN-3, 2026-06-02)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/new-arrival 페이지
-- 핵심 축: '공급측 신규취급 이벤트' (first_seen_at 최근 N일) × '수요 강도'(trends scores)
--   - tv_ggsan_match 패턴 복제, 키워드 소스를 TV → '신규 입고 이벤트'로 교체
--   - 도매처(ggsan)가 막 취급 시작한 SKU 를 남들보다 먼저 등록하기 위한 보드
-- service_role 로만 호출 (어드민 한정) — SECURITY DEFINER + grant 명시
-- ────────────────────────────────────────────────────────────

-- canonical_name 쪽 trgm 인덱스 (n.title % canonical_name 매칭 가속)
CREATE INDEX IF NOT EXISTS jimscanner_trends_products_canonical_trgm
  ON jimscanner_trends_products USING gin (canonical_name gin_trgm_ops);

CREATE OR REPLACE FUNCTION jimscanner_ggsan_newarrival_match(
  days_window int DEFAULT 7,
  min_sim float DEFAULT 0.20,
  per_goods_limit int DEFAULT 3,
  result_limit int DEFAULT 500
)
RETURNS TABLE (
  goods_no text,
  ggsan_title text,
  price_krw int,
  cate_cd text,
  cate_label text,
  image_url text,
  detail_url text,
  is_imminent boolean,
  first_seen_at timestamptz,
  hours_since_arrival numeric,
  trend_name text,
  category_top text,
  trend_score numeric,
  final_score numeric,
  sim real
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH latest_scores AS (
    SELECT DISTINCT ON (s.product_id)
      s.product_id, s.trend_score, s.final_score, s.computed_at
    FROM jimscanner_trends_scores s
    ORDER BY s.product_id, s.computed_at DESC
  ),
  newarrivals AS (
    SELECT
      gp.goods_no, gp.title, gp.price_krw, gp.cate_cd, gp.cate_label,
      gp.image_url, gp.detail_url, gp.is_imminent, gp.first_seen_at
    FROM jimscanner_ggsan_products gp
    WHERE gp.first_seen_at > now() - (days_window || ' days')::interval
      AND COALESCE(gp.status, 'active') <> 'removed'
  )
  SELECT
    n.goods_no,
    n.title AS ggsan_title,
    n.price_krw,
    n.cate_cd,
    n.cate_label,
    n.image_url,
    n.detail_url,
    n.is_imminent,
    n.first_seen_at,
    (EXTRACT(EPOCH FROM (now() - n.first_seen_at)) / 3600.0)::numeric AS hours_since_arrival,
    t.canonical_name AS trend_name,
    t.category_top,
    ls.trend_score,
    ls.final_score,
    similarity(n.title, t.canonical_name)::real AS sim
  FROM newarrivals n
  CROSS JOIN LATERAL (
    SELECT tp.id, tp.canonical_name, tp.category_top
    FROM jimscanner_trends_products tp
    WHERE tp.canonical_name % n.title       -- pg_trgm 인덱스 활용 (% operator)
    ORDER BY similarity(n.title, tp.canonical_name) DESC
    LIMIT per_goods_limit
  ) t
  JOIN latest_scores ls ON ls.product_id = t.id
  WHERE similarity(n.title, t.canonical_name) >= min_sim
  ORDER BY
    -- 갓 들어온 순(입고경과 오름차순) × 수요 강도 내림차순
    n.first_seen_at DESC,
    ls.final_score DESC,
    similarity(n.title, t.canonical_name) DESC
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출 (anon/authenticated 차단)
REVOKE ALL ON FUNCTION jimscanner_ggsan_newarrival_match(int, float, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_ggsan_newarrival_match(int, float, int, int) TO service_role;
