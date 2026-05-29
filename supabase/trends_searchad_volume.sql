-- 검색량 절대규모 캘리브레이션 — Naver 검색광고(SearchAd) 월간검색수 앵커 — 2026-05-30
--
-- 문제: jimscanner_trends_keywords.volume_relative(0~100)는 DataLab 그룹마다
--       내부 max=100 으로 독립 정규화돼, '환율' 그룹의 80 과 '직구' 그룹의 80 이
--       서로 비교 불가하다(카테고리를 넘는 수요 우선순위가 구조적으로 불가능).
--
-- 해결: Naver 검색광고 getKeywordStat(/keywordstool) 의 monthlyPcQcCnt +
--       monthlyMobileQcCnt = 절대 월간검색수를 별도 수집해, 각 DataLab 그룹의
--       앵커(절대 수요 규모)로 사용. group_label 단위 앵커 × (ratio/100) =
--       추정 절대 월간검색수 → 그룹간 실수요 비교 축으로 재스케일링.
--
-- 수집: scripts/collect-searchad-volume.mjs (로컬 cron runner 우회)

-- ─────────────────────────────────────────
-- 1) 키워드별 절대 월간검색수 (SearchAd getKeywordStat 응답 정규화)
CREATE TABLE IF NOT EXISTS jimscanner_trends_keyword_volume (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword text NOT NULL,                 -- SearchAd relKeyword (정규화 키워드)
  group_label text,                      -- 매칭되는 DataLab 그룹 title (jimscanner_trends_keywords.keyword 와 조인)
  monthly_pc int,                        -- monthlyPcQcCnt
  monthly_mobile int,                    -- monthlyMobileQcCnt
  monthly_total int,                     -- monthly_pc + monthly_mobile (절대 월간검색수)
  comp_idx text,                         -- 경쟁정도 '낮음'/'중간'/'높음'
  collected_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jimscanner_trends_keyword_volume_kw_at
  ON jimscanner_trends_keyword_volume(keyword, collected_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_keyword_volume_group_at
  ON jimscanner_trends_keyword_volume(group_label, collected_at DESC);

ALTER TABLE jimscanner_trends_keyword_volume ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.

-- ─────────────────────────────────────────
-- 2) 그룹 앵커 RPC — group_label 별 최신 절대 월간검색수 합계
-- 각 group_label 에 속한 키워드들의 "가장 최근" monthly_total 을 합산해
-- 그룹의 절대 수요 규모(anchor)를 산출한다.
CREATE OR REPLACE FUNCTION jimscanner_trends_volume_anchors()
RETURNS TABLE (
  group_label text,
  anchor_monthly_total bigint,
  keyword_count int,
  comp_idx_max text,
  collected_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (keyword)
      keyword, group_label, monthly_total, comp_idx, collected_at
    FROM jimscanner_trends_keyword_volume
    WHERE group_label IS NOT NULL
    ORDER BY keyword, collected_at DESC
  )
  SELECT
    group_label,
    SUM(COALESCE(monthly_total, 0))::bigint        AS anchor_monthly_total,
    COUNT(*)::int                                  AS keyword_count,
    -- 경쟁정도: 가장 높은 등급을 대표값으로 (낮음<중간<높음)
    MAX(CASE comp_idx WHEN '높음' THEN '높음' WHEN '중간' THEN '중간' WHEN '낮음' THEN '낮음' ELSE NULL END) AS comp_idx_max,
    MAX(collected_at)                              AS collected_at
  FROM latest
  GROUP BY group_label;
$$;

-- ─────────────────────────────────────────
-- 3) 재스케일 뷰 — DataLab 키워드 latest ratio × 그룹 앵커 = 추정 절대 월간검색수
-- jimscanner_trends_keywords.keyword == group_label 로 조인.
CREATE OR REPLACE FUNCTION jimscanner_trends_calibrated_keywords()
RETURNS TABLE (
  keyword text,
  source text,
  category_top text,
  volume_relative numeric,
  anchor_monthly_total bigint,
  estimated_monthly_volume bigint,
  collected_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  WITH latest_kw AS (
    SELECT DISTINCT ON (keyword, source)
      keyword, source, category_top, volume_relative, collected_at
    FROM jimscanner_trends_keywords
    ORDER BY keyword, source, collected_at DESC
  ),
  anchors AS (
    SELECT * FROM jimscanner_trends_volume_anchors()
  )
  SELECT
    k.keyword,
    k.source,
    k.category_top,
    k.volume_relative,
    a.anchor_monthly_total,
    -- ratio(0~100) 를 그룹 절대 규모로 환산. 앵커 없으면 NULL.
    CASE
      WHEN a.anchor_monthly_total IS NULL THEN NULL
      ELSE ROUND(a.anchor_monthly_total * COALESCE(k.volume_relative, 0) / 100.0)::bigint
    END AS estimated_monthly_volume,
    k.collected_at
  FROM latest_kw k
  LEFT JOIN anchors a ON a.group_label = k.keyword;
$$;
