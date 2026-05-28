-- ────────────────────────────────────────────────────────────
-- PR-V5: 키워드 Lifecycle 분류 — Fad/Sustained/Seasonal 진입게이트 (2026-05-28)
-- ────────────────────────────────────────────────────────────
-- jimscanner_trends_keywords 의 (keyword, source, collected_at, volume_relative)
-- 시계열을 입력으로 키워드별 lifecycle 을 5클래스로 자동 분류한다.
--
--   ① Pre-peak   — 상승 가속, 진입 골든존
--   ② Sustained  — 저-decay 안정수요
--   ③ Seasonal   — 연/월 주기 ACF ≥ 0.5
--   ④ Fad        — 피크 후 half-life < 14일 급락
--   ⑤ Episodic   — 단발 이벤트 bump
--
-- 핀 등록 시 Fad + post-peak 는 confirm-gate (어드민에서 표시).
-- ────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────
-- 1) jimscanner_trends_keywords 에 lifecycle 컬럼 추가
ALTER TABLE jimscanner_trends_keywords
  ADD COLUMN IF NOT EXISTS lifecycle_label text,          -- 'pre_peak' | 'sustained' | 'seasonal' | 'fad' | 'episodic' | NULL
  ADD COLUMN IF NOT EXISTS lifecycle_confidence numeric,  -- 0~1 (R² of decay fit / ACF magnitude)
  ADD COLUMN IF NOT EXISTS half_life_days numeric,        -- post-peak 지수감쇠 fit 결과
  ADD COLUMN IF NOT EXISTS peak_at timestamptz,           -- 30/90일 윈도 최대값 시점
  ADD COLUMN IF NOT EXISTS peak_volume numeric,
  ADD COLUMN IF NOT EXISTS acf_year numeric,              -- lag=365 자기상관 (있으면)
  ADD COLUMN IF NOT EXISTS acf_month numeric,             -- lag=30
  ADD COLUMN IF NOT EXISTS acf_week numeric,              -- lag=7
  ADD COLUMN IF NOT EXISTS lifecycle_computed_at timestamptz;

CREATE INDEX IF NOT EXISTS jimscanner_trends_keywords_lifecycle
  ON jimscanner_trends_keywords(lifecycle_label, lifecycle_computed_at DESC)
  WHERE lifecycle_label IS NOT NULL;

-- ─────────────────────────────────────────
-- 2) 키워드별 시계열 집계 view — (keyword, source) 단위로 일자 정규화
-- 동일 키워드가 같은 날 여러 번 수집되면 평균.
CREATE OR REPLACE VIEW jimscanner_trends_keyword_daily AS
SELECT
  keyword,
  source,
  date_trunc('day', collected_at)::date AS day,
  AVG(volume_relative)::numeric        AS volume,
  COUNT(*)                              AS sample_count
FROM jimscanner_trends_keywords
WHERE volume_relative IS NOT NULL
GROUP BY keyword, source, date_trunc('day', collected_at)::date;

-- ─────────────────────────────────────────
-- 3) 30/90일 윈도 피크 검출 view
-- 90일 윈도 내 최대값/시점 + 최근값.
CREATE OR REPLACE VIEW jimscanner_trends_keyword_peaks AS
WITH base AS (
  SELECT
    keyword,
    source,
    day,
    volume
  FROM jimscanner_trends_keyword_daily
  WHERE day >= (current_date - interval '90 days')::date
),
peak90 AS (
  SELECT DISTINCT ON (keyword, source)
    keyword, source, day AS peak_day, volume AS peak_volume
  FROM base
  ORDER BY keyword, source, volume DESC NULLS LAST, day DESC
),
latest AS (
  SELECT DISTINCT ON (keyword, source)
    keyword, source, day AS latest_day, volume AS latest_volume
  FROM base
  ORDER BY keyword, source, day DESC
),
stats AS (
  SELECT
    keyword,
    source,
    COUNT(*)                       AS n_days,
    AVG(volume)                    AS mean_volume,
    STDDEV_SAMP(volume)            AS std_volume,
    MAX(volume)                    AS max_volume,
    MIN(day)                       AS first_day,
    MAX(day)                       AS last_day
  FROM base
  GROUP BY keyword, source
)
SELECT
  s.keyword,
  s.source,
  s.n_days,
  s.mean_volume,
  s.std_volume,
  s.max_volume,
  s.first_day,
  s.last_day,
  p.peak_day,
  p.peak_volume,
  l.latest_day,
  l.latest_volume,
  (l.latest_day - p.peak_day)    AS days_since_peak
FROM stats s
LEFT JOIN peak90 p USING (keyword, source)
LEFT JOIN latest l USING (keyword, source);

