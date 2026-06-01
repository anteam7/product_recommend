-- ─────────────────────────────────────────────────────────────
-- 수집원 수율 이상탐지 — 'status=ok인데 빈 수확' 무음 고장 감시
--
-- 기존 sources/page.tsx 는 '마지막 run status=ok' 단일 표시뿐이라
--   · status=ok 이지만 fetched>0·inserted=0 인 파서 침묵 고장
--   · naver_blog 24h 1건처럼 정상처럼 보이는 고갈
-- 을 못 잡는다.
--
-- 이 VIEW 는 jimscanner_trends_runs 를 source 별로 롤링 집계해
--   · 정상 수확량 밴드(최근 30일 inserted_count 중앙값 ± MAD)
--   · 정상 실행 간격(연속 run 간 gap 의 중앙값)
--   · 마지막 run / 오늘(24h) 수확
-- 을 산출한다. 등급 분류(정상/저조/무음고장/지연)는 UI(sources/page.tsx)에서
-- 이 밴드를 기준으로 계산한다.
--
-- 적용:  psql "$DATABASE_URL" -f supabase/trends_source_health.sql
-- (View 라 generated types 에는 없으므로 클라이언트 조회 시 `as any` 캐스팅)
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW jimscanner_trends_source_health AS
WITH base AS (
  -- 베이스라인 학습 윈도: 최근 30일
  SELECT source, inserted_count, fetched_count, started_at
  FROM jimscanner_trends_runs
  WHERE started_at >= now() - interval '30 days'
),
med AS (
  SELECT
    source,
    count(*)::int AS runs_30d,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY inserted_count) AS median_inserted,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY fetched_count)  AS median_fetched
  FROM base
  GROUP BY source
),
mad AS (
  -- Median Absolute Deviation — 이상치에 강건한 산포 척도
  SELECT
    b.source,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(b.inserted_count - m.median_inserted)) AS mad_inserted
  FROM base b
  JOIN med m USING (source)
  GROUP BY b.source
),
gaps AS (
  SELECT
    source,
    extract(epoch FROM (
      started_at - lead(started_at) OVER (PARTITION BY source ORDER BY started_at DESC)
    )) / 60.0 AS gap_min
  FROM base
),
interval_med AS (
  SELECT
    source,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_min) AS median_interval_min
  FROM gaps
  WHERE gap_min IS NOT NULL
  GROUP BY source
),
last_run AS (
  SELECT DISTINCT ON (source)
    source,
    started_at    AS last_started_at,
    status        AS last_status,
    inserted_count AS last_inserted,
    fetched_count  AS last_fetched,
    duration_ms    AS last_duration_ms,
    error_message  AS last_error
  FROM jimscanner_trends_runs
  ORDER BY source, started_at DESC
),
today AS (
  -- 최근 24h 수확
  SELECT
    source,
    count(*)::int           AS today_runs,
    coalesce(sum(inserted_count), 0)::int AS today_inserted,
    coalesce(sum(fetched_count), 0)::int  AS today_fetched
  FROM jimscanner_trends_runs
  WHERE started_at >= now() - interval '24 hours'
  GROUP BY source
)
SELECT
  m.source,
  m.runs_30d,
  m.median_inserted,
  COALESCE(d.mad_inserted, 0)        AS mad_inserted,
  m.median_fetched,
  iv.median_interval_min,
  lr.last_started_at,
  lr.last_status,
  lr.last_inserted,
  lr.last_fetched,
  lr.last_duration_ms,
  lr.last_error,
  COALESCE(t.today_runs, 0)          AS today_runs,
  COALESCE(t.today_inserted, 0)      AS today_inserted,
  COALESCE(t.today_fetched, 0)       AS today_fetched
FROM med m
LEFT JOIN mad d        USING (source)
LEFT JOIN interval_med iv USING (source)
LEFT JOIN last_run lr  USING (source)
LEFT JOIN today t      USING (source);

COMMENT ON VIEW jimscanner_trends_source_health IS
  '수집원 수율 이상탐지: source 별 정상 수확량 밴드(중앙값±MAD)·정상 실행간격·마지막/오늘 수확. 무음 고장(fetched>0·inserted=0) 탐지의 기준 데이터.';
