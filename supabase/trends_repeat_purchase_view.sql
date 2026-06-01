-- ────────────────────────────────────────────────────────────
-- 재구매 엔진 발굴 보드 — 소모품·정기소비 LTV 렌즈 (2026-06-01)
-- ────────────────────────────────────────────────────────────
-- intent_label(LLM 분류) + category_mid/canonical_name 키워드 휴리스틱으로
-- '재구매 주기(일)'를 추정하고, [수요(trend_score) × 추정 재구매빈도]로 재랭킹.
-- 일회성(durable)·소모품(consumable)·미상(unknown)으로 버킷 분리.
--
-- 이 .sql 은 어드민 /trend-radar/repeat-purchase 페이지가 사용하는
-- 뷰의 reference 정의다. 페이지는 뷰 미적용 시에도 동작하도록 TS 휴리스틱을
-- 내장하지만, 뷰를 적용하면 DB 차원 재사용(다른 스크립트/RPC)이 가능하다.
-- 적용: psql + PGPASSWORD (docs/database.md), Connection Pooler(6543).
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW jimscanner_trends_repeat_purchase AS
WITH latest_score AS (
  -- product 별 가장 최근 score row 만
  SELECT DISTINCT ON (product_id)
    product_id,
    trend_score,
    final_score,
    computed_at
  FROM jimscanner_trends_scores
  ORDER BY product_id, computed_at DESC
),
estimated AS (
  SELECT
    p.id,
    p.canonical_name,
    p.category_top,
    p.category_mid,
    p.intent_label,
    p.alias_count,
    p.last_seen_at,
    COALESCE(s.trend_score, 0)  AS trend_score,
    COALESCE(s.final_score, 0)  AS final_score,
    -- 매칭 텍스트(소문자) : 카테고리중분류 + canonical_name + intent_label
    lower(coalesce(p.category_mid,'') || ' ' || coalesce(p.canonical_name,'') || ' ' || coalesce(p.intent_label,'')) AS match_text
  FROM jimscanner_trends_products p
  LEFT JOIN latest_score s ON s.product_id = p.id
),
cycled AS (
  SELECT
    e.*,
    CASE
      WHEN e.intent_label IS NULL THEN NULL                       -- 미상 (classify 우선 환류)
      -- 짧은 주기(월 1회 이상) 소모품
      WHEN e.match_text ~ '(영양제|비타민|유산균|루테인|오메가|콜라겐|프로틴|면도날|면도|렌즈|기저귀|물티슈|세제|세정|샴푸|치약|커피|캡슐|원두|화장지|기저귀|사료|간식|영양제|건기식|보충제)'
        THEN 30
      -- 분기 주기 소모품
      WHEN e.match_text ~ '(필터|정수기|공기청정|칫솔|면도기헤드|렌즈세정|향수리필|디퓨저)'
        THEN 90
      -- intent_label 이 소모/예방 류면 보수적으로 월 1회
      WHEN e.intent_label ~ '(소모품|예방건강|정기|구독|반복)'
        THEN 30
      ELSE 365                                                    -- 일회성(durable)
    END AS repeat_cycle_days
  FROM estimated e
)
SELECT
  c.id,
  c.canonical_name,
  c.category_top,
  c.category_mid,
  c.intent_label,
  c.alias_count,
  c.last_seen_at,
  c.trend_score,
  c.final_score,
  c.repeat_cycle_days,
  -- 연간 재구매 횟수 (durable=1)
  CASE WHEN c.repeat_cycle_days IS NULL THEN NULL
       ELSE GREATEST(1.0, 365.0 / c.repeat_cycle_days) END AS annual_repeat,
  -- 버킷
  CASE
    WHEN c.intent_label IS NULL THEN 'unknown'
    WHEN c.repeat_cycle_days <= 90 THEN 'consumable'
    ELSE 'durable'
  END AS repeat_bucket,
  -- LTV 지수 = 수요(trend_score) × 연 재구매수 (단가/마진은 ggsan join 시 곱)
  CASE WHEN c.intent_label IS NULL THEN c.trend_score
       ELSE c.trend_score * GREATEST(1.0, 365.0 / c.repeat_cycle_days) END AS ltv_index
FROM cycled c
ORDER BY ltv_index DESC;

COMMENT ON VIEW jimscanner_trends_repeat_purchase IS
  '재구매 렌즈: intent_label+키워드로 재구매주기 추정, trend_score×연재구매수로 LTV 지수 재랭킹';
