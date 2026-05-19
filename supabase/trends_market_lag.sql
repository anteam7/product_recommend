-- Global→KR 시차 차익 보드 — 해외 best 선행 → 한국 진입 D-day 후보
--
-- 목적: amazon_best_us / rakuten_best_jp / taobao_best_cn 등 해외 베스트셀러를
--      jimscanner_trends_seeds 에 등록하고, 동일 카테고리·속성 페어에 대해
--      '해외 best 진입일 vs 한국 SERP 진입일' 의 lag 분포를 학습.
--
-- 산출:
--  - jimscanner_trends_market_lag           (category_top × foreign_market × kr_proxy_source lag 통계)
--  - jimscanner_trends_arbitrage_candidates (해외 best 진입했지만 한국엔 아직 없는 후보 뷰)
--
-- ─────────────────────────────────────────
-- 1) 해외 베스트 시드 추가 (jimscanner_trends_seeds 활용)
-- 기존 source enum 미사용 — text 라 free-form OK.
INSERT INTO jimscanner_trends_seeds (source, kind, label, config, display_order) VALUES
  ('amazon_best_us',  'foreign_best', 'Amazon US — Best Sellers (Health)',     '{"market":"us","category_top":"health","url":"https://www.amazon.com/Best-Sellers-Health-Personal-Care/zgbs/hpc"}'::jsonb, 100),
  ('amazon_best_us',  'foreign_best', 'Amazon US — Best Sellers (Electronics)','{"market":"us","category_top":"digital","url":"https://www.amazon.com/Best-Sellers-Electronics/zgbs/electronics"}'::jsonb, 101),
  ('amazon_best_us',  'foreign_best', 'Amazon US — Best Sellers (Home)',       '{"market":"us","category_top":"living","url":"https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/home-garden"}'::jsonb, 102),
  ('rakuten_best_jp', 'foreign_best', 'Rakuten JP — Daily Ranking (Health)',   '{"market":"jp","category_top":"health","url":"https://ranking.rakuten.co.jp/daily/551167/"}'::jsonb, 110),
  ('rakuten_best_jp', 'foreign_best', 'Rakuten JP — Daily Ranking (Beauty)',   '{"market":"jp","category_top":"beauty","url":"https://ranking.rakuten.co.jp/daily/100939/"}'::jsonb, 111),
  ('taobao_best_cn',  'foreign_best', 'Taobao CN — TBHot (All)',               '{"market":"cn","category_top":"all","url":"https://www.taobao.com/markets/tbhome/tbhot"}'::jsonb, 120)
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────
-- 2) 시차 분포 학습 테이블
-- (category_top × foreign_market × kr_proxy_source) 별 median/p25/p75 lag.
-- foreign_market: 'us' | 'jp' | 'cn'
-- kr_proxy_source: 'naver_shopping_insight' | 'naver_search_trend' | 'naver_blog' | 'naver_news'
CREATE TABLE IF NOT EXISTS jimscanner_trends_market_lag (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_top text NOT NULL,
  foreign_market text NOT NULL,
  kr_proxy_source text NOT NULL,
  median_lag_days numeric NOT NULL,
  p25_lag_days numeric,
  p75_lag_days numeric,
  n_pairs int NOT NULL DEFAULT 0,
  confidence numeric,                  -- 0~1 (n_pairs 와 분산 기반 외부 계산값)
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category_top, foreign_market, kr_proxy_source)
);
CREATE INDEX IF NOT EXISTS jimscanner_trends_market_lag_lookup
  ON jimscanner_trends_market_lag (category_top, foreign_market);

ALTER TABLE jimscanner_trends_market_lag ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────
-- 3) 해외 best 진입했지만 한국엔 아직 미진입 → 후보 뷰
-- 동일 keyword 가 외국 best (jimscanner_trends_keywords.source IN ('amazon_best_us', ...)) 에
-- 최근 7일 내 등장했지만, 한국 proxy 소스에서 30일간 등장하지 않은 row.
CREATE OR REPLACE VIEW jimscanner_trends_arbitrage_candidates AS
WITH foreign_recent AS (
  SELECT
    k.keyword,
    k.source AS foreign_source,
    k.category_top,
    MIN(k.collected_at) AS first_foreign_seen_at,
    MAX(k.collected_at) AS last_foreign_seen_at
  FROM jimscanner_trends_keywords k
  WHERE k.source IN ('amazon_best_us', 'rakuten_best_jp', 'taobao_best_cn')
    AND k.collected_at >= now() - interval '14 days'
  GROUP BY k.keyword, k.source, k.category_top
),
kr_present AS (
  SELECT DISTINCT k.keyword
  FROM jimscanner_trends_keywords k
  WHERE k.source IN ('naver_shopping_insight', 'naver_search_trend', 'naver_tvtime')
    AND k.collected_at >= now() - interval '30 days'
)
SELECT
  f.keyword,
  f.foreign_source,
  f.category_top,
  f.first_foreign_seen_at,
  f.last_foreign_seen_at,
  -- '진입 마감일' = first_foreign_seen + market_lag.median_lag_days
  (f.first_foreign_seen_at + (COALESCE(l.median_lag_days, 30) || ' days')::interval) AS kr_entry_deadline,
  GREATEST(
    0,
    DATE_PART(
      'day',
      (f.first_foreign_seen_at + (COALESCE(l.median_lag_days, 30) || ' days')::interval) - now()
    )::int
  ) AS d_day_remaining,
  l.median_lag_days,
  l.p25_lag_days,
  l.p75_lag_days,
  l.n_pairs,
  l.confidence
FROM foreign_recent f
LEFT JOIN kr_present p ON p.keyword = f.keyword
LEFT JOIN jimscanner_trends_market_lag l
  ON l.category_top = COALESCE(f.category_top, 'unknown')
 AND l.foreign_market = CASE
       WHEN f.foreign_source = 'amazon_best_us'  THEN 'us'
       WHEN f.foreign_source = 'rakuten_best_jp' THEN 'jp'
       WHEN f.foreign_source = 'taobao_best_cn'  THEN 'cn'
       ELSE 'unknown'
     END
 AND l.kr_proxy_source = 'naver_shopping_insight'
WHERE p.keyword IS NULL  -- 한국엔 아직 안 보임
ORDER BY d_day_remaining ASC, f.last_foreign_seen_at DESC;

COMMENT ON VIEW jimscanner_trends_arbitrage_candidates IS
  '해외 best 에 최근 14d 내 진입했지만 한국 proxy(샵인사이트/검색트렌드/TV) 30d 에 없는 키워드.
   median_lag_days 기준으로 한국 진입 마감 D-day 계산.';
