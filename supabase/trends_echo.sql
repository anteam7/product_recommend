-- Cross-Lingual Demand Echo — 한·영·일 동시 트렌드 게이트 (2026-05-27)
-- K-fad vs global sustained 분리를 위한 다국가 echo 시그널 테이블.
--
-- 흐름:
--   1) 한국 시그널(naver_*, google_suggest)에서 핀된 키워드 추출
--   2) 키워드 → 영문/일문 번역 (사전 매핑 또는 LLM 1회 호출)
--   3) Google Trends(US/JP) + Amazon autocomplete(US/JP) + Reddit hits 수집
--   4) echo_score(0~3) 산출
--      0 = K-fad (한국 단발)
--      1 = cross-border (인접국 동시 폭증)
--      2 = global sustained (영미권까지 확산)
--      3 = 전 지역

-- ─────────────────────────────────────────
-- 1) echo raw — 키워드×locale×source 별 hits
CREATE TABLE IF NOT EXISTS jimscanner_trends_echo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword text NOT NULL,                -- 한국어 원본 키워드 (조인 키)
  translated text,                      -- 해당 locale 번역 키워드 (원본일 수도)
  locale text NOT NULL,                 -- 'KR' / 'US' / 'JP'
  source text NOT NULL,                 -- 'google_trends' / 'google_suggest' / 'amazon_autocomplete' / 'reddit' / 'naver_seed'
  hits int NOT NULL DEFAULT 0,          -- source 별 hit 카운트 (autocomplete 항목 수 / mention 수 / trends score)
  score int NOT NULL DEFAULT 0,         -- 합산 echo_score 0~3 (locale 행이 합산 결과를 들고 있을 때만)
  meta jsonb,                           -- 원천 응답 발췌 (디버깅용)
  collected_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jimscanner_trends_echo_keyword_at
  ON jimscanner_trends_echo(keyword, collected_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_echo_locale_at
  ON jimscanner_trends_echo(locale, collected_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_echo_keyword_locale_source
  ON jimscanner_trends_echo(keyword, locale, source, collected_at DESC);

ALTER TABLE jimscanner_trends_echo ENABLE ROW LEVEL SECURITY;
-- service-role 만 (RLS policy 없음).

-- ─────────────────────────────────────────
-- 2) 키워드별 최신 echo 요약 view
-- 키워드 1개당 locale 별 hits 합산 + 가장 최근 score (locale='ALL' 행).
CREATE OR REPLACE VIEW jimscanner_trends_echo_summary AS
WITH latest_per_keyword AS (
  SELECT
    keyword,
    MAX(collected_at) AS last_collected_at
  FROM jimscanner_trends_echo
  GROUP BY keyword
),
latest_rows AS (
  SELECT e.*
  FROM jimscanner_trends_echo e
  INNER JOIN latest_per_keyword l
    ON e.keyword = l.keyword
   AND e.collected_at > l.last_collected_at - INTERVAL '6 hour'
)
SELECT
  keyword,
  MAX(last_collected_at) AS collected_at,
  SUM(CASE WHEN locale = 'KR' THEN hits ELSE 0 END) AS kr_hits,
  SUM(CASE WHEN locale = 'US' THEN hits ELSE 0 END) AS us_hits,
  SUM(CASE WHEN locale = 'JP' THEN hits ELSE 0 END) AS jp_hits,
  MAX(CASE WHEN locale = 'ALL' THEN score ELSE 0 END) AS echo_score,
  CASE
    WHEN MAX(CASE WHEN locale = 'ALL' THEN score ELSE 0 END) >= 2 THEN '60d+'
    WHEN MAX(CASE WHEN locale = 'ALL' THEN score ELSE 0 END) = 1 THEN '30d'
    ELSE '7d'
  END AS recommended_window
FROM latest_rows
LEFT JOIN latest_per_keyword USING (keyword)
GROUP BY keyword;

COMMENT ON VIEW jimscanner_trends_echo_summary IS
  'Cross-lingual demand echo 요약. echo_score: 0=K-fad, 1=cross-border, 2=global sustained, 3=전지역.';

-- ─────────────────────────────────────────
-- 3) 키워드 번역 캐시 (LLM 호출 절감)
CREATE TABLE IF NOT EXISTS jimscanner_trends_echo_translations (
  keyword text NOT NULL,
  locale text NOT NULL,                 -- 'EN' / 'JA'
  translated text NOT NULL,
  source text NOT NULL DEFAULT 'manual', -- 'manual' / 'llm' / 'dictionary'
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (keyword, locale)
);

ALTER TABLE jimscanner_trends_echo_translations ENABLE ROW LEVEL SECURITY;
