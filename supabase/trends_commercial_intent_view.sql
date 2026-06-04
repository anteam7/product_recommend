-- ─────────────────────────────────────────────────────────────
-- 검색의향 vs 쇼핑클릭 갭 — 상업 전환 성향비 뷰 (2026-06-04)
-- ─────────────────────────────────────────────────────────────
-- 목적: 같은 키워드 축에서 네이버 두 소스를 조인해
--   commercial_intent_ratio = 쇼핑클릭지수 / 검색지수 를 산출.
--   '검색은 폭주하는데 안 사는' 정보성 수요(AVOID) 와
--   '검색 대비 쇼핑클릭이 우세한' 구매수요(BUY) 를 분리한다.
--
--   - naver_search_trend     → 검색관심도 (search_index)
--   - naver_shopping_insight → 쇼핑클릭관심도 (shopping_index)
--   둘 다 jimscanner_trends_keywords 에 source 로 구분되어 적재됨.
--   각 (keyword, source) 의 가장 최근 volume_relative 만 사용.
--
-- 조인 축: lower(btrim(keyword)) — 검색 키워드와 쇼핑 카테고리명이
--   겹치는 지점에서 ratio 가 생긴다. 한쪽만 있으면 zone='UNPAIRED'.
--
-- RLS: 뷰는 owner 권한으로 실행되며 기반 테이블이 service-role 전용이므로
--   기존 정책과 동일하게 service-role(어드민)만 읽는다.
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW jimscanner_trends_commercial_intent AS
WITH latest AS (
  SELECT DISTINCT ON (lower(btrim(keyword)), source)
    lower(btrim(keyword)) AS keyword_norm,
    keyword              AS keyword_raw,
    source,
    category_top,
    volume_relative,
    collected_at
  FROM jimscanner_trends_keywords
  WHERE source IN ('naver_search_trend', 'naver_shopping_insight')
    AND volume_relative IS NOT NULL
  ORDER BY lower(btrim(keyword)), source, collected_at DESC
),
search AS (
  SELECT keyword_norm, keyword_raw, volume_relative AS search_index, collected_at
  FROM latest WHERE source = 'naver_search_trend'
),
shopping AS (
  SELECT keyword_norm, keyword_raw, category_top, volume_relative AS shopping_index, collected_at
  FROM latest WHERE source = 'naver_shopping_insight'
)
SELECT
  COALESCE(se.keyword_raw, sh.keyword_raw)                             AS keyword,
  sh.category_top,
  se.search_index,
  sh.shopping_index,
  CASE
    WHEN se.search_index IS NOT NULL AND se.search_index > 0
      THEN round((sh.shopping_index / se.search_index)::numeric, 3)
  END                                                                  AS commercial_intent_ratio,
  CASE
    WHEN se.search_index IS NULL OR sh.shopping_index IS NULL THEN 'UNPAIRED'
    WHEN sh.shopping_index >= se.search_index            THEN 'BUY'    -- 쇼핑클릭 우세 = 구매의향 高
    ELSE 'AVOID'                                                       -- 검색만 폭주 = 정보성·비구매
  END                                                                  AS zone,
  GREATEST(se.collected_at, sh.collected_at)                          AS collected_at
FROM search se
FULL OUTER JOIN shopping sh ON se.keyword_norm = sh.keyword_norm;

COMMENT ON VIEW jimscanner_trends_commercial_intent IS
  '검색의향 vs 쇼핑클릭 갭: ratio=shopping/search, zone=BUY(쇼핑우세)/AVOID(검색만폭주)/UNPAIRED';
