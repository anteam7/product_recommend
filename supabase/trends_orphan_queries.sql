-- ────────────────────────────────────────────────────────────
-- Alias Gap Hunter — 매칭 실패 키워드 1클릭 등록 보드
-- 2026-05-18
-- ────────────────────────────────────────────────────────────
-- google_suggest / naver_search_trend / naver_tvtime / daum_news / ppomppu 등
-- 모든 수집 시그널 중 jimscanner_trends_products의 canonical_name 또는
-- jimscanner_trends_aliases의 alias 와도 매칭되지 않은 'orphan 키워드' 집계.
--
-- 어드민 /admin/trend-radar/alias-gap 에서 사용.
-- 3가지 액션 가능: (1) 새 product 생성, (2) 기존 product 에 alias 추가,
-- (3) ignore (jimscanner_trends_ignored_keywords 기록).
-- ────────────────────────────────────────────────────────────


-- 1) Ignore 목록 — 노이즈 / 의미 없는 키워드 (UI 의 ignore 액션이 기록)
CREATE TABLE IF NOT EXISTS jimscanner_trends_ignored_keywords (
  keyword text PRIMARY KEY,
  reason text,                                 -- 'noise' | 'irrelevant' | 'duplicate' | 자유 텍스트
  ignored_by text,                             -- 'manual' | 'admin' | 'auto'
  ignored_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_ignored_keywords_at
  ON jimscanner_trends_ignored_keywords(ignored_at DESC);

ALTER TABLE jimscanner_trends_ignored_keywords ENABLE ROW LEVEL SECURITY;


-- 2) 모든 시그널 소스의 raw 키워드 통합 뷰
-- jimscanner_trends_keywords (naver_search_trend / naver_shopping_insight / naver_tvtime)
-- + jimscanner_market_raw (google_suggest / naver_news / naver_blog / daum_news / clien / quasarzone / ppomppu / kca_press)
CREATE OR REPLACE VIEW jimscanner_trends_all_signal_keywords AS
  SELECT
    lower(trim(keyword)) AS norm_keyword,
    keyword              AS raw_keyword,
    source,
    collected_at         AS seen_at
  FROM jimscanner_trends_keywords
  WHERE keyword IS NOT NULL
    AND length(trim(keyword)) >= 2
  UNION ALL
  SELECT
    lower(trim(COALESCE(query, title))) AS norm_keyword,
    COALESCE(query, title)              AS raw_keyword,
    source,
    captured_at                          AS seen_at
  FROM jimscanner_market_raw
  WHERE COALESCE(query, title) IS NOT NULL
    AND length(trim(COALESCE(query, title))) >= 2;


-- 3) Orphan 키워드 집계 뷰 — 매칭 안 된 키워드를 빈도/소스 다양성과 함께 노출
-- 30d 윈도우. UI 는 7d / 30d 카운트 둘 다 표시.
CREATE OR REPLACE VIEW jimscanner_trends_orphan_queries AS
  WITH known_aliases AS (
    SELECT lower(trim(canonical_name)) AS norm FROM jimscanner_trends_products
    UNION
    SELECT lower(trim(alias))          AS norm FROM jimscanner_trends_aliases
  ),
  ignored AS (
    SELECT lower(trim(keyword)) AS norm FROM jimscanner_trends_ignored_keywords
  ),
  base AS (
    SELECT
      norm_keyword,
      raw_keyword,
      source,
      seen_at
    FROM jimscanner_trends_all_signal_keywords
    WHERE seen_at >= now() - interval '30 days'
      AND norm_keyword NOT IN (SELECT norm FROM known_aliases)
      AND norm_keyword NOT IN (SELECT norm FROM ignored)
  )
  SELECT
    norm_keyword                                                                AS keyword_norm,
    (array_agg(raw_keyword ORDER BY seen_at DESC))[1]                           AS keyword,
    count(*) FILTER (WHERE seen_at >= now() - interval '7 days')::int           AS freq_7d,
    count(*)::int                                                                AS freq_30d,
    count(DISTINCT source)::int                                                  AS source_count,
    array_agg(DISTINCT source ORDER BY source)                                   AS sources,
    max(seen_at)                                                                 AS last_seen_at
  FROM base
  GROUP BY norm_keyword;


