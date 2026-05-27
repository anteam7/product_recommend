-- ────────────────────────────────────────────────────────────
-- News-as-Leading-Indicator (PR-NEWS-LEAD-1, 2026-05-28)
-- ────────────────────────────────────────────────────────────
-- 가설: 뉴스 보도는 검색 트렌드보다 1~7일 선행. naver_news payload 가
-- jimscanner_market_raw 에 최대 수집원(약 21건/24h)으로 들어오지만
-- 트렌드 레이더 어디서도 소비되지 않음. 본 마이그레이션은:
--   1) news_keyword_mentions: news 본문/제목 명사구를 일자별 mention_count 로 적재
--   2) news_to_search_lag VIEW: keyword 별 first_news_seen → first_search_seen 의 lag(day) 분포
--   3) news_lead_candidates VIEW: 최근 뉴스 burst 됐지만 아직 검색 트렌드에 부상 안 한 키워드
-- ────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1) 일자별 키워드 mention 적재
CREATE TABLE IF NOT EXISTS public.jimscanner_news_keyword_mentions (
  keyword text NOT NULL,
  day date NOT NULL,
  mention_count int NOT NULL DEFAULT 1,
  sample_titles text[] NOT NULL DEFAULT '{}',  -- 최대 5개 sample (디버그용)
  raw_ids uuid[] NOT NULL DEFAULT '{}',         -- 출처 raw row id (최대 20)
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (keyword, day)
);

CREATE INDEX IF NOT EXISTS jimscanner_news_keyword_mentions_day
  ON public.jimscanner_news_keyword_mentions (day DESC);
CREATE INDEX IF NOT EXISTS jimscanner_news_keyword_mentions_keyword_day
  ON public.jimscanner_news_keyword_mentions (keyword, day DESC);
CREATE INDEX IF NOT EXISTS jimscanner_news_keyword_mentions_keyword_trgm
  ON public.jimscanner_news_keyword_mentions USING gin (keyword gin_trgm_ops);

ALTER TABLE public.jimscanner_news_keyword_mentions ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role) 만. 공개 SELECT 정책 없음.

-- 2) 키워드별 news → search lag (day) 분포 — keyword 가 두 테이블에 모두 존재할 때만
DROP VIEW IF EXISTS public.jimscanner_news_to_search_lag CASCADE;
CREATE VIEW public.jimscanner_news_to_search_lag AS
WITH news_first AS (
  SELECT keyword, min(day)::timestamptz AS first_news_day,
         sum(mention_count) AS total_mentions
  FROM public.jimscanner_news_keyword_mentions
  GROUP BY keyword
),
search_first AS (
  SELECT lower(keyword) AS keyword, min(collected_at) AS first_search_at
  FROM public.jimscanner_trends_keywords
  WHERE source IN ('naver_shopping_insight', 'naver_search_trend', 'naver_tvtime')
  GROUP BY lower(keyword)
)
SELECT n.keyword,
       n.first_news_day,
       s.first_search_at,
       n.total_mentions,
       EXTRACT(EPOCH FROM (s.first_search_at - n.first_news_day)) / 86400.0 AS lag_days
FROM news_first n
JOIN search_first s ON s.keyword = lower(n.keyword)
WHERE s.first_search_at > n.first_news_day;  -- 뉴스가 선행한 경우만

-- 3) lag 분위수 요약 (P50 / P90) — UI 에 학습된 lag 표시
DROP VIEW IF EXISTS public.jimscanner_news_lag_summary CASCADE;
CREATE VIEW public.jimscanner_news_lag_summary AS
SELECT
  count(*)::int AS sample_size,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY lag_days)::numeric(8,2) AS p50_lag_days,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY lag_days)::numeric(8,2) AS p90_lag_days,
  avg(lag_days)::numeric(8,2) AS avg_lag_days,
  max(lag_days)::numeric(8,2) AS max_lag_days
FROM public.jimscanner_news_to_search_lag;

