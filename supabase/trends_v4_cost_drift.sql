-- =============================================================================
-- Cost Drift View — 발행 SKU 도매원가 재평가
-- =============================================================================
-- 목적: jimscanner_coupang_listings 의 등록 시점 스냅샷(estimated_margin_pct,
--   dome_price_krw, registered_at) 과 jimscanner_ggsan_price_history 시계열을
--   source_goods_no = goods_no 키로 조인하여 'silent 마진 붕괴' 를 감지.
--
-- 산출 컬럼:
--   - dome_price_current_krw : 가장 최근 관측 도매가
--   - dome_price_delta_krw   : 등록 시 도매가 → 현재 도매가 절대 차이
--   - dome_price_delta_pct   : Δ% (현재 / 등록 시 - 1) * 100
--   - recalculated_margin_krw / _pct : 등록 시 list_price / msp 기준으로 도매가만
--       현재값으로 갈아끼웠을 때의 재산정 마진
--   - status_churn_30d       : 최근 30일간 ggsan 측 status 전환 횟수
--   - status_current         : 가장 최근 관측 status
--   - cost_drift_alert       : 임계 초과 플래그
--       조건: dome_price_delta_pct >= +5
--            OR recalculated_margin_pct < estimated_margin_pct / 2
--   - recommended_action     : 'raise_msp' | 'hold' | 'delist'
-- =============================================================================

CREATE OR REPLACE VIEW jimscanner_v_listing_cost_drift AS
WITH latest_observation AS (
  SELECT DISTINCT ON (goods_no)
    goods_no,
    price_krw AS dome_price_current_krw,
    status    AS status_current,
    observed_at AS last_observed_at
  FROM jimscanner_ggsan_price_history
  ORDER BY goods_no, observed_at DESC
),
status_changes AS (
  -- 최근 30일 status 전환 횟수: 직전 row 와 status 가 다르면 +1
  SELECT
    goods_no,
    COUNT(*) FILTER (WHERE prev_status IS NOT NULL AND prev_status <> status) AS status_churn_30d
  FROM (
    SELECT
      goods_no,
      status,
      LAG(status) OVER (PARTITION BY goods_no ORDER BY observed_at) AS prev_status
    FROM jimscanner_ggsan_price_history
    WHERE observed_at >= now() - interval '30 days'
  ) s
  GROUP BY goods_no
)
SELECT
  l.id,
  l.source_goods_no,
  l.registered_title,
  l.brand,
  l.display_category_name,
  l.status,
  l.displayable,
  l.dome_price_krw       AS dome_price_registered_krw,
  l.msp_price_krw,
  l.list_price_krw,
  l.estimated_margin_pct,
  l.estimated_margin_krw,
  l.source_shipping_fee_krw,
  l.outbound_shipping_fee_krw,
  l.registered_at,
  l.product_id,
  l.source_detail_url,
  lo.dome_price_current_krw,
  lo.status_current,
  lo.last_observed_at,
  COALESCE(sc.status_churn_30d, 0)::int AS status_churn_30d,

  -- 도매가 변동
  (lo.dome_price_current_krw - l.dome_price_krw) AS dome_price_delta_krw,
  CASE
    WHEN l.dome_price_krw IS NULL OR l.dome_price_krw = 0 THEN NULL
    WHEN lo.dome_price_current_krw IS NULL THEN NULL
    ELSE ROUND(
      ((lo.dome_price_current_krw::numeric - l.dome_price_krw) / l.dome_price_krw) * 100,
      2
    )
  END AS dome_price_delta_pct,

  -- 재산정 마진 (현재 도매가 기준, list_price / msp / 배송비는 등록 시 값 유지)
  CASE
    WHEN lo.dome_price_current_krw IS NULL THEN NULL
    ELSE (
      l.list_price_krw
      - lo.dome_price_current_krw
      - COALESCE(l.source_shipping_fee_krw, 0)
      - COALESCE(l.outbound_shipping_fee_krw, 0)
      - COALESCE(l.estimated_fee_krw, 0)
    )
  END AS recalculated_margin_krw,

  CASE
    WHEN lo.dome_price_current_krw IS NULL OR l.list_price_krw IS NULL OR l.list_price_krw = 0
      THEN NULL
    ELSE ROUND(
      (
        (
          l.list_price_krw
          - lo.dome_price_current_krw
          - COALESCE(l.source_shipping_fee_krw, 0)
          - COALESCE(l.outbound_shipping_fee_krw, 0)
          - COALESCE(l.estimated_fee_krw, 0)
        )::numeric / l.list_price_krw
      ) * 100,
      2
    )
  END AS recalculated_margin_pct,

  -- 알람 플래그 + 권장 액션
  CASE
    WHEN lo.dome_price_current_krw IS NULL THEN false
    WHEN l.dome_price_krw IS NULL OR l.dome_price_krw = 0 THEN false
    WHEN ((lo.dome_price_current_krw - l.dome_price_krw)::numeric / l.dome_price_krw) >= 0.05
      THEN true
    WHEN l.estimated_margin_pct IS NOT NULL
      AND l.list_price_krw IS NOT NULL AND l.list_price_krw <> 0
      AND (
        (
          l.list_price_krw
          - lo.dome_price_current_krw
          - COALESCE(l.source_shipping_fee_krw, 0)
          - COALESCE(l.outbound_shipping_fee_krw, 0)
          - COALESCE(l.estimated_fee_krw, 0)
        )::numeric / l.list_price_krw
      ) * 100 < (l.estimated_margin_pct / 2.0)
      THEN true
    ELSE false
  END AS cost_drift_alert,

  CASE
    WHEN lo.dome_price_current_krw IS NULL THEN 'hold'
    WHEN lo.status_current = 'sold_out' THEN 'delist'
    -- 재산정 마진이 음수면 즉시 delist 권장
    WHEN l.list_price_krw IS NOT NULL
      AND (
        l.list_price_krw
        - lo.dome_price_current_krw
        - COALESCE(l.source_shipping_fee_krw, 0)
        - COALESCE(l.outbound_shipping_fee_krw, 0)
        - COALESCE(l.estimated_fee_krw, 0)
      ) < 0
      THEN 'delist'
    -- 도매가 5% 이상 인상 → MSP 인상 권장
    WHEN l.dome_price_krw IS NOT NULL AND l.dome_price_krw <> 0
      AND ((lo.dome_price_current_krw - l.dome_price_krw)::numeric / l.dome_price_krw) >= 0.05
      THEN 'raise_msp'
    ELSE 'hold'
  END AS recommended_action

FROM jimscanner_coupang_listings l
LEFT JOIN latest_observation lo
  ON lo.goods_no = l.source_goods_no
LEFT JOIN status_changes sc
  ON sc.goods_no = l.source_goods_no;

COMMENT ON VIEW jimscanner_v_listing_cost_drift IS
  '발행 SKU 별 등록 시 vs 현재 도매가 변동 / 재산정 마진 / status churn 집계. /admin/coupang-publish/cost-drift 와 scripts/cost-drift-scan.mjs 에서 사용.';

-- 뷰는 RLS 우회되지 않으므로, 서버 컴포넌트(service-role)에서만 사용.
-- 어드민 외에 노출 금지.
