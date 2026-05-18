-- ────────────────────────────────────────────────────────────
-- Vocabulary Velocity — 신조어·밈 조기 감지 lexical 선행지표
-- 2026-05-19
-- ────────────────────────────────────────────────────────────
-- 목적: jimscanner_market_raw + jimscanner_trends_keywords 의 한글 텍스트에서
--       unigram/bigram 일별 빈도 시계열을 만들고, '직전 baseline 0~N회 → 최근 window N회 이상'
--       패턴을 RPC 로 노출.  /admin/trend-radar/vocab 페이지가 호출.
-- 적용: psql 로 직접 실행 (DDL — supabase pooler 통해).
-- ────────────────────────────────────────────────────────────

-- 1) LLM 분류 캐시 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jimscanner_vocab_terms (
  term text NOT NULL,
  gram text NOT NULL,                              -- 'unigram' | 'bigram'
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_classified_at timestamptz,
  is_slang boolean,                                -- 신조어·밈 여부
  has_commerce_intent boolean,                     -- 상품성 (구매·소비 가능 단어인지)
  category_top text,                               -- health | living | digital | other | none
  brand_guess text,                                -- 명확한 브랜드면 채움
  notes text,
  llm_model text,
  PRIMARY KEY (gram, term)
);

CREATE INDEX IF NOT EXISTS jimscanner_vocab_terms_classified
  ON jimscanner_vocab_terms(last_classified_at DESC NULLS FIRST);

ALTER TABLE jimscanner_vocab_terms ENABLE ROW LEVEL SECURITY;

-- 2) 일별 빈도 머티리얼라이즈드 뷰 ──────────────────────────────
-- 토큰화: 한글/숫자/영문 외 문자로 split. 길이 2~14, 순수 숫자 제외.
-- bigram 은 같은 doc_id 안 인접 토큰만.
DROP MATERIALIZED VIEW IF EXISTS jimscanner_vocab_daily;
CREATE MATERIALIZED VIEW jimscanner_vocab_daily AS
WITH docs AS (
  SELECT
    id::text AS doc_id,
    source,
    date_trunc('day', captured_at)::date AS day,
    lower(
      coalesce(title, '') || ' ' ||
      coalesce(metadata->>'description', '') || ' ' ||
      coalesce(query, '')
    ) AS text
  FROM jimscanner_market_raw
  WHERE captured_at > now() - interval '45 days'

  UNION ALL

  SELECT
    id::text AS doc_id,
    source,
    date_trunc('day', collected_at)::date AS day,
    lower(coalesce(keyword, '')) AS text
  FROM jimscanner_trends_keywords
  WHERE collected_at > now() - interval '45 days'
),
tokens AS (
  SELECT
    d.doc_id,
    d.source,
    d.day,
    t.token,
    t.ord
  FROM docs d,
    LATERAL unnest(
      regexp_split_to_array(d.text, '[^가-힣0-9a-zA-Z]+')
    ) WITH ORDINALITY AS t(token, ord)
  WHERE length(t.token) BETWEEN 2 AND 14
    AND t.token !~ '^[0-9]+$'
    AND t.token <> ''
),
unigrams AS (
  SELECT day, doc_id, source, token AS term, 'unigram'::text AS gram
  FROM tokens
),
bigrams AS (
  SELECT day, doc_id, source,
         (prev_token || ' ' || token) AS term,
         'bigram'::text AS gram
  FROM (
    SELECT
      day, doc_id, source, token,
      lag(token) OVER (PARTITION BY doc_id ORDER BY ord) AS prev_token
    FROM tokens
  ) z
  WHERE prev_token IS NOT NULL
),
combined AS (
  SELECT * FROM unigrams
  UNION ALL
  SELECT * FROM bigrams
)
SELECT
  term,
  gram,
  day,
  count(*)::int                  AS mentions,
  count(DISTINCT source)::int    AS sources_n,
  count(DISTINCT doc_id)::int    AS docs_n
FROM combined
GROUP BY term, gram, day;

CREATE UNIQUE INDEX IF NOT EXISTS jimscanner_vocab_daily_pk
  ON jimscanner_vocab_daily(gram, term, day);
CREATE INDEX IF NOT EXISTS jimscanner_vocab_daily_day_mentions
  ON jimscanner_vocab_daily(day DESC, mentions DESC);
CREATE INDEX IF NOT EXISTS jimscanner_vocab_daily_term
  ON jimscanner_vocab_daily(term);