-- 4) 일별 Coverage KPI — 오늘 수집된 전체 시그널 중 매칭률 %
-- trends_runs 에 source='alias_coverage_audit' 일일 cron 이 채움.
-- 단순 read-only 뷰도 같이 제공 (실시간 계산).
CREATE OR REPLACE VIEW jimscanner_trends_alias_coverage_daily AS
  WITH known_aliases AS (
    SELECT lower(trim(canonical_name)) AS norm FROM jimscanner_trends_products
    UNION
    SELECT lower(trim(alias))          AS norm FROM jimscanner_trends_aliases
  ),
  daily AS (
    SELECT
      date_trunc('day', seen_at)::date AS day,
      norm_keyword,
      CASE WHEN norm_keyword IN (SELECT norm FROM known_aliases) THEN 1 ELSE 0 END AS matched
    FROM jimscanner_trends_all_signal_keywords
    WHERE seen_at >= now() - interval '30 days'
  )
  SELECT
    day,
    count(*)::int                                       AS total_signals,
    sum(matched)::int                                   AS matched_signals,
    (count(*) - sum(matched))::int                      AS orphan_signals,
    CASE WHEN count(*) = 0 THEN 0
         ELSE round((sum(matched)::numeric / count(*)::numeric) * 100, 2)
    END                                                 AS coverage_pct
  FROM daily
  GROUP BY day
  ORDER BY day DESC;


-- 5) Action: 키워드 ignore (UI 의 ignore 버튼이 호출)
CREATE OR REPLACE FUNCTION jimscanner_trends_ignore_keyword(
  p_keyword text,
  p_reason text DEFAULT 'noise',
  p_by text DEFAULT 'admin'
) RETURNS void AS $$
BEGIN
  INSERT INTO jimscanner_trends_ignored_keywords (keyword, reason, ignored_by, ignored_at)
  VALUES (lower(trim(p_keyword)), p_reason, p_by, now())
  ON CONFLICT (keyword) DO UPDATE
    SET reason = EXCLUDED.reason,
        ignored_by = EXCLUDED.ignored_by,
        ignored_at = now();
END;
$$ LANGUAGE plpgsql;


-- 6) Action: 새 product 생성 + 키워드를 alias 로 자동 등록
CREATE OR REPLACE FUNCTION jimscanner_trends_create_product_from_keyword(
  p_keyword text,
  p_canonical_name text,
  p_category_top text,
  p_category_mid text DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_product_id uuid;
BEGIN
  INSERT INTO jimscanner_trends_products (canonical_name, category_top, category_mid, first_seen_at, last_seen_at, alias_count)
  VALUES (trim(p_canonical_name), p_category_top, p_category_mid, now(), now(), 1)
  ON CONFLICT (canonical_name, category_top) DO UPDATE
    SET last_seen_at = now()
  RETURNING id INTO v_product_id;

  INSERT INTO jimscanner_trends_aliases (product_id, alias, alias_type, source, confidence, classified_by)
  VALUES (v_product_id, trim(p_keyword), 'keyword', 'manual', 1.0, 'manual')
  ON CONFLICT (alias, alias_type) DO NOTHING;

  RETURN v_product_id;
END;
$$ LANGUAGE plpgsql;


-- 7) Action: 기존 product 에 alias 추가
CREATE OR REPLACE FUNCTION jimscanner_trends_add_alias(
  p_product_id uuid,
  p_alias text
) RETURNS void AS $$
BEGIN
  INSERT INTO jimscanner_trends_aliases (product_id, alias, alias_type, source, confidence, classified_by)
  VALUES (p_product_id, trim(p_alias), 'keyword', 'manual', 1.0, 'manual')
  ON CONFLICT (alias, alias_type) DO UPDATE
    SET product_id = EXCLUDED.product_id;

  UPDATE jimscanner_trends_products
    SET alias_count = alias_count + 1,
        last_seen_at = now()
  WHERE id = p_product_id;
END;
$$ LANGUAGE plpgsql;