-- ─────────────────────────────────────────
-- 4) post-peak 지수감쇠 fit → half_life_days (RPC)
-- 모델: ln(v) = a + b * t, half_life = -ln(2)/b (b<0 일 때)
-- 입력: keyword, source. 출력: half_life_days, r2, n_points.
CREATE OR REPLACE FUNCTION jimscanner_trends_keyword_half_life(
  p_keyword text,
  p_source  text
) RETURNS TABLE (
  half_life_days numeric,
  r2             numeric,
  n_points       int,
  peak_day       date,
  peak_volume    numeric
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_peak_day    date;
  v_peak_volume numeric;
BEGIN
  -- 피크 시점 (90일 윈도)
  SELECT pk.peak_day, pk.peak_volume
    INTO v_peak_day, v_peak_volume
  FROM jimscanner_trends_keyword_peaks pk
  WHERE pk.keyword = p_keyword AND pk.source = p_source;

  IF v_peak_day IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH post AS (
    SELECT
      (day - v_peak_day)::numeric AS t,
      ln(GREATEST(volume, 0.5))   AS lnv,    -- 0 방지
      volume
    FROM jimscanner_trends_keyword_daily
    WHERE keyword = p_keyword
      AND source  = p_source
      AND day >= v_peak_day
      AND day <= (current_date)
  ),
  agg AS (
    SELECT
      COUNT(*)::int                    AS n,
      AVG(t)                           AS mt,
      AVG(lnv)                         AS mlnv,
      regr_slope(lnv, t)               AS b,
      regr_intercept(lnv, t)           AS a,
      regr_r2(lnv, t)                  AS r2v
    FROM post
  )
  SELECT
    CASE
      WHEN a.b IS NULL OR a.b >= 0 THEN NULL
      ELSE (-ln(2.0) / a.b)::numeric
    END                              AS half_life_days,
    COALESCE(a.r2v, 0)::numeric      AS r2,
    a.n                              AS n_points,
    v_peak_day                       AS peak_day,
    v_peak_volume                    AS peak_volume
  FROM agg a;
END;
$$;

-- ─────────────────────────────────────────
-- 5) 자기상관 (ACF) 함수 — lag = 7 / 30 / 365 일
-- corr(v_t, v_{t-lag}) 계산. n_points 부족하면 NULL.
CREATE OR REPLACE FUNCTION jimscanner_trends_keyword_acf(
  p_keyword text,
  p_source  text,
  p_lag_days int
) RETURNS TABLE (
  acf       numeric,
  n_points  int
)
LANGUAGE sql
STABLE
AS $$
  WITH series AS (
    SELECT day, volume
    FROM jimscanner_trends_keyword_daily
    WHERE keyword = p_keyword
      AND source  = p_source
  ),
  paired AS (
    SELECT
      s1.volume AS v_now,
      s2.volume AS v_lag
    FROM series s1
    JOIN series s2 ON s2.day = s1.day - (p_lag_days || ' days')::interval
  )
  SELECT
    CASE WHEN COUNT(*) < 3 THEN NULL ELSE corr(v_now, v_lag) END::numeric AS acf,
    COUNT(*)::int                                                          AS n_points
  FROM paired;
$$;

