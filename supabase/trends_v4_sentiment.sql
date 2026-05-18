-- ─────────────────────────────────────────────────────────────
-- PR-Sentiment: 감성 극성 게이트 (2026-05-19)
-- ─────────────────────────────────────────────────────────────
-- 포럼·뉴스·블로그 raw 포스트(82cook, ppomppu, dcinside, natepan,
-- daum_news, naver_news, naver_blog 등)에서 product 단위 감성
-- 극성(positive/neutral/negative/mixed) 을 LLM 배치로 분류해
-- 시계열 누적. quality_momentum 산출용.
--
-- 노출 정책: 어드민(service-role)만. 기존 jimscanner_trends_* 패턴.
-- ─────────────────────────────────────────────────────────────

-- 1) 일자×제품×소스 단위 누적 카운트
CREATE TABLE IF NOT EXISTS jimscanner_trends_sentiment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  day date NOT NULL,
  source text NOT NULL,                 -- '82cook' | 'ppomppu' | 'dcinside' | 'natepan' | 'daum_news' | 'naver_news' | 'naver_blog' 등

  pos_count int NOT NULL DEFAULT 0,
  neu_count int NOT NULL DEFAULT 0,
  neg_count int NOT NULL DEFAULT 0,
  mix_count int NOT NULL DEFAULT 0,

  sample_excerpts jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{polarity, snippet, url}], 상위 3~5개

  llm_model text,
  classified_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (product_id, day, source)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_sentiment_product_day
  ON jimscanner_trends_sentiment(product_id, day DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_sentiment_day_source
  ON jimscanner_trends_sentiment(day DESC, source);

ALTER TABLE jimscanner_trends_sentiment ENABLE ROW LEVEL SECURITY;

-- 2) 일자별 product 종합 polarity 머터리얼라이즈드 뷰
--    sources 통합 카운트 + ratio + quality_momentum.
--    mention_velocity = day 내 총 멘션 / 7일 평균 멘션 (단순 근사: total_count/7d_total)
--    quality_momentum = total_count * (pos_ratio - 0.8 * neg_ratio)
CREATE MATERIALIZED VIEW IF NOT EXISTS jimscanner_trends_polarity_daily AS
WITH agg AS (
  SELECT
    product_id,
    day,
    SUM(pos_count)::int AS pos_count,
    SUM(neu_count)::int AS neu_count,
    SUM(neg_count)::int AS neg_count,
    SUM(mix_count)::int AS mix_count,
    SUM(pos_count + neu_count + neg_count + mix_count)::int AS total_count,
    ARRAY_AGG(DISTINCT source) AS sources
  FROM jimscanner_trends_sentiment
  GROUP BY product_id, day
),
windowed AS (
  SELECT
    a.*,
    SUM(total_count) OVER (
      PARTITION BY product_id
      ORDER BY day
      RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW
    )::numeric AS total_7d,
    SUM(neg_count) OVER (
      PARTITION BY product_id
      ORDER BY day
      RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW
    )::numeric AS neg_7d
  FROM agg a
)
SELECT
  product_id,
  day,
  pos_count,
  neu_count,
  neg_count,
  mix_count,
  total_count,
  sources,
  CASE WHEN total_count > 0 THEN pos_count::numeric / total_count ELSE 0 END AS pos_ratio,
  CASE WHEN total_count > 0 THEN neg_count::numeric / total_count ELSE 0 END AS neg_ratio,
  CASE WHEN total_count > 0 THEN neu_count::numeric / total_count ELSE 0 END AS neu_ratio,
  CASE WHEN total_count > 0 THEN mix_count::numeric / total_count ELSE 0 END AS mix_ratio,
  total_7d,
  CASE WHEN total_7d > 0 THEN neg_7d / total_7d ELSE 0 END AS neg_ratio_7d,
  -- quality_momentum = mention_velocity × (pos_ratio - λ·neg_ratio)
  -- mention_velocity 는 7d 평균 대비 당일 비율 — 7d 합이 0 이면 0
  CASE
    WHEN total_7d > 0 THEN
      (total_count::numeric / (total_7d / 7.0))
      * (
        (CASE WHEN total_count > 0 THEN pos_count::numeric / total_count ELSE 0 END)
        - 0.8 * (CASE WHEN total_count > 0 THEN neg_count::numeric / total_count ELSE 0 END)
      )
    ELSE 0
  END AS quality_momentum
FROM windowed
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS jimscanner_trends_polarity_daily_pk
  ON jimscanner_trends_polarity_daily(product_id, day);

CREATE INDEX IF NOT EXISTS jimscanner_trends_polarity_daily_day_qm
  ON jimscanner_trends_polarity_daily(day DESC, quality_momentum DESC);

-- 3) LLM 처리 추적: raw 단위로 분류 여부 표시 (재처리 방지)
--    market_raw row 가 이미 sentiment 처리되었음을 표시.
CREATE TABLE IF NOT EXISTS jimscanner_trends_sentiment_seen (
  raw_id uuid PRIMARY KEY,             -- jimscanner_market_raw.id (FK 없이 soft 참조 — raw 가 30일 expire 되어도 seen 은 살아있음)
  classified_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE jimscanner_trends_sentiment_seen ENABLE ROW LEVEL SECURITY;

-- 4) 머터리얼라이즈드 뷰 새로고침 헬퍼 (cron 마지막 단계에서 호출)
CREATE OR REPLACE FUNCTION jimscanner_trends_refresh_polarity_daily()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY jimscanner_trends_polarity_daily;
EXCEPTION
  WHEN feature_not_supported THEN
    -- 인덱스 없는 초기 시점엔 CONCURRENTLY 불가 — 일반 REFRESH 폴백
    REFRESH MATERIALIZED VIEW jimscanner_trends_polarity_daily;
END;
$$ LANGUAGE plpgsql;
