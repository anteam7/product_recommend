-- ─────────────────────────────────────────────────────────────
-- 스코어 예측타당성 백테스트 뷰 (2026-05-29)
-- ─────────────────────────────────────────────────────────────
-- 목적: jimscanner_trends_scores 의 4개 sub-score(trend/commerce/supplier/
--   competition)와 final_score 가 "실제 성과를 예측했는가"를 사후 결과와
--   조인해 평가하는 폐루프(closed-loop)를 만든다.
--
-- 결과(outcome) 정의 — 스냅샷 시점(computed_at) 이후 N일(기본 30일) 내:
--   ① was_pinned     : 운영자가 소싱 후보로 핀한 사실 (소싱 의사결정 전환)
--   ② order_count_30d: 쿠팡 발행 후 실제 판매 건수 (이름 매칭 기반 프록시)
--   ③ revenue_30d    : 동기간 매출 합계
--   outcome_success  : was_pinned OR order_count_30d > 0
--
-- 주의:
--   - jimscanner_coupang_orders / jimscanner_trends_pins 는 product_id FK 가
--     없으므로 canonical_name·alias 의 ILIKE 부분일치로 느슨하게 매칭한다(프록시).
--   - is_mature: 결과 라벨이 성숙(스냅샷 후 horizon 경과)했는지 플래그.
--     백테스트 분석은 is_mature = true 행만 사용해야 편향이 없다.
--   - RLS: 베이스 테이블이 service-role 전용이므로 뷰도 service-role 에서만 조회.
--
-- UI: /admin/trend-radar/backtest
-- ─────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS jimscanner_trends_score_backtest;

CREATE VIEW jimscanner_trends_score_backtest AS
WITH snap AS (
  SELECT
    s.id            AS score_id,
    s.product_id,
    s.trend_score,
    s.commerce_score,
    s.supplier_score,
    s.competition_score,
    s.final_score,
    s.computed_at,
    p.canonical_name,
    p.category_top
  FROM jimscanner_trends_scores s
  JOIN jimscanner_trends_products p ON p.id = s.product_id
)
SELECT
  snap.score_id,
  snap.product_id,
  snap.canonical_name,
  snap.category_top,
  snap.trend_score,
  snap.commerce_score,
  snap.supplier_score,
  snap.competition_score,
  snap.final_score,
  snap.computed_at,

  -- ① 소싱 의사결정 전환: 스냅샷 이후 30일 내 핀
  EXISTS (
    SELECT 1
    FROM jimscanner_trends_pins pin
    WHERE pin.pinned_at >= snap.computed_at
      AND pin.pinned_at <  snap.computed_at + interval '30 days'
      AND (
        pin.keyword ILIKE '%' || snap.canonical_name || '%'
        OR snap.canonical_name ILIKE '%' || pin.keyword || '%'
        OR EXISTS (
          SELECT 1 FROM jimscanner_trends_aliases a
          WHERE a.product_id = snap.product_id
            AND (a.alias ILIKE '%' || pin.keyword || '%'
                 OR pin.keyword ILIKE '%' || a.alias || '%')
        )
      )
  ) AS was_pinned,

  -- ② 쿠팡 판매 건수 (이름 매칭 프록시)
  COALESCE((
    SELECT count(*)
    FROM jimscanner_coupang_orders o
    WHERE COALESCE(o.paid_at, o.ordered_at) >= snap.computed_at
      AND COALESCE(o.paid_at, o.ordered_at) <  snap.computed_at + interval '30 days'
      AND (
        o.product_name ILIKE '%' || snap.canonical_name || '%'
        OR EXISTS (
          SELECT 1 FROM jimscanner_trends_aliases a
          WHERE a.product_id = snap.product_id
            AND o.product_name ILIKE '%' || a.alias || '%'
        )
      )
  ), 0) AS order_count_30d,

  -- ③ 동기간 매출
  COALESCE((
    SELECT sum(COALESCE(o.paid_amount, o.order_price, 0))
    FROM jimscanner_coupang_orders o
    WHERE COALESCE(o.paid_at, o.ordered_at) >= snap.computed_at
      AND COALESCE(o.paid_at, o.ordered_at) <  snap.computed_at + interval '30 days'
      AND (
        o.product_name ILIKE '%' || snap.canonical_name || '%'
        OR EXISTS (
          SELECT 1 FROM jimscanner_trends_aliases a
          WHERE a.product_id = snap.product_id
            AND o.product_name ILIKE '%' || a.alias || '%'
        )
      )
  ), 0) AS revenue_30d,

  -- 라벨 성숙 여부 (스냅샷 후 horizon 경과)
  (snap.computed_at < now() - interval '7 days') AS is_mature

FROM snap;

COMMENT ON VIEW jimscanner_trends_score_backtest IS
  '스코어 예측타당성 백테스트: 4 sub-score 스냅샷 × 사후 결과(핀/쿠팡판매). is_mature=true 행만 분석에 사용.';