-- ─────────────────────────────────────────
-- 6) lifecycle 분류 함수 — 단일 (keyword, source) 에 5-label + confidence 반환
-- 규칙 (우선순위):
--   - n_days < 7                                      → NULL (데이터 부족)
--   - acf_year ≥ 0.5 또는 acf_month ≥ 0.5             → seasonal
--   - 1d-peak이고 (latest/peak < 0.3) + n_days ≤ 14   → episodic
--   - days_since_peak ≤ 5 AND latest ≥ 0.8*peak       → pre_peak
--   - half_life < 14 AND days_since_peak ≥ 7          → fad
--   - 그 외 (낮은 std/mean ratio)                      → sustained
--   - default                                         → episodic
CREATE OR REPLACE FUNCTION jimscanner_trends_keyword_classify(
  p_keyword text,
  p_source  text
) RETURNS TABLE (
  lifecycle_label      text,
  lifecycle_confidence numeric,
  half_life_days       numeric,
  peak_at              timestamptz,
  peak_volume          numeric,
  acf_year             numeric,
  acf_month            numeric,
  acf_week             numeric
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_pk         RECORD;
  v_hl         RECORD;
  v_a_year     numeric;
  v_a_month    numeric;
  v_a_week     numeric;
  v_label      text;
  v_conf       numeric;
  v_ratio_now  numeric;
  v_cv         numeric;
BEGIN
  SELECT * INTO v_pk
  FROM jimscanner_trends_keyword_peaks
  WHERE keyword = p_keyword AND source = p_source;

  IF v_pk IS NULL OR v_pk.n_days IS NULL OR v_pk.n_days < 7 THEN
    RETURN;
  END IF;

  SELECT * INTO v_hl
  FROM jimscanner_trends_keyword_half_life(p_keyword, p_source);

  SELECT acf INTO v_a_year  FROM jimscanner_trends_keyword_acf(p_keyword, p_source, 365);
  SELECT acf INTO v_a_month FROM jimscanner_trends_keyword_acf(p_keyword, p_source, 30);
  SELECT acf INTO v_a_week  FROM jimscanner_trends_keyword_acf(p_keyword, p_source, 7);

  v_ratio_now := CASE WHEN v_pk.peak_volume > 0
                      THEN v_pk.latest_volume / v_pk.peak_volume
                      ELSE NULL END;
  v_cv := CASE WHEN v_pk.mean_volume > 0
               THEN v_pk.std_volume / NULLIF(v_pk.mean_volume, 0)
               ELSE NULL END;

  -- 우선순위 분류
  IF COALESCE(v_a_year, 0)  >= 0.5 THEN
    v_label := 'seasonal'; v_conf := LEAST(v_a_year, 1)::numeric;
  ELSIF COALESCE(v_a_month, 0) >= 0.5 THEN
    v_label := 'seasonal'; v_conf := LEAST(v_a_month, 1)::numeric;
  ELSIF v_pk.days_since_peak IS NOT NULL
        AND v_pk.days_since_peak <= 5
        AND v_ratio_now IS NOT NULL
        AND v_ratio_now >= 0.8 THEN
    v_label := 'pre_peak'; v_conf := LEAST(v_ratio_now, 1)::numeric;
  ELSIF v_hl.half_life_days IS NOT NULL
        AND v_hl.half_life_days > 0
        AND v_hl.half_life_days < 14
        AND COALESCE(v_pk.days_since_peak, 0) >= 7 THEN
    v_label := 'fad'; v_conf := COALESCE(v_hl.r2, 0)::numeric;
  ELSIF v_cv IS NOT NULL AND v_cv < 0.5 AND v_pk.n_days >= 14 THEN
    v_label := 'sustained'; v_conf := GREATEST(0, 1 - v_cv)::numeric;
  ELSE
    v_label := 'episodic'; v_conf := 0.5::numeric;
  END IF;

  RETURN QUERY SELECT
    v_label,
    v_conf,
    v_hl.half_life_days,
    v_pk.peak_day::timestamptz,
    v_pk.peak_volume,
    v_a_year,
    v_a_month,
    v_a_week;
END;
$$;

-- ─────────────────────────────────────────
-- 7) 일괄 분류 RPC — 모든 활성 키워드를 분류해 jimscanner_trends_keywords 의 최신 row 에 반영
-- 호출: 어드민 버튼 또는 cron (KST 새벽).
-- 갱신은 (keyword, source) 별 latest collected_at row 1 개만 (UI 표시용).
CREATE OR REPLACE FUNCTION jimscanner_trends_classify_lifecycle_all(
  p_min_n_days int DEFAULT 7
) RETURNS TABLE (
  keyword         text,
  source          text,
  lifecycle_label text,
  lifecycle_confidence numeric,
  half_life_days  numeric,
  updated_rows    int
)
LANGUAGE plpgsql
AS $$
DECLARE
  r          RECORD;
  v_updated  int;
BEGIN
  FOR r IN
    SELECT pk.keyword, pk.source
    FROM jimscanner_trends_keyword_peaks pk
    WHERE pk.n_days >= p_min_n_days
  LOOP
    DECLARE
      c RECORD;
    BEGIN
      SELECT * INTO c
      FROM jimscanner_trends_keyword_classify(r.keyword, r.source);

      IF c.lifecycle_label IS NULL THEN
        CONTINUE;
      END IF;

      -- 최신 row 만 갱신 (UI 노출 단순화)
      WITH latest AS (
        SELECT id
        FROM jimscanner_trends_keywords k
        WHERE k.keyword = r.keyword AND k.source = r.source
        ORDER BY k.collected_at DESC
        LIMIT 1
      )
      UPDATE jimscanner_trends_keywords k
         SET lifecycle_label       = c.lifecycle_label,
             lifecycle_confidence  = c.lifecycle_confidence,
             half_life_days        = c.half_life_days,
             peak_at               = c.peak_at,
             peak_volume           = c.peak_volume,
             acf_year              = c.acf_year,
             acf_month             = c.acf_month,
             acf_week              = c.acf_week,
             lifecycle_computed_at = now()
        FROM latest
       WHERE k.id = latest.id;

      GET DIAGNOSTICS v_updated = ROW_COUNT;

      keyword              := r.keyword;
      source               := r.source;
      lifecycle_label      := c.lifecycle_label;
      lifecycle_confidence := c.lifecycle_confidence;
      half_life_days       := c.half_life_days;
      updated_rows         := v_updated;
      RETURN NEXT;
    END;
  END LOOP;
END;
$$;