-- 4) 선점창 OPEN 후보 — 최근 burst 뉴스 + 검색 트렌드 미부상 키워드
DROP VIEW IF EXISTS public.jimscanner_news_lead_candidates CASCADE;
CREATE VIEW public.jimscanner_news_lead_candidates AS
WITH recent_burst AS (
  -- 최근 7일 내 뉴스 mention 합산 키워드
  SELECT
    m.keyword,
    sum(m.mention_count) AS recent_mentions,
    max(m.day) AS last_news_day,
    min(m.day) AS first_news_day_recent,
    (array_agg(m.sample_titles ORDER BY m.day DESC))[1] AS latest_titles
  FROM public.jimscanner_news_keyword_mentions m
  WHERE m.day >= (current_date - interval '7 days')::date
  GROUP BY m.keyword
  HAVING sum(m.mention_count) >= 2  -- 단발성 노이즈 컷
),
search_seen AS (
  -- 같은 키워드가 검색 트렌드에 최근 30일 등장했는지
  SELECT lower(keyword) AS keyword, max(collected_at) AS last_search_at
  FROM public.jimscanner_trends_keywords
  WHERE collected_at >= now() - interval '30 days'
    AND source IN ('naver_shopping_insight', 'naver_search_trend', 'naver_tvtime')
  GROUP BY lower(keyword)
),
lag_p50 AS (
  SELECT COALESCE((SELECT p50_lag_days FROM public.jimscanner_news_lag_summary), 3.0)::numeric AS p50
)
SELECT
  r.keyword,
  r.recent_mentions,
  r.last_news_day,
  r.first_news_day_recent,
  r.latest_titles,
  s.last_search_at,
  (s.last_search_at IS NULL) AS search_unseen_30d,
  (current_date - r.first_news_day_recent) AS days_since_news_first,
  (SELECT p50 FROM lag_p50) AS learned_p50_lag,
  -- 선점창 OPEN = 검색 미부상 AND 뉴스 등장한 지 P50 lag 이내
  CASE
    WHEN s.last_search_at IS NULL
     AND (current_date - r.first_news_day_recent) <= (SELECT p50 FROM lag_p50)
    THEN true
    ELSE false
  END AS preempt_window_open
FROM recent_burst r
LEFT JOIN search_seen s ON s.keyword = lower(r.keyword);

-- 5) 후보 + ggsan trgm 매칭 RPC
DROP FUNCTION IF EXISTS public.jimscanner_news_lead_with_ggsan(int, numeric, int);
CREATE OR REPLACE FUNCTION public.jimscanner_news_lead_with_ggsan(
  result_limit int DEFAULT 50,
  min_sim numeric DEFAULT 0.2,
  per_keyword_limit int DEFAULT 3
)
RETURNS TABLE (
  keyword text,
  recent_mentions int,
  last_news_day date,
  first_news_day_recent date,
  latest_titles text[],
  search_unseen_30d boolean,
  days_since_news_first int,
  learned_p50_lag numeric,
  preempt_window_open boolean,
  goods_no text,
  ggsan_title text,
  price_krw int,
  is_imminent boolean,
  cate_cd text,
  cate_label text,
  image_url text,
  detail_url text,
  sim real
)
LANGUAGE sql STABLE AS $$
  WITH cands AS (
    SELECT * FROM public.jimscanner_news_lead_candidates
    ORDER BY preempt_window_open DESC, recent_mentions DESC, last_news_day DESC
    LIMIT result_limit
  ),
  matched AS (
    SELECT
      c.*,
      g.goods_no,
      g.title AS ggsan_title,
      g.price_krw,
      g.is_imminent,
      g.cate_cd,
      g.cate_label,
      g.image_url,
      g.detail_url,
      similarity(g.title, c.keyword) AS sim,
      row_number() OVER (
        PARTITION BY c.keyword
        ORDER BY similarity(g.title, c.keyword) DESC
      ) AS rn
    FROM cands c
    LEFT JOIN public.jimscanner_ggsan_products g
      ON g.title % c.keyword
     AND similarity(g.title, c.keyword) >= min_sim
  )
  SELECT
    keyword, recent_mentions, last_news_day, first_news_day_recent,
    latest_titles, search_unseen_30d, days_since_news_first::int,
    learned_p50_lag, preempt_window_open,
    goods_no, ggsan_title, price_krw, is_imminent,
    cate_cd, cate_label, image_url, detail_url, sim
  FROM matched
  WHERE goods_no IS NULL OR rn <= per_keyword_limit
  ORDER BY preempt_window_open DESC, recent_mentions DESC, sim DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION public.jimscanner_news_lead_with_ggsan(int, numeric, int) TO service_role;
