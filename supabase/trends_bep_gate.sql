-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 — 광고비 회수 손익분기 판매량(BEP) 게이트 (2026-06-04)
-- ─────────────────────────────────────────────────────────────
-- 목적: 신규 위탁 후보가 '초기 광고비를 회수하는 데 몇 개를 팔아야 하는가(BEP units)'를
--       역산하고, 트렌드 신호로 추정한 월수요와 대조해 '도달 가능성'을 게이팅한다.
--
-- 본 뷰는 product 별 '최신 supplier 도매가 + 최신 4축 score' 만 한 행으로 합친다.
-- 실제 BEP·도달여유배수 계산은 어드민 입력 상수(초기광고예산·고정비·CPC·전환율·마크업)에
-- 의존하므로 뷰가 아니라 page.tsx 에서 수행한다 (상수는 query param).
--
-- 노출 정책: 기반 테이블(jimscanner_trends_*)이 모두 RLS enable + 정책 X = service-role 전용.
--   뷰도 동일하게 service-role(어드민)로만 조회된다.
-- 관련: supabase/trends_v4_seller_tools.sql, src/app/admin/(dashboard)/trend-radar/bep/page.tsx
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW jimscanner_trends_bep_gate
WITH (security_invoker = true)
AS
WITH latest_score AS (
  SELECT DISTINCT ON (s.product_id)
    s.product_id,
    s.trend_score,
    s.commerce_score,
    s.competition_score,
    s.final_score,
    s.score_components,
    s.computed_at
  FROM jimscanner_trends_scores s
  ORDER BY s.product_id, s.computed_at DESC
),
latest_supplier AS (
  -- product 당 '가장 싼 최신' 도매가 (가격 있는 행 우선). 위탁 단위원가의 베이스.
  SELECT DISTINCT ON (sup.product_id)
    sup.product_id,
    sup.supplier_source,
    sup.price_krw,
    sup.moq,
    sup.lead_time_days,
    sup.collected_at
  FROM jimscanner_trends_supplier sup
  WHERE sup.price_krw IS NOT NULL AND sup.price_krw > 0
  ORDER BY sup.product_id, sup.collected_at DESC, sup.price_krw ASC
)
SELECT
  p.id                       AS product_id,
  p.canonical_name,
  p.category_top,
  p.category_mid,
  p.brand,
  ls.trend_score,
  ls.commerce_score,
  ls.competition_score,
  ls.final_score,
  -- score_components 안에 volume_relative 류 신호가 있으면 우선 사용 (없으면 page 에서 trend_score 대체)
  (ls.score_components -> 'trend' ->> 'volume_relative')::numeric AS volume_relative,
  ls.computed_at             AS score_computed_at,
  lsup.supplier_source,
  lsup.price_krw             AS supplier_price_krw,
  lsup.moq                   AS supplier_moq,
  lsup.lead_time_days        AS supplier_lead_time_days,
  lsup.collected_at          AS supplier_collected_at
FROM jimscanner_trends_products p
JOIN latest_score ls    ON ls.product_id = p.id
JOIN latest_supplier lsup ON lsup.product_id = p.id;

-- 참고: 어드민(service-role) 전용. 뷰는 RLS 를 직접 갖지 않으나
--   security_invoker=true 로 호출자(service-role) 권한을 따르고,
--   기반 테이블이 service-role 외 접근을 차단하므로 동일 보안 경계를 유지한다.
