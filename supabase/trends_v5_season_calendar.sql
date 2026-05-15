-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v5 — 12주 시즌 캘린더 (forward-looking)
-- ─────────────────────────────────────────────────────────────
-- 목적: 과거 누적된 naver_search_trend / shopping_insight / naver_tvtime 시계열을
--       ISO 주차 단위로 집계해 카테고리·키워드별 연간 시즌 곡선을 만들고,
--       향후 12주 (W+1 ~ W+12) 셀에 '진입 예정' 카테고리/상품을 표시한다.
--
-- 정책: 기존 jimscanner_trends_* 와 동일 (RLS enable, service-role 만 접근).
-- 갱신: 매일 KST 06:10 recompute cron 끝나면
--       REFRESH MATERIALIZED VIEW CONCURRENTLY jimscanner_trends_season_calendar;
-- ─────────────────────────────────────────────────────────────

DROP MATERIALIZED VIEW IF EXISTS jimscanner_trends_season_calendar;

CREATE MATERIALIZED VIEW jimscanner_trends_season_calendar AS
WITH base AS (
  SELECT
    EXTRACT(WEEK FROM (collected_at AT TIME ZONE 'Asia/Seoul'))::int AS iso_week,
    COALESCE(NULLIF(category_top, ''), 'unknown')                    AS category_top,
    keyword,
    AVG(volume_relative)::numeric                                    AS avg_volume,
    COUNT(*)::int                                                    AS row_count
  FROM jimscanner_trends_keywords
  WHERE volume_relative IS NOT NULL
  GROUP BY 1, 2, 3
),
category_week AS (
  SELECT
    iso_week,
    category_top,
    (SUM(avg_volume * row_count) / NULLIF(SUM(row_count), 0))::numeric AS week_volume,
    SUM(row_count)::int                                                AS week_rows
  FROM base
  GROUP BY 1, 2
),
annual AS (
  SELECT
    category_top,
    AVG(week_volume)::numeric AS annual_mean_volume,
    COUNT(*)::int             AS weeks_observed
  FROM category_week
  GROUP BY 1
),
ranked_anchors AS (
  SELECT
    iso_week,
    category_top,
    keyword,
    avg_volume,
    row_count,
    ROW_NUMBER() OVER (
      PARTITION BY iso_week, category_top
      ORDER BY avg_volume DESC NULLS LAST, row_count DESC
    ) AS rnk
  FROM base
),
anchors AS (
  SELECT
    iso_week,
    category_top,
    jsonb_agg(
      jsonb_build_object(
        'keyword',    keyword,
        'avg_volume', round(avg_volume, 2),
        'rows',       row_count
      )
      ORDER BY avg_volume DESC NULLS LAST
    ) AS anchor_keywords
  FROM ranked_anchors
  WHERE rnk <= 5
  GROUP BY 1, 2
)
SELECT
  cw.iso_week,
  cw.category_top,
  cw.week_volume                                          AS baseline_volume,
  cw.week_rows                                            AS baseline_rows,
  a.annual_mean_volume,
  CASE
    WHEN a.annual_mean_volume IS NULL OR a.annual_mean_volume = 0 THEN 0
    ELSE round(((cw.week_volume - a.annual_mean_volume) / a.annual_mean_volume) * 100, 2)
  END                                                     AS expected_uplift_pct,
  LEAST(
    100,
    round(
      (LEAST(cw.week_rows, 200)::numeric / 200.0) * 60
      + (LEAST(a.weeks_observed, 52)::numeric / 52.0) * 40,
      2
    )
  )                                                       AS confidence_score,
  COALESCE(an.anchor_keywords, '[]'::jsonb)               AS anchor_keywords,
  now()                                                   AS computed_at
FROM category_week cw
LEFT JOIN annual  a  USING (category_top)
LEFT JOIN anchors an USING (iso_week, category_top);

CREATE UNIQUE INDEX IF NOT EXISTS jimscanner_trends_season_calendar_pk
  ON jimscanner_trends_season_calendar (iso_week, category_top);

CREATE INDEX IF NOT EXISTS jimscanner_trends_season_calendar_uplift
  ON jimscanner_trends_season_calendar (expected_uplift_pct DESC);

-- 초기 빌드
REFRESH MATERIALIZED VIEW jimscanner_trends_season_calendar;

-- 운영 메모:
--   1) 매트뷰는 단순 row-count 기반 confidence. 실 운영 1년 누적 후 weeks_observed 가
--      30+ 가 되면 confidence 가 자연스럽게 60~100 으로 올라간다.
--   2) UI 는 ISO week + KST 기준으로 현재 주차 산출 후 (week+1 ~ week+12) 매핑.
--      53주차 wrap-around 는 mod 52 + 1 로 처리.
--   3) 권장 위탁 등록일 = 피크 주 - 4주 (셀러가 발주 → 통관 → 등록 → SEO 노출 리드타임).
