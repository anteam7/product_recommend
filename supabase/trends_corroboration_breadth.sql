-- ─────────────────────────────────────────────────────────────
-- 교차 모달리티 출처폭(corroboration breadth) 뷰 — 단일소스 스파이크 격리
-- ─────────────────────────────────────────────────────────────
-- 목적: jimscanner_trends_aliases.source(16개 수집원)를 5개 '모달리티'로
--   매핑하고, canonical product 별로 '독립적으로 등장한 모달리티 집합·폭'을
--   집계한다. 점수 내부에 묻혀있는 source_consensus 스칼라를 모달리티 다양성
--   기준으로 전면 노출·랭킹화하기 위한 데이터 소스.
--
--   모달리티 분류 (UI src/app/admin/.../corroboration/page.tsx 와 동기화):
--     search    = naver_search_trend · naver_shopping_insight · google_suggest
--     shopping  = naver_shopping_hot · musinsa · aliex · domeggook
--     community = 82cook · natepan · ppomppu · dcinside · clien
--     tv        = naver_tvtime
--     news      = daum · naver · kca
--
--   독립성 가중치: 서로 다른 모달리티가 동시에 포착하면 신뢰도가 높다.
--   breadth = 등장한 distinct 모달리티 수 (1~5). breadth=1 이면 단일소스 취약.
--
-- 노출 정책: SECURITY INVOKER. service-role(어드민)만 base 테이블 접근 가능하므로
--   기존 RLS 정책을 그대로 상속한다.
-- 적용은 사람이 수동(psql)으로 한다. 코드(UI)는 alias 테이블에서 직접 집계하므로
--   이 뷰가 아직 없어도 빌드/런타임에 문제 없음 — SQL 레벨 분석/디버깅용.
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_trends_modality(src text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN src IN ('naver_search_trend', 'naver_shopping_insight', 'google_suggest') THEN 'search'
    WHEN src IN ('naver_shopping_hot', 'musinsa', 'aliex', 'domeggook')            THEN 'shopping'
    WHEN src IN ('82cook', 'natepan', 'ppomppu', 'dcinside', 'clien')              THEN 'community'
    WHEN src IN ('naver_tvtime')                                                   THEN 'tv'
    WHEN src IN ('daum', 'naver', 'kca')                                           THEN 'news'
    ELSE 'other'
  END;
$$;

-- product_id × modality 매트릭스 + breadth 집계 뷰
CREATE OR REPLACE VIEW jimscanner_corroboration_breadth AS
WITH alias_modality AS (
  SELECT
    a.product_id,
    jimscanner_trends_modality(a.source) AS modality,
    a.source,
    a.confidence
  FROM jimscanner_trends_aliases a
  WHERE a.source IS NOT NULL
),
per_modality AS (
  SELECT
    product_id,
    modality,
    count(*)                         AS alias_count,
    count(DISTINCT source)           AS source_count,
    max(confidence)                  AS max_confidence
  FROM alias_modality
  GROUP BY product_id, modality
)
SELECT
  product_id,
  -- 등장한 모달리티 집합 (other 제외 = 의미있는 교차검증 모달리티)
  array_agg(modality ORDER BY modality)
    FILTER (WHERE modality <> 'other')                       AS modalities,
  count(*) FILTER (WHERE modality <> 'other')                AS breadth,
  count(*)                                                   AS modality_count_incl_other,
  sum(alias_count)                                           AS total_aliases,
  sum(source_count) FILTER (WHERE modality <> 'other')       AS distinct_sources,
  -- 독립성 가중치: breadth 가 클수록, 그리고 단일 모달리티 편중이 적을수록 높음.
  -- (모달리티 다양성을 0~1 로 정규화: 등장 모달리티수 / 전체 5)
  round(
    (count(*) FILTER (WHERE modality <> 'other'))::numeric / 5.0,
    3
  )                                                          AS independence_weight,
  bool_or(modality = 'tv')                                   AS has_tv,
  bool_or(modality = 'community')                            AS has_community,
  bool_or(modality = 'search')                               AS has_search,
  bool_or(modality = 'shopping')                             AS has_shopping,
  bool_or(modality = 'news')                                 AS has_news
FROM per_modality
GROUP BY product_id;

COMMENT ON VIEW jimscanner_corroboration_breadth IS
  '교차 모달리티 출처폭 — product_id 별 등장 모달리티 집합/breadth/독립성 가중치. breadth=1 은 단일소스 취약 스파이크.';
