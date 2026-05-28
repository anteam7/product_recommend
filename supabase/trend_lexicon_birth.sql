-- ────────────────────────────────────────────────────────────
-- Lexicon-Birth Early-Warning RPC (2026-05-28)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/lexicon-birth 페이지
-- 핵심 아이디어:
--   google_suggest 가 매일 적재되는 jimscanner_market_raw 위에서
--   '과거 N일 history 에 존재하지 않다가 지난 birth_window_days 일 안에
--   처음 등장한' 신생 토큰만 set-diff 로 추출 → 신생어 cards 로 보여준다.
--
-- 입력 데이터: public.jimscanner_market_raw
--   - source = 'google_suggest' / 'naver_blog' / 'naver_news' / 'quasarzone_sale' / 'clien_park' / ...
--   - title  : 자동완성 항목 또는 콘텐츠 제목
--   - captured_at : 적재 시각
--
-- 출력: 신생 토큰 + 일별 occurrence 곡선 + 타 소스 echo lag + 카탈로그 매치 수
-- service_role 로만 호출 (어드민 한정) — SECURITY DEFINER + grant 명시
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_lexicon_birth(
  lookback_days int DEFAULT 60,
  birth_window_days int DEFAULT 7,
  min_occurrences int DEFAULT 2,
  result_limit int DEFAULT 200
)
RETURNS TABLE (
  token text,
  birth_date date,
  days_since_birth int,
  total_occurrences int,
  source_count int,
  origin_source text,
  first_query text,
  daily_counts int[],
  echo_sources text[],
  echo_first_lag_days int,
  catalog_match_count int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH raw_tokens AS (
    SELECT
      lower(btrim(t.tok)) AS token,
      r.source,
      r.query,
      r.captured_at,
      (r.captured_at AT TIME ZONE 'Asia/Seoul')::date AS day
    FROM jimscanner_market_raw r
    CROSS JOIN LATERAL regexp_split_to_table(
      coalesce(r.title, ''),
      '[\s,/·\-_+()\[\]"''.~!?:;|]+'
    ) AS t(tok)
    WHERE r.captured_at > now() - (lookback_days || ' days')::interval
      AND coalesce(r.title, '') <> ''
  ),
  clean AS (
    SELECT *
    FROM raw_tokens
    WHERE length(token) BETWEEN 2 AND 30
      AND token !~ '^[0-9]+$'
      AND token !~ '^(은|는|이|가|을|를|의|에|와|과|도|만|로|으로|에서|에게|부터|까지|보다|처럼|마저|조차|하다|되다|있다|없다|그리고|그러나|또는|혹은|the|and|for|with|from|this|that)$'
  ),
  agg AS (
    SELECT
      token,
      MIN(day) AS birth_date,
      MIN(captured_at) AS first_seen_at,
      COUNT(*)::int AS total_occurrences,
      COUNT(DISTINCT source)::int AS source_count
    FROM clean
    GROUP BY token
  ),
  newborn AS (
    -- 지난 birth_window_days 안에 처음 태어난 토큰만
    SELECT a.*
    FROM agg a
    WHERE a.birth_date >= (current_date - birth_window_days)
      AND a.total_occurrences >= min_occurrences
  ),
  origin AS (
    -- 신생 토큰의 출처 (최초 1건의 source/query)
    SELECT DISTINCT ON (c.token)
      c.token,
      c.source AS origin_source,
      c.query AS first_query
    FROM clean c
    JOIN newborn nb ON nb.token = c.token
    ORDER BY c.token, c.captured_at ASC
  ),
  -- google_suggest 출생만 통과시킨다 (다른 소스 출생은 무시)
  suggest_birth AS (
    SELECT nb.*, o.origin_source, o.first_query
    FROM newborn nb
    JOIN origin o ON o.token = nb.token
    WHERE o.origin_source = 'google_suggest'
  ),
  daily AS (
    SELECT
      c.token,
      c.day,
      COUNT(*)::int AS n
    FROM clean c
    JOIN suggest_birth sb ON sb.token = c.token
    WHERE c.source = 'google_suggest'
    GROUP BY c.token, c.day
  ),
  daily_arr AS (
    SELECT
      sb.token,
      (
        SELECT array_agg(coalesce(d2.n, 0) ORDER BY g.day)
        FROM generate_series(sb.birth_date, current_date, interval '1 day') AS g(day)
        LEFT JOIN daily d2
          ON d2.token = sb.token
         AND d2.day = g.day::date
      ) AS daily_counts
    FROM suggest_birth sb
  ),
  echo AS (
    SELECT
      sb.token,
      array_agg(DISTINCT c.source) FILTER (
        WHERE c.source <> 'google_suggest'
      ) AS echo_sources,
      MIN(
        CASE WHEN c.source <> 'google_suggest'
          THEN (c.day - sb.birth_date)
        END
      )::int AS echo_first_lag_days
    FROM suggest_birth sb
    JOIN clean c
      ON c.token = sb.token
     AND c.day >= sb.birth_date
    GROUP BY sb.token
  ),
  catalog AS (
    SELECT
      sb.token,
      (
        SELECT COUNT(*)::int
        FROM jimscanner_ggsan_products gp
        WHERE gp.title ILIKE '%' || sb.token || '%'
      ) AS catalog_match_count
    FROM suggest_birth sb
  )
  SELECT
    sb.token,
    sb.birth_date,
    (current_date - sb.birth_date)::int AS days_since_birth,
    sb.total_occurrences,
    sb.source_count,
    sb.origin_source,
    sb.first_query,
    COALESCE(da.daily_counts, ARRAY[]::int[])::int[] AS daily_counts,
    COALESCE(e.echo_sources, ARRAY[]::text[])::text[] AS echo_sources,
    e.echo_first_lag_days,
    COALESCE(cat.catalog_match_count, 0) AS catalog_match_count
  FROM suggest_birth sb
  LEFT JOIN daily_arr da ON da.token = sb.token
  LEFT JOIN echo e ON e.token = sb.token
  LEFT JOIN catalog cat ON cat.token = sb.token
  ORDER BY
    sb.total_occurrences DESC,
    sb.birth_date DESC,
    sb.token
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_lexicon_birth(int, int, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_lexicon_birth(int, int, int, int) TO service_role;
