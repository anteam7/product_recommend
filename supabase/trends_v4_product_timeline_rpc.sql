-- ────────────────────────────────────────────────────────────
-- 상품 360° 증거 타임라인 RPC (PR-TIMELINE-1, 2026-05-29)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/products/[id] 상세 — "증거 타임라인" 섹션
-- 한 canonical 상품(jimscanner_trends_products)의 alias 집합으로
-- 모든 raw 시그널을 시간순으로 합류시킨 통합 이벤트 배열을 만든다.
--
-- 합류 소스:
--   ① jimscanner_trends_keywords  (naver_search_trend / naver_shopping_insight) → volume_relative 추이
--   ② jimscanner_trends_keywords  (naver_tvtime)                                → TV 편성 마커
--   ③ jimscanner_market_raw       (naver_news / quasarzone_sale)               → 멘션 (title trgm 매칭)
--   ④ jimscanner_ggsan_products   (title trgm 매칭)                            → 도매가·상태 변동
--   ⑤ jimscanner_trends_scores                                                → 우리 측 score 변동 이벤트
--
-- cron 추가 불필요 — 기존 적재 데이터 재조립.
-- service_role 로만 호출 (어드민 한정) — SECURITY DEFINER + grant 명시.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_product_timeline(
  p_product_id uuid,
  days_window int DEFAULT 90,
  ggsan_min_sim float DEFAULT 0.30,
  market_min_sim float DEFAULT 0.30,
  result_limit int DEFAULT 500
)
RETURNS TABLE (
  ts timestamptz,
  source text,       -- 'naver_search_trend' | 'naver_shopping_insight' | 'naver_tvtime' | 'naver_news' | 'quasarzone_sale' | 'ggsan' | 'scores'
  kind text,         -- 'volume' | 'tv_slot' | 'mention' | 'ggsan_price' | 'score'
  label text,        -- 사람이 읽는 한 줄
  delta numeric,     -- volume_relative / price_krw / final_score / score 변화량 (없으면 null)
  url text,          -- 원문 링크 (있으면)
  meta jsonb         -- 자유형 부가정보
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH al AS (
    SELECT DISTINCT alias
    FROM jimscanner_trends_aliases
    WHERE product_id = p_product_id
  ),
  win AS (
    SELECT now() - (days_window || ' days')::interval AS since
  ),

  -- ① + ② 네이버 키워드 시계열 (검색·쇼핑 volume + TV 편성)
  kw AS (
    SELECT
      k.collected_at AS ts,
      k.source       AS source,
      CASE WHEN k.source = 'naver_tvtime' THEN 'tv_slot' ELSE 'volume' END AS kind,
      CASE
        WHEN k.source = 'naver_tvtime'
          THEN k.keyword || COALESCE(' · ' || k.category, '')   -- tvtime 은 category 에 편성시각 저장
        ELSE k.keyword
      END AS label,
      k.volume_relative AS delta,
      NULL::text AS url,
      jsonb_build_object('keyword', k.keyword, 'rank', k.rank, 'category', k.category) AS meta
    FROM jimscanner_trends_keywords k
    JOIN al ON al.alias = k.keyword
    CROSS JOIN win
    WHERE k.collected_at > win.since
  ),

  -- ③ 시장 raw 멘션 (뉴스 / 핫딜) — title trgm 매칭
  mkt AS (
    SELECT DISTINCT ON (m.id)
      m.captured_at AS ts,
      m.source      AS source,
      'mention'     AS kind,
      COALESCE(m.title, m.query, m.source) AS label,
      NULL::numeric AS delta,
      m.source_url  AS url,
      jsonb_build_object('matched_alias', al.alias, 'sim', round(similarity(m.title, al.alias)::numeric, 3)) AS meta
    FROM jimscanner_market_raw m
    JOIN al ON m.title % al.alias
    CROSS JOIN win
    WHERE m.source IN ('naver_news', 'quasarzone_sale')
      AND m.captured_at > win.since
      AND m.title IS NOT NULL
      AND similarity(m.title, al.alias) >= market_min_sim
    ORDER BY m.id, similarity(m.title, al.alias) DESC
  ),

  -- ④ ggsan 도매 상품 변동 — title trgm 매칭 (가격/상태 마지막 변동 시점)
  ggm AS (
    SELECT DISTINCT ON (g.goods_no)
      g.last_changed_at AS ts,
      'ggsan'           AS source,
      'ggsan_price'     AS kind,
      g.title || ' · ' || COALESCE(g.status, 'active') AS label,
      g.price_krw::numeric AS delta,
      g.detail_url      AS url,
      jsonb_build_object(
        'goods_no', g.goods_no,
        'status', g.status,
        'is_imminent', g.is_imminent,
        'matched_alias', al.alias,
        'sim', round(similarity(g.title, al.alias)::numeric, 3)
      ) AS meta
    FROM jimscanner_ggsan_products g
    JOIN al ON g.title % al.alias
    WHERE similarity(g.title, al.alias) >= ggsan_min_sim
    ORDER BY g.goods_no, similarity(g.title, al.alias) DESC
  ),

  -- ⑤ 우리 측 이벤트 — score 변동 (final_score 가 이전과 다를 때만)
  sc AS (
    SELECT
      s.computed_at AS ts,
      'scores'      AS source,
      'score'       AS kind,
      'final ' || s.final_score
        || ' (T' || s.trend_score || ' C' || s.commerce_score
        || ' S' || s.supplier_score || ' X' || s.competition_score || ')' AS label,
      (s.final_score - LAG(s.final_score) OVER (ORDER BY s.computed_at)) AS delta,
      NULL::text AS url,
      jsonb_build_object(
        'final', s.final_score, 'trend', s.trend_score, 'commerce', s.commerce_score,
        'supplier', s.supplier_score, 'competition', s.competition_score
      ) AS meta
    FROM jimscanner_trends_scores s
    CROSS JOIN win
    WHERE s.product_id = p_product_id
      AND s.computed_at > win.since
  )

  SELECT * FROM (
    SELECT ts, source, kind, label, delta, url, meta FROM kw
    UNION ALL
    SELECT ts, source, kind, label, delta, url, meta FROM mkt
    UNION ALL
    SELECT ts, source, kind, label, delta, url, meta FROM ggm
    UNION ALL
    -- 첫 score row (delta null) 는 변동 이벤트가 아니므로 제외, 단 row 가 1개뿐이면 포함
    SELECT ts, source, kind, label, delta, url, meta FROM sc
    WHERE delta IS NULL OR delta <> 0
  ) t
  ORDER BY ts DESC
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출 (anon/authenticated 차단)
REVOKE ALL ON FUNCTION jimscanner_product_timeline(uuid, int, float, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_product_timeline(uuid, int, float, float, int) TO service_role;
