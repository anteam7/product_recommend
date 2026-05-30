-- ────────────────────────────────────────────────────────────
-- ggsan 신상 입고 레이더 RPC (supply-first, 2026-05-31)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/ggsan-arrivals
-- 기존 recommend RPC 는 모두 수요→ggsan(demand-first) 방향이라
-- 도매처가 새로 들여놓은 상품(first_seen_at)은 갱신순에 묻혀 안 보임.
-- 본 RPC 는 first_seen_at 을 1차 신호로 쓰는 supply-first 보드:
--   ① 최근 N일 신규 입고 상품을 입고일순으로 추출
--   ② recommend RPC 의 trigram 매칭 로직 재사용 → 각 신상의 수요부착도 계산
--      (TV 편성 naver_tvtime + 검색·쇼핑 시그널)
--   ③ ggsan_price_history 로 입고 후 가격 추세(스파크라인 + 변동률)
-- 3분면 분류(quadrant)는 페이지단에서 demand_score·price_change_pct 로 수행.
-- 신규 테이블 불필요 — first_seen_at·price_history 기존 보유.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_ggsan_new_arrivals(
  arrival_days int DEFAULT 14,    -- 신규 입고 윈도우 (first_seen_at 기준)
  min_sim float DEFAULT 0.20,     -- trigram 유사도 하한
  demand_days int DEFAULT 30,     -- 수요 시그널 집계 윈도우
  result_limit int DEFAULT 200
)
RETURNS TABLE (
  goods_no text,
  title text,
  cate_cd text,
  cate_label text,
  price_krw int,
  is_imminent boolean,
  image_url text,
  detail_url text,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  days_since_arrival int,
  -- 수요부착도
  demand_score real,
  tv_match_count int,
  tv_top_keyword text,
  search_match_count int,
  search_top_keyword text,
  search_sources text[],
  -- 가격 추세
  price_first int,
  price_latest int,
  price_change_pct real,
  price_points int[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  -- 1) 최근 N일 신규 입고 상품 (1차 신호)
  arrivals AS (
    SELECT
      gp.goods_no, gp.title, gp.cate_cd, gp.cate_label, gp.price_krw,
      gp.is_imminent, gp.image_url, gp.detail_url,
      gp.first_seen_at, gp.last_seen_at
    FROM jimscanner_ggsan_products gp
    WHERE gp.first_seen_at > now() - (arrival_days || ' days')::interval
  ),

  -- 2) 수요 키워드 (TV 편성 + 검색·쇼핑, recommend RPC 와 동일 소스)
  demand_keywords AS (
    SELECT keyword, source, COUNT(*)::int AS occurrences
    FROM jimscanner_trends_keywords
    WHERE source IN (
      'naver_tvtime',
      'naver_shopping_hot',
      'naver_search_trend',
      'aliex_best',
      'musinsa_best'
    )
      AND collected_at > now() - (demand_days || ' days')::interval
    GROUP BY keyword, source
  ),
  -- 3) 신상 ↔ 수요 키워드 trigram 매칭 (recommend 로직 재사용)
  matches AS (
    SELECT
      a.goods_no,
      dk.keyword,
      dk.source,
      dk.occurrences::real * similarity(dk.keyword, a.title) AS strength
    FROM arrivals a
    JOIN demand_keywords dk ON a.title % dk.keyword
    WHERE similarity(dk.keyword, a.title) >= min_sim
  ),
  match_agg AS (
    SELECT
      goods_no,
      SUM(strength)::real AS demand_score,
      COUNT(DISTINCT keyword) FILTER (WHERE source = 'naver_tvtime')::int AS tv_match_count,
      (ARRAY_AGG(keyword ORDER BY strength DESC)
         FILTER (WHERE source = 'naver_tvtime'))[1] AS tv_top_keyword,
      COUNT(DISTINCT keyword) FILTER (WHERE source <> 'naver_tvtime')::int AS search_match_count,
      (ARRAY_AGG(keyword ORDER BY strength DESC)
         FILTER (WHERE source <> 'naver_tvtime'))[1] AS search_top_keyword,
      ARRAY_AGG(DISTINCT source) FILTER (WHERE source <> 'naver_tvtime') AS search_sources
    FROM matches
    GROUP BY goods_no
  ),

  -- 4) 입고 후 가격 추세 (price_history 시계열)
  price_agg AS (
    SELECT
      ph.goods_no,
      (ARRAY_AGG(ph.price_krw ORDER BY ph.observed_at ASC))[1] AS price_first,
      (ARRAY_AGG(ph.price_krw ORDER BY ph.observed_at DESC))[1] AS price_latest,
      ARRAY_AGG(ph.price_krw ORDER BY ph.observed_at ASC) AS price_points
    FROM jimscanner_ggsan_price_history ph
    JOIN arrivals a ON a.goods_no = ph.goods_no
    WHERE ph.price_krw IS NOT NULL
    GROUP BY ph.goods_no
  )

  SELECT
    a.goods_no, a.title, a.cate_cd, a.cate_label, a.price_krw, a.is_imminent,
    a.image_url, a.detail_url, a.first_seen_at, a.last_seen_at,
    GREATEST(0, EXTRACT(DAY FROM now() - a.first_seen_at)::int) AS days_since_arrival,
    COALESCE(m.demand_score, 0)::real AS demand_score,
    COALESCE(m.tv_match_count, 0) AS tv_match_count,
    COALESCE(m.tv_top_keyword, '') AS tv_top_keyword,
    COALESCE(m.search_match_count, 0) AS search_match_count,
    COALESCE(m.search_top_keyword, '') AS search_top_keyword,
    COALESCE(m.search_sources, ARRAY[]::text[]) AS search_sources,
    COALESCE(p.price_first, a.price_krw) AS price_first,
    COALESCE(p.price_latest, a.price_krw) AS price_latest,
    (CASE
       WHEN COALESCE(p.price_first, 0) > 0
         THEN (((COALESCE(p.price_latest, a.price_krw) - p.price_first)::real / p.price_first) * 100)
       ELSE 0
     END)::real AS price_change_pct,
    COALESCE(p.price_points, ARRAY[]::int[]) AS price_points
  FROM arrivals a
  LEFT JOIN match_agg m ON m.goods_no = a.goods_no
  LEFT JOIN price_agg p ON p.goods_no = a.goods_no
  ORDER BY a.first_seen_at DESC
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출
REVOKE ALL ON FUNCTION jimscanner_ggsan_new_arrivals(int, float, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_ggsan_new_arrivals(int, float, int, int) TO service_role;