-- 3) emergence 패턴 RPC ────────────────────────────────────────
-- 최근 window_days 안 등장이 min_growth 이상이고
-- 직전 baseline_days 안 누적이 baseline_max 이하인 term 추출.
CREATE OR REPLACE FUNCTION jimscanner_vocab_emergence(
  window_days int  DEFAULT 3,
  baseline_days int DEFAULT 30,
  min_growth int   DEFAULT 3,
  baseline_max int DEFAULT 5,
  gram_filter text DEFAULT NULL,        -- 'unigram' | 'bigram' | NULL=both
  limit_n int      DEFAULT 100
)
RETURNS TABLE (
  term text,
  gram text,
  recent_mentions int,
  baseline_mentions int,
  sources_n int,
  docs_n int,
  first_recent_day date,
  last_recent_day date,
  growth_ratio numeric
)
LANGUAGE sql STABLE AS $$
  WITH recent AS (
    SELECT
      term, gram,
      sum(mentions)::int  AS rec_mentions,
      max(sources_n)::int AS rec_sources,
      sum(docs_n)::int    AS rec_docs,
      min(day)            AS first_day,
      max(day)            AS last_day
    FROM jimscanner_vocab_daily
    WHERE day >= current_date - (window_days - 1)
      AND (gram_filter IS NULL OR gram = gram_filter)
    GROUP BY term, gram
  ),
  baseline AS (
    SELECT term, gram, sum(mentions)::int AS base_mentions
    FROM jimscanner_vocab_daily
    WHERE day <  current_date - (window_days - 1)
      AND day >= current_date - (window_days + baseline_days - 1)
      AND (gram_filter IS NULL OR gram = gram_filter)
    GROUP BY term, gram
  )
  SELECT
    r.term,
    r.gram,
    r.rec_mentions,
    coalesce(b.base_mentions, 0)        AS baseline_mentions,
    r.rec_sources,
    r.rec_docs,
    r.first_day,
    r.last_day,
    (r.rec_mentions::numeric / GREATEST(coalesce(b.base_mentions, 0), 1)) AS growth_ratio
  FROM recent r
  LEFT JOIN baseline b ON b.term = r.term AND b.gram = r.gram
  WHERE r.rec_mentions >= min_growth
    AND coalesce(b.base_mentions, 0) <= baseline_max
  ORDER BY growth_ratio DESC, r.rec_mentions DESC
  LIMIT limit_n;
$$;

-- 4) 1-hop co-mention RPC ──────────────────────────────────────
-- 같은 doc 안에 함께 등장한 단어 (window_days 안 한정).
-- daily MV 만으로는 doc 단위 co-occurrence 가 안 나오므로 raw 텍스트 재토큰화.
CREATE OR REPLACE FUNCTION jimscanner_vocab_comentions(
  target_term text,
  window_days int DEFAULT 7,
  limit_n int     DEFAULT 20
)
RETURNS TABLE (
  co_term text,
  co_mentions int,
  co_docs int
)
LANGUAGE sql STABLE AS $$
  WITH docs AS (
    SELECT
      id::text AS doc_id,
      lower(
        coalesce(title, '') || ' ' ||
        coalesce(metadata->>'description', '') || ' ' ||
        coalesce(query, '')
      ) AS text
    FROM jimscanner_market_raw
    WHERE captured_at > now() - make_interval(days => window_days)
    UNION ALL
    SELECT
      id::text AS doc_id,
      lower(coalesce(keyword, '')) AS text
    FROM jimscanner_trends_keywords
    WHERE collected_at > now() - make_interval(days => window_days)
  ),
  tokens AS (
    SELECT d.doc_id, t.token
    FROM docs d,
      LATERAL unnest(regexp_split_to_array(d.text, '[^가-힣0-9a-zA-Z]+')) AS t(token)
    WHERE length(t.token) BETWEEN 2 AND 14
      AND t.token !~ '^[0-9]+$'
      AND t.token <> ''
  ),
  target_docs AS (
    SELECT DISTINCT doc_id FROM tokens WHERE token = lower(target_term)
  )
  SELECT
    t.token AS co_term,
    count(*)::int AS co_mentions,
    count(DISTINCT t.doc_id)::int AS co_docs
  FROM tokens t
  WHERE t.doc_id IN (SELECT doc_id FROM target_docs)
    AND t.token <> lower(target_term)
  GROUP BY t.token
  ORDER BY co_mentions DESC
  LIMIT limit_n;
$$;

-- 5) refresh 헬퍼 (cron 에서 호출) ───────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_refresh_vocab_daily()
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- CONCURRENTLY 는 UNIQUE 인덱스 필수 — 위에서 만들어둠.
  REFRESH MATERIALIZED VIEW CONCURRENTLY jimscanner_vocab_daily;
END;
$$;
