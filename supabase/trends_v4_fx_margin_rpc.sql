-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 환율 연동 착지원가 리프레시 + FX 마진 스트레스
-- ─────────────────────────────────────────────────────────────
-- 문제: jimscanner_trends_supplier 의 price_krw 는 collected_at 시점 환율로
--       박제된 스냅샷. 환율이 움직이면 그 위에서 내린 마진/위탁 결정이 조용히 틀어짐.
-- 해법: price_original × 현재 jimscanner_exchange_rates.rate_krw 로 착지원가를
--       실시간 재계산하고, collected_at 환율 대비 갭(stale Δ%)을 노출.
--
-- 본 RPC 는 "환산까지만" 책임진다. 마진/손익분기/±스트레스 게이팅은
--   src/.../trend-radar/fx-margin/page.tsx 가 coupang_pricing(FEE/SHIP) 상수로 계산.
--   (FEE/SHIP 가 TS 단일 출처라 SQL 에 중복 박제하지 않기 위함)
--
-- 적용: Supabase Dashboard > SQL Editor > 붙여넣고 Run
-- 참조: supabase/trends_v4_seller_tools.sql, supabase/exchange_rates.sql
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_trends_fx_margin(
  result_limit int DEFAULT 500
)
RETURNS TABLE (
  supplier_id        uuid,
  product_id         uuid,
  canonical_name     text,
  category_top       text,
  supplier_source    text,
  supplier_url       text,
  title              text,
  price_currency     text,
  price_original     numeric,
  price_krw_snapshot numeric,    -- 수집 시점 박제가 (price_krw)
  current_rate_krw   numeric,    -- 현재 환율
  -- 수집 시점 환율: 박제가 ÷ 원가. price_krw 가 환율만으로 환산됐다는 가정의 근사치.
  snapshot_rate_krw  numeric,
  landed_cost_now    numeric,    -- price_original × current_rate_krw (실시간 착지원가, KRW 는 그대로)
  stale_delta_pct    numeric,    -- (current - snapshot) / snapshot × 100
  collected_at       timestamptz
)
LANGUAGE sql
STABLE
AS $$
  WITH latest_supplier AS (
    SELECT DISTINCT ON (s.supplier_source, s.supplier_product_id)
      s.id, s.product_id, s.supplier_source, s.supplier_url, s.title,
      s.price_currency, s.price_original, s.price_krw, s.collected_at
    FROM jimscanner_trends_supplier s
    WHERE s.supplier_source IN ('1688', 'aliexpress', 'temu')  -- 해외 소싱 후보만
      AND s.price_original IS NOT NULL
      AND s.price_currency <> 'KRW'
    ORDER BY s.supplier_source, s.supplier_product_id, s.collected_at DESC
  )
  SELECT
    ls.id,
    ls.product_id,
    p.canonical_name,
    p.category_top,
    ls.supplier_source,
    ls.supplier_url,
    ls.title,
    ls.price_currency,
    ls.price_original,
    ls.price_krw,
    r.rate_krw,
    CASE WHEN ls.price_original > 0 THEN ROUND(ls.price_krw / ls.price_original, 4) END,
    ROUND(ls.price_original * r.rate_krw)::numeric,
    CASE
      WHEN ls.price_original > 0 AND ls.price_krw > 0
      THEN ROUND(((r.rate_krw - (ls.price_krw / ls.price_original)) / (ls.price_krw / ls.price_original)) * 100, 2)
    END,
    ls.collected_at
  FROM latest_supplier ls
  JOIN jimscanner_trends_products p ON p.id = ls.product_id
  LEFT JOIN jimscanner_exchange_rates r ON r.currency = ls.price_currency
  ORDER BY ABS(COALESCE(
    CASE
      WHEN ls.price_original > 0 AND ls.price_krw > 0
      THEN ((r.rate_krw - (ls.price_krw / ls.price_original)) / (ls.price_krw / ls.price_original)) * 100
    END, 0)) DESC
  LIMIT result_limit;
$$;

-- 30일 환율 변동성 (통화별 표준편차/평균 = 변동계수) — '변동성 큰 통화 의존' 감점용
CREATE OR REPLACE FUNCTION jimscanner_fx_volatility_30d()
RETURNS TABLE (
  currency      text,
  sample_count  int,
  avg_rate      numeric,
  stddev_rate   numeric,
  cov_pct       numeric,   -- 변동계수 (%) = stddev / avg × 100
  min_rate      numeric,
  max_rate      numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    currency,
    COUNT(*)::int,
    ROUND(AVG(rate_krw), 4),
    ROUND(COALESCE(STDDEV_POP(rate_krw), 0), 4),
    CASE WHEN AVG(rate_krw) > 0
      THEN ROUND((COALESCE(STDDEV_POP(rate_krw), 0) / AVG(rate_krw)) * 100, 2)
      ELSE 0 END,
    MIN(rate_krw),
    MAX(rate_krw)
  FROM jimscanner_exchange_rate_logs
  WHERE created_at >= now() - interval '30 days'
    AND status = 'success'
  GROUP BY currency;
$$;
