-- ────────────────────────────────────────────────────────────
-- 수요 동조 테마 발굴 — 키워드 코무브먼트 RPC (PR-COMOVE-1, 2026-05-30)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/themes 페이지
--
-- 아이디어: jimscanner_trends_keywords 의 시계열(volume_relative)을
--   키워드 단위로 주(week) 버킷 평균을 구해, 키워드 쌍의 Pearson 상호상관을
--   Postgres 내장 corr() 집계로 계산한다. 양(+)의 상관 그래프에서
--   연결요소(connected components, TS 측) 로 '같이 오르내리는 묶음 = 테마' 추출.
--
-- 데이터 부족(주 버킷 overlap 미달) 시 → 같은 날 동시출현 빈도(co-occurrence)
--   로 graceful fallback (use_cooccurrence := true).
--
-- service_role 로만 호출 (어드민 한정) — SECURITY DEFINER + grant 명시.
-- 기존 jimscanner_tv_ggsan_match 패턴과 동일 노출 정책.
-- ────────────────────────────────────────────────────────────


-- 1) 코무브먼트 페어 RPC
--    use_cooccurrence=false → 주 버킷 volume_relative 의 Pearson corr
--    use_cooccurrence=true  → 같은 날(date) 동시출현 빈도 기반 유사도(fallback)
CREATE OR REPLACE FUNCTION jimscanner_trends_comovement(
  days_window int DEFAULT 56,          -- 최근 8주 기본
  min_overlap int DEFAULT 4,           -- 두 키워드가 공유해야 할 최소 버킷/일 수
  min_corr float DEFAULT 0.5,          -- 양의 상관 임계값
  source_filter text DEFAULT NULL,     -- 특정 source 한정 (NULL = 전체)
  result_limit int DEFAULT 600,
  use_cooccurrence boolean DEFAULT false
)
RETURNS TABLE (
  keyword_a text,
  keyword_b text,
  corr_val real,
  overlap_n int,
  method text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH base AS (
    SELECT
      k.keyword,
      -- 상관: 주 버킷 / 동시출현: 일 버킷
      CASE WHEN use_cooccurrence
        THEN date_trunc('day', k.collected_at)
        ELSE date_trunc('week', k.collected_at)
      END AS bucket,
      k.volume_relative
    FROM jimscanner_trends_keywords k
    WHERE k.collected_at > now() - (days_window || ' days')::interval
      AND (source_filter IS NULL OR k.source = source_filter)
      AND k.keyword IS NOT NULL
  ),
  -- 키워드 × 버킷 평균값 (상관) / 출현표시 (동시출현)
  series AS (
    SELECT
      keyword,
      bucket,
      avg(volume_relative) FILTER (WHERE volume_relative IS NOT NULL) AS vol,
      1::int AS present
    FROM base
    GROUP BY keyword, bucket
  ),
  -- 노이즈 컷: 최소 버킷 수 이상 등장한 키워드만
  active AS (
    SELECT keyword
    FROM series
    GROUP BY keyword
    HAVING count(*) >= min_overlap
  ),
  s AS (
    SELECT sr.* FROM series sr
    JOIN active a ON a.keyword = sr.keyword
  ),
  pairs AS (
    SELECT
      x.keyword AS keyword_a,
      y.keyword AS keyword_b,
      count(*)::int AS overlap_n,
      -- 상관: corr(); 동시출현: jaccard 근사 (overlap / 추후 정규화)
      CASE WHEN use_cooccurrence
        THEN NULL::real
        ELSE corr(x.vol, y.vol)::real
      END AS corr_val
    FROM s x
    JOIN s y
      ON x.bucket = y.bucket
     AND x.keyword < y.keyword
    -- 상관일 때는 양쪽 vol 모두 존재해야 corr 유효
    WHERE (use_cooccurrence OR (x.vol IS NOT NULL AND y.vol IS NOT NULL))
    GROUP BY x.keyword, y.keyword
    HAVING count(*) >= min_overlap
  )
  SELECT
    p.keyword_a,
    p.keyword_b,
    p.corr_val,
    p.overlap_n,
    (CASE WHEN use_cooccurrence THEN 'cooccurrence' ELSE 'pearson' END)::text AS method
  FROM pairs p
  WHERE use_cooccurrence
     OR (p.corr_val IS NOT NULL AND p.corr_val >= min_corr)
  ORDER BY
    (CASE WHEN use_cooccurrence THEN p.overlap_n::real ELSE p.corr_val END) DESC
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_trends_comovement(int, int, float, text, int, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_trends_comovement(int, int, float, text, int, boolean) TO service_role;


-- 2) 키워드 모멘텀 RPC — 테마 카드의 ① 모멘텀(상승기울기) 계산용
--    regr_slope(volume, epoch) 로 시계열 상승 추세를 추정.
CREATE OR REPLACE FUNCTION jimscanner_trends_keyword_momentum(
  days_window int DEFAULT 56,
  source_filter text DEFAULT NULL
)
RETURNS TABLE (
  keyword text,
  category_top text,
  n_obs int,
  avg_vol real,
  last_vol real,
  slope_per_day real,
  last_seen timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH base AS (
    SELECT
      k.keyword,
      k.category_top,
      k.volume_relative,
      k.collected_at,
      -- 최신 row 의 카테고리/볼륨을 잡기 위한 순번
      row_number() OVER (PARTITION BY k.keyword ORDER BY k.collected_at DESC) AS rn
    FROM jimscanner_trends_keywords k
    WHERE k.collected_at > now() - (days_window || ' days')::interval
      AND (source_filter IS NULL OR k.source = source_filter)
      AND k.keyword IS NOT NULL
  )
  SELECT
    b.keyword,
    max(b.category_top) FILTER (WHERE b.rn = 1) AS category_top,
    count(*)::int AS n_obs,
    avg(b.volume_relative)::real AS avg_vol,
    max(b.volume_relative) FILTER (WHERE b.rn = 1)::real AS last_vol,
    -- 하루당 기울기: x 는 일 단위(epoch/86400)
    regr_slope(b.volume_relative, extract(epoch FROM b.collected_at) / 86400.0)::real AS slope_per_day,
    max(b.collected_at) AS last_seen
  FROM base b
  GROUP BY b.keyword;
$$;

REVOKE ALL ON FUNCTION jimscanner_trends_keyword_momentum(int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_trends_keyword_momentum(int, text) TO service_role;
