-- ────────────────────────────────────────────────────────────
-- Intent Funnel (정보→거래 검색의도 전환 lag) — 2026-05-19
-- ────────────────────────────────────────────────────────────
-- naver_blog/naver_news (정보형) 와 naver_shopping_insight/naver_shopping_hot
-- (거래형) 시그널을 jimscanner_market_raw 에서 키워드 단위로 매칭하여
-- 정보형 부상 시점(info_peak_at) → 거래형 부상 시점(txn_peak_at) 의 lag(일) 을
-- 계산한다.
--
-- 운영 의도:
--   stage = 'info_only'      → 정보형만 떴음, 거래형 아직 (= D-day 골든타임 후보)
--   stage = 'info_leads'     → 정보형이 먼저 부상한 뒤 거래형 부상 (lag_days > 0)
--   stage = 'txn_leads'      → 거래형이 먼저 — 일반적이지 않은 케이스 (관여재 등)
--   stage = 'simultaneous'   → 같은 날 부상
--   stage = 'txn_only'       → 거래형만 있고 정보형 시그널 없음
--
-- 뷰만 추가 (테이블 변경 없음). RLS 는 underlying jimscanner_market_raw 가
-- service-role only 이므로 view 도 service-role 에서만 SELECT 가능.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW jimscanner_trends_intent_funnel AS
WITH info_daily AS (
  SELECT
    lower(btrim(coalesce(nullif(query, ''), nullif(title, '')))) AS keyword,
    (captured_at AT TIME ZONE 'Asia/Seoul')::date          AS day,
    count(*)::int                                          AS cnt
  FROM jimscanner_market_raw
  WHERE source IN ('naver_blog', 'naver_news')
    AND captured_at >= now() - interval '90 days'
    AND coalesce(nullif(query, ''), nullif(title, '')) IS NOT NULL
  GROUP BY 1, 2
),
txn_daily AS (
  SELECT
    lower(btrim(coalesce(nullif(query, ''), nullif(title, '')))) AS keyword,
    (captured_at AT TIME ZONE 'Asia/Seoul')::date          AS day,
    count(*)::int                                          AS cnt,
    max(nullif(metadata->>'category', ''))                 AS category
  FROM jimscanner_market_raw
  WHERE source IN ('naver_shopping_insight', 'naver_shopping_hot')
    AND captured_at >= now() - interval '90 days'
    AND coalesce(nullif(query, ''), nullif(title, '')) IS NOT NULL
  GROUP BY 1, 2
),
info_peak AS (
  SELECT DISTINCT ON (keyword)
    keyword,
    day  AS info_peak_at,
    cnt  AS info_peak_cnt
  FROM info_daily
  ORDER BY keyword, cnt DESC, day DESC
),
txn_peak AS (
  SELECT DISTINCT ON (keyword)
    keyword,
    day      AS txn_peak_at,
    cnt      AS txn_peak_cnt,
    category AS txn_peak_category
  FROM txn_daily
  ORDER BY keyword, cnt DESC, day DESC
),
info_first AS (
  SELECT keyword, min(day) AS info_first_at, sum(cnt) AS info_total
  FROM info_daily
  GROUP BY 1
),
txn_first AS (
  SELECT keyword, min(day) AS txn_first_at, sum(cnt) AS txn_total,
         max(category) AS category
  FROM txn_daily
  GROUP BY 1
),
universe AS (
  SELECT keyword FROM info_peak
  UNION
  SELECT keyword FROM txn_peak
)
SELECT
  u.keyword,
  COALESCE(tf.category, tp.txn_peak_category)              AS category,
  ip.info_peak_at,
  tp.txn_peak_at,
  if_.info_first_at,
  tf.txn_first_at,
  CASE
    WHEN ip.info_peak_at IS NOT NULL AND tp.txn_peak_at IS NOT NULL
      THEN (tp.txn_peak_at - ip.info_peak_at)::int
    ELSE NULL
  END                                                       AS lag_days,
  COALESCE(if_.info_total, 0)::int                          AS info_total,
  COALESCE(tf.txn_total, 0)::int                            AS txn_total,
  COALESCE(ip.info_peak_cnt, 0)::int                        AS info_peak_cnt,
  COALESCE(tp.txn_peak_cnt, 0)::int                         AS txn_peak_cnt,
  CASE
    WHEN COALESCE(if_.info_total, 0) = 0 THEN NULL
    ELSE round(COALESCE(tf.txn_total, 0)::numeric
               / NULLIF(if_.info_total, 0)::numeric, 3)
  END                                                       AS conversion_ratio,
  CASE
    WHEN tp.txn_peak_at IS NULL AND ip.info_peak_at IS NOT NULL THEN 'info_only'
    WHEN ip.info_peak_at IS NULL AND tp.txn_peak_at IS NOT NULL THEN 'txn_only'
    WHEN tp.txn_peak_at > ip.info_peak_at THEN 'info_leads'
    WHEN tp.txn_peak_at < ip.info_peak_at THEN 'txn_leads'
    ELSE 'simultaneous'
  END                                                       AS stage,
  -- D-day = 과거에 학습된 카테고리 평균 lag 기반 예상 거래형 부상일.
  -- info_only 단계에서 의미가 큼 (= 운영자가 행동해야 할 시점까지 남은 일수).
  CASE
    WHEN tp.txn_peak_at IS NULL AND ip.info_peak_at IS NOT NULL THEN
      GREATEST(0, (ip.info_peak_at + interval '14 days')::date
                  - (now() AT TIME ZONE 'Asia/Seoul')::date)
    ELSE NULL
  END                                                       AS d_day
FROM universe u
LEFT JOIN info_peak  ip  ON ip.keyword  = u.keyword
LEFT JOIN txn_peak   tp  ON tp.keyword  = u.keyword
LEFT JOIN info_first if_ ON if_.keyword = u.keyword
LEFT JOIN txn_first  tf  ON tf.keyword  = u.keyword;

COMMENT ON VIEW jimscanner_trends_intent_funnel IS
  '정보형(naver_blog/news) → 거래형(naver_shopping_insight/hot) 검색의도 전환 lag 분석. '
  '운영자 행동 신호: stage=info_only & d_day 작음 → 진입 골든타임.';
