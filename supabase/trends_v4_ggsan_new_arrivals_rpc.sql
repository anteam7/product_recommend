-- ────────────────────────────────────────────────────────────
-- ggsan 신규 입고 SKU First-Mover 보드 RPC (2026-05-16)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/new-arrivals
-- 컨셉: jimscanner_ggsan_products.first_seen_at 기준 최근 N일 내 신상만 필터,
--       같은 윈도우의 트렌드 시그널 (TV / 검색·쇼핑 / 뉴스·블로그) 과 trgm 매칭하여
--       first_mover_score = base × (1 + signal_count) × imminent_bonus 계산
--       base = max(0, 1 - aging_days / max_aging) — 신선할수록 점수 ↑
-- 기존 jimscanner_ggsan_recommend 와 달리 'time-on-market(신선도)' 이 핵심 축.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_ggsan_new_arrivals(
  days_window int DEFAULT 7,        -- first_seen_at 윈도우 (3/7/14)
  signal_window int DEFAULT 14,     -- 시그널 누적 윈도우
  min_sim float DEFAULT 0.20,
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
  aging_days int,
  -- 시그널 카운트
  tv_signal_count int,
  tv_top_keyword text,
  search_signal_count int,
  search_top_keyword text,
  news_signal_count int,
  news_top_keyword text,
  total_signal_count int,
  -- 점수
  base_score real,
  imminent_bonus real,
  first_mover_score real
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  -- 0) 윈도우 내 신상 후보
  fresh AS (
    SELECT
      gp.goods_no, gp.title, gp.cate_cd, gp.cate_label, gp.price_krw,
      gp.is_imminent, gp.image_url, gp.detail_url, gp.first_seen_at,
      GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - gp.first_seen_at)) / 86400))::int AS aging_days
    FROM jimscanner_ggsan_products gp
    WHERE gp.first_seen_at > now() - (days_window || ' days')::interval
      AND gp.status <> 'removed'
  ),

  -- 1) TV 편성 시그널
  tv_keywords AS (
    SELECT keyword, COUNT(*)::int AS k_count
    FROM jimscanner_trends_keywords
    WHERE source = 'naver_tvtime'
      AND collected_at > now() - (signal_window || ' days')::interval
    GROUP BY keyword
  ),
  tv_matches AS (
    SELECT
      f.goods_no,
      tv.keyword,
      tv.k_count,
      similarity(tv.keyword, f.title) AS sim,
      (tv.k_count::real * similarity(tv.keyword, f.title)) AS strength
    FROM tv_keywords tv
    CROSS JOIN LATERAL (
      SELECT goods_no, title FROM fresh
      WHERE title % tv.keyword
    ) f
    WHERE similarity(tv.keyword, f.title) >= min_sim
  ),
  tv_agg AS (
    SELECT
      goods_no,
      COUNT(DISTINCT keyword)::int AS tv_signal_count,
      (ARRAY_AGG(keyword ORDER BY strength DESC))[1] AS tv_top_keyword
    FROM tv_matches
    GROUP BY goods_no
  ),

  -- 2) 검색·쇼핑 시그널
  search_keywords AS (
    SELECT keyword, COUNT(*)::int AS k_count
    FROM jimscanner_trends_keywords
    WHERE source IN (
      'naver_shopping_hot',
      'naver_search_trend',
      'aliex_best',
      'musinsa_best'
    )
      AND collected_at > now() - (signal_window || ' days')::interval
    GROUP BY keyword
  ),
  search_matches AS (
    SELECT
      f.goods_no,
      sk.keyword,
      sk.k_count,
      similarity(sk.keyword, f.title) AS sim,
      (sk.k_count::real * similarity(sk.keyword, f.title)) AS strength
    FROM search_keywords sk
    CROSS JOIN LATERAL (
      SELECT goods_no, title FROM fresh
      WHERE title % sk.keyword
    ) f
    WHERE similarity(sk.keyword, f.title) >= min_sim
  ),
  search_agg AS (
    SELECT
      goods_no,
      COUNT(DISTINCT keyword)::int AS search_signal_count,
      (ARRAY_AGG(keyword ORDER BY strength DESC))[1] AS search_top_keyword
    FROM search_matches
    GROUP BY goods_no
  ),

  -- 3) 뉴스·블로그·자동완성 시그널 (market_raw)
  --    market_raw.title 의 trigram 을 신상 title 과 매칭 — 매칭 row 수가 곧 시그널 카운트
  news_matches AS (
    SELECT
      f.goods_no,
      mr.title AS mr_title,
      similarity(COALESCE(mr.title, ''), f.title) AS sim
    FROM jimscanner_market_raw mr
    CROSS JOIN LATERAL (
      SELECT goods_no, title FROM fresh
      WHERE mr.title IS NOT NULL AND title % mr.title
    ) f
    WHERE mr.captured_at > now() - (signal_window || ' days')::interval
      AND mr.title IS NOT NULL
      AND similarity(mr.title, f.title) >= min_sim
  ),
  news_agg AS (
    SELECT
      goods_no,
      COUNT(*)::int AS news_signal_count,
      (ARRAY_AGG(mr_title ORDER BY sim DESC))[1] AS news_top_keyword
    FROM news_matches
    GROUP BY goods_no
  )

  SELECT
    f.goods_no,
    f.title,
    f.cate_cd,
    f.cate_label,
    f.price_krw,
    f.is_imminent,
    f.image_url,
    f.detail_url,
    f.first_seen_at,
    f.aging_days,
    COALESCE(tv.tv_signal_count, 0) AS tv_signal_count,
    COALESCE(tv.tv_top_keyword, '') AS tv_top_keyword,
    COALESCE(s.search_signal_count, 0) AS search_signal_count,
    COALESCE(s.search_top_keyword, '') AS search_top_keyword,
    COALESCE(n.news_signal_count, 0) AS news_signal_count,
    COALESCE(n.news_top_keyword, '') AS news_top_keyword,
    (
      COALESCE(tv.tv_signal_count, 0)
      + COALESCE(s.search_signal_count, 0)
      + COALESCE(n.news_signal_count, 0)
    ) AS total_signal_count,
    -- base = max(0, 1 - aging_days / 14)
    GREATEST(0::real, (1.0 - f.aging_days::real / 14.0))::real AS base_score,
    (CASE WHEN f.is_imminent THEN 1.3 ELSE 1.0 END)::real AS imminent_bonus,
    (
      GREATEST(0::real, (1.0 - f.aging_days::real / 14.0))
      * (1 + COALESCE(tv.tv_signal_count, 0)
           + COALESCE(s.search_signal_count, 0)
           + COALESCE(n.news_signal_count, 0))
      * (CASE WHEN f.is_imminent THEN 1.3 ELSE 1.0 END)
    )::real AS first_mover_score
  FROM fresh f
  LEFT JOIN tv_agg     tv ON tv.goods_no = f.goods_no
  LEFT JOIN search_agg s  ON s.goods_no  = f.goods_no
  LEFT JOIN news_agg   n  ON n.goods_no  = f.goods_no
  ORDER BY
    (CASE WHEN f.is_imminent THEN 1 ELSE 0 END) DESC,
    (
      GREATEST(0::real, (1.0 - f.aging_days::real / 14.0))
      * (1 + COALESCE(tv.tv_signal_count, 0)
           + COALESCE(s.search_signal_count, 0)
           + COALESCE(n.news_signal_count, 0))
      * (CASE WHEN f.is_imminent THEN 1.3 ELSE 1.0 END)
    ) DESC,
    f.first_seen_at DESC
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_ggsan_new_arrivals(int, int, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_ggsan_new_arrivals(int, int, float, int) TO service_role;
