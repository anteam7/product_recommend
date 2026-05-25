-- 자동완성 드리프트 — 신규 완성어 첫등장 전조 보드
-- 매일 동일 seed 접두어(카테고리 top + 핀 keyword)로 google_suggest / naver autocomplete 를
-- 호출하여 top-N 완성어 시계열을 적재한다.
-- google_suggest 는 raw 가 jimscanner_market_raw 에도 들어가지만, drift 분석은 별도 테이블에서.

CREATE TABLE IF NOT EXISTS jimscanner_autocomplete_snapshots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source       text NOT NULL,                 -- 'google_suggest' / 'naver_autocomplete'
  seed         text NOT NULL,                 -- 시드 접두어 (예: '미국 직구')
  suggestion   text NOT NULL,                 -- 완성어
  rank         int  NOT NULL,                 -- 1-based, top-N 안에서의 등장 순위
  captured_at  timestamptz NOT NULL DEFAULT now()
);

-- 일자 단위 dedup (같은 seed/suggestion/source 가 하루에 여러번 들어가지 않게 cron 쪽에서 가드,
-- 추가로 동일 키 인덱스로 빠른 조회).
CREATE INDEX IF NOT EXISTS jimscanner_autocomplete_snapshots_seed_at
  ON jimscanner_autocomplete_snapshots(source, seed, captured_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_autocomplete_snapshots_sugg_at
  ON jimscanner_autocomplete_snapshots(suggestion, captured_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_autocomplete_snapshots_at
  ON jimscanner_autocomplete_snapshots(captured_at DESC);

ALTER TABLE jimscanner_autocomplete_snapshots ENABLE ROW LEVEL SECURITY;
-- service-role 만.

-- ─────────────────────────────────────────────
-- 파생 뷰: drift (신규 완성어 + 랭크 변동)
--
-- - first_seen_at: 같은 (source, seed, suggestion) 의 최초 등장
-- - latest_at / latest_rank: 가장 최근 등장
-- - days_since_first_seen: 오늘 - first_seen
-- - rank_7d_ago: 7일 전 ± 1.5일 윈도우 안의 평균 rank (없으면 NULL)
-- - rank_delta_7d: (rank_7d_ago - latest_rank). 양수면 상승.
--
-- '신규' 정의: first_seen_at 이 최근 14일 안.
-- '급상승' 정의: rank_delta_7d >= 3.
CREATE OR REPLACE VIEW v_autocomplete_drift AS
WITH agg AS (
  SELECT
    source,
    seed,
    suggestion,
    MIN(captured_at)                                       AS first_seen_at,
    MAX(captured_at)                                       AS latest_at,
    COUNT(*)                                               AS occurrences
  FROM jimscanner_autocomplete_snapshots
  GROUP BY source, seed, suggestion
),
latest AS (
  SELECT DISTINCT ON (source, seed, suggestion)
    source, seed, suggestion, rank AS latest_rank, captured_at AS latest_captured_at
  FROM jimscanner_autocomplete_snapshots
  ORDER BY source, seed, suggestion, captured_at DESC
),
seven_d AS (
  SELECT
    source, seed, suggestion,
    AVG(rank)::numeric(6,2) AS rank_7d_ago
  FROM jimscanner_autocomplete_snapshots
  WHERE captured_at BETWEEN (now() - interval '8 days') AND (now() - interval '6 days')
  GROUP BY source, seed, suggestion
)
SELECT
  a.source,
  a.seed,
  a.suggestion,
  a.first_seen_at,
  a.latest_at,
  a.occurrences,
  EXTRACT(DAY FROM (now() - a.first_seen_at))::int AS days_since_first_seen,
  l.latest_rank,
  s.rank_7d_ago,
  CASE
    WHEN s.rank_7d_ago IS NULL THEN NULL
    ELSE (s.rank_7d_ago - l.latest_rank)::numeric(6,2)
  END AS rank_delta_7d
FROM agg a
LEFT JOIN latest  l USING (source, seed, suggestion)
LEFT JOIN seven_d s USING (source, seed, suggestion);

COMMENT ON VIEW v_autocomplete_drift IS
  '자동완성 드리프트 — 신규/급상승 완성어 분석용. rank_delta_7d>0 이면 순위 상승.';
