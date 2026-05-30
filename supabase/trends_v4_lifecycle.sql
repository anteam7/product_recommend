-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 확산 사다리 (Lifecycle) 뷰  (2026-05-31)
-- ─────────────────────────────────────────────────────────────
-- 목적: opportunity matrix / final_score 는 trend_score(소스 consensus)가
--   높을수록 상위 → 이미 쇼핑베스트(레드오션)에 오른 상품을 추천하는 역설.
--   확산 사다리는 소스 '도달 순서'로 단계화해, 커뮤니티·뉴스 단계의
--   미성숙·선점 가능 상품을 끌어올리는 반대 방향 렌즈.
--
-- 4단 확산 사다리 (상류 → 하류):
--   ① 커뮤니티     : 82cook / natepan / ppomppu / dcinside
--   ② 뉴스         : daum_news / naver_news
--   ③ 검색수요     : naver_search_trend / naver_shopping_insight
--   ④ 쇼핑베스트   : naver_shopping_hot / musinsa_best / aliex_best / domeggook
--
-- 각 product 의 alias(source) + 키워드 시계열(keywords.source + collected_at)을
-- 조인해 '현재 도달한 가장 하류 단'을 산출하고, 단계 체류일 + 직전 신규 소스
-- 도착 가속도(최근 7일 신규 소스 - 직전 7일 신규 소스)를 계산한다.
--
-- 노출 정책: 원천 테이블이 모두 RLS enable(service-role 전용)이므로 뷰도
--   service-role(어드민 createAdminClient)로만 조회. security_invoker 로 둬서
--   호출자(service-role) 권한으로 평가되게 한다.
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW jimscanner_trends_lifecycle
WITH (security_invoker = true)
AS
WITH source_signals AS (
  -- alias 자체가 소스 도달 신호 (alias.source + 도착시각 created_at)
  SELECT a.product_id, a.source, a.created_at AS arrived_at
  FROM jimscanner_trends_aliases a
  WHERE a.source IS NOT NULL

  UNION ALL

  -- 키워드 시계열을 alias 텍스트로 product 에 연결 (keyword alias 한정)
  SELECT a.product_id, k.source, k.collected_at AS arrived_at
  FROM jimscanner_trends_keywords k
  JOIN jimscanner_trends_aliases a
    ON a.alias = k.keyword
   AND a.alias_type = 'keyword'
  WHERE k.source IS NOT NULL
),
staged AS (
  SELECT
    product_id,
    source,
    arrived_at,
    CASE
      WHEN source IN ('82cook', 'natepan', 'ppomppu', 'dcinside')                          THEN 1
      WHEN source IN ('daum_news', 'naver_news')                                           THEN 2
      WHEN source IN ('naver_search_trend', 'naver_shopping_insight')                      THEN 3
      WHEN source IN ('naver_shopping_hot', 'musinsa_best', 'aliex_best', 'domeggook')     THEN 4
      ELSE 0
    END AS stage
  FROM source_signals
),
per_source AS (
  -- (product, source) 별 최초 도착 시각 + 단계
  SELECT product_id, source, stage, MIN(arrived_at) AS first_arrived
  FROM staged
  WHERE stage > 0
  GROUP BY product_id, source, stage
),
agg AS (
  SELECT
    product_id,
    MAX(stage)                                AS current_stage,
    COUNT(DISTINCT source)                    AS distinct_sources,
    -- 최근 7일 / 직전 7일 신규 소스 도착 수 → 가속도 산출
    COUNT(DISTINCT source) FILTER (
      WHERE first_arrived >= now() - interval '7 days'
    )                                         AS new_7d,
    COUNT(DISTINCT source) FILTER (
      WHERE first_arrived >= now() - interval '14 days'
        AND first_arrived <  now() - interval '7 days'
    )                                         AS new_prev_7d,
    bool_or(stage = 4)                        AS reached_shopping_best
  FROM per_source
  GROUP BY product_id
),
stage_entry AS (
  -- 현재(최하류) 단계에 진입한 최초 시각 → 단계 체류일 계산용
  SELECT ps.product_id, MIN(ps.first_arrived) AS stage_entered_at
  FROM per_source ps
  JOIN agg ON agg.product_id = ps.product_id
          AND ps.stage = agg.current_stage
  GROUP BY ps.product_id
)
SELECT
  p.id            AS product_id,
  p.canonical_name,
  p.category_top,
  p.brand,
  a.current_stage,
  CASE a.current_stage
    WHEN 1 THEN '① 커뮤니티'
    WHEN 2 THEN '② 뉴스'
    WHEN 3 THEN '③ 검색수요'
    WHEN 4 THEN '④ 쇼핑베스트'
  END             AS stage_label,
  a.distinct_sources,
  se.stage_entered_at,
  GREATEST(0, EXTRACT(EPOCH FROM (now() - se.stage_entered_at)) / 86400.0)::numeric(10, 1)
                  AS days_in_stage,
  a.new_7d,
  a.new_prev_7d,
  (a.new_7d - a.new_prev_7d) AS arrival_accel,
  a.reached_shopping_best,
  -- 선점 후보: ①~② 단계 & 가속 중(신규 소스 증가) & 아직 쇼핑베스트 미도달
  (a.current_stage <= 2 AND a.new_7d > a.new_prev_7d AND NOT a.reached_shopping_best)
                  AS is_preemption_candidate
FROM agg a
JOIN jimscanner_trends_products p ON p.id = a.product_id
LEFT JOIN stage_entry se ON se.product_id = a.product_id;

COMMENT ON VIEW jimscanner_trends_lifecycle IS
  '트렌드 확산 사다리: product 별 소스 도달 최하류 단계 + 체류일 + 신규소스 가속도 + 선점후보 플래그. 어드민(service-role) 전용.';
