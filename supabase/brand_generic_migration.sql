-- ────────────────────────────────────────────────────────────
-- 브랜드→제네릭 이행 지수 (commoditization) — 2026-05-19
-- ────────────────────────────────────────────────────────────
-- 키워드 별 brand_kind 라벨링 + 카테고리별 28일 ratio 추세 RPC.
-- ratio = branded_volume / (branded_volume + generic_volume)
-- 우하향 = 소비자가 브랜드를 떠나기 시작 = 위탁/PB 진입 윈도우.
-- ────────────────────────────────────────────────────────────

-- 1) jimscanner_trends_keywords 에 brand_kind 라벨 추가
ALTER TABLE jimscanner_trends_keywords
  ADD COLUMN IF NOT EXISTS brand_kind text
    CHECK (brand_kind IN ('branded', 'generic', 'unknown')),
  ADD COLUMN IF NOT EXISTS brand_kind_at timestamptz;

CREATE INDEX IF NOT EXISTS jimscanner_trends_keywords_brand_kind_cat
  ON jimscanner_trends_keywords(category_top, collected_at DESC)
  WHERE brand_kind IS NOT NULL;

CREATE INDEX IF NOT EXISTS jimscanner_trends_keywords_brand_kind_unclassified
  ON jimscanner_trends_keywords(collected_at DESC)
  WHERE brand_kind IS NULL;

-- 2) 카테고리별 일자별 브랜드:제네릭 비율 RPC
-- p_category=NULL 이면 모든 카테고리 반환 (UI 에서 카드별 그룹핑).
CREATE OR REPLACE FUNCTION jimscanner_brand_generic_trend(
  p_category text DEFAULT NULL,
  p_days int DEFAULT 28
)
RETURNS TABLE (
  category_top text,
  day date,
  branded_volume numeric,
  generic_volume numeric,
  ratio numeric,
  branded_count int,
  generic_count int
)
LANGUAGE sql STABLE
AS $$
  WITH base AS (
    SELECT
      coalesce(k.category_top, 'unknown') AS category_top,
      (k.collected_at AT TIME ZONE 'Asia/Seoul')::date AS day,
      k.brand_kind,
      coalesce(k.volume_relative, 1)::numeric AS volume_relative
    FROM jimscanner_trends_keywords k
    WHERE k.collected_at >= now() - (p_days || ' days')::interval
      AND k.brand_kind IN ('branded', 'generic')
      AND (p_category IS NULL OR coalesce(k.category_top, 'unknown') = p_category)
  )
  SELECT
    category_top,
    day,
    coalesce(sum(volume_relative) FILTER (WHERE brand_kind = 'branded'), 0)::numeric AS branded_volume,
    coalesce(sum(volume_relative) FILTER (WHERE brand_kind = 'generic'), 0)::numeric AS generic_volume,
    CASE
      WHEN coalesce(sum(volume_relative) FILTER (WHERE brand_kind = 'branded'), 0)
         + coalesce(sum(volume_relative) FILTER (WHERE brand_kind = 'generic'), 0) = 0
      THEN NULL
      ELSE coalesce(sum(volume_relative) FILTER (WHERE brand_kind = 'branded'), 0)
           / NULLIF(
             coalesce(sum(volume_relative) FILTER (WHERE brand_kind = 'branded'), 0)
             + coalesce(sum(volume_relative) FILTER (WHERE brand_kind = 'generic'), 0), 0)
    END AS ratio,
    count(*) FILTER (WHERE brand_kind = 'branded')::int AS branded_count,
    count(*) FILTER (WHERE brand_kind = 'generic')::int AS generic_count
  FROM base
  GROUP BY category_top, day
  ORDER BY category_top, day;
$$;

-- 3) 카테고리별 최근 generic 키워드 상위 (drill-down)
CREATE OR REPLACE FUNCTION jimscanner_brand_generic_top_keywords(
  p_category text,
  p_kind text DEFAULT 'generic',
  p_days int DEFAULT 14,
  p_limit int DEFAULT 30
)
RETURNS TABLE (
  keyword text,
  total_volume numeric,
  hits int,
  last_seen timestamptz
)
LANGUAGE sql STABLE
AS $$
  SELECT
    k.keyword,
    coalesce(sum(coalesce(k.volume_relative, 1)), 0)::numeric AS total_volume,
    count(*)::int AS hits,
    max(k.collected_at) AS last_seen
  FROM jimscanner_trends_keywords k
  WHERE k.collected_at >= now() - (p_days || ' days')::interval
    AND k.brand_kind = p_kind
    AND coalesce(k.category_top, 'unknown') = p_category
  GROUP BY k.keyword
  ORDER BY total_volume DESC, hits DESC
  LIMIT p_limit;
$$;
