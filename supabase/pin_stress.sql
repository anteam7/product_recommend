-- ─────────────────────────────────────────────────────────────
-- 핀별 마진 스트레스 테스트 (토네이도) — 2026-05-20
-- ─────────────────────────────────────────────────────────────
-- jimscanner_trends_products(=핀 후보) 1행 + 최신 scores + 최적 supplier
-- + CNY 환율 + 카테고리별 duty + 대표 택배비 를 한 row 로 결합한 뷰.
-- UI 측은 이 뷰 만 읽으면 4개 외생인자(환율/관세율/도매가/택배비) ± 흔들기를
-- TS 로 계산 가능. 별도 RPC 불필요 — 뷰가 더 단순하고 디버깅 쉬움.
--
-- 정책: service-role 만 접근 (어드민 한정).
-- 의존 테이블 / 컬럼:
--   jimscanner_trends_products(id, canonical_name, category_top, ...)
--   jimscanner_trends_scores(product_id, final_score, ..., computed_at)
--   jimscanner_trends_supplier(product_id, price_krw, price_original, price_currency,
--                              supplier_source, collected_at)
--   jimscanner_exchange_rates(currency, rate_krw)
--   jimscanner_duty_rates(category_tag, duty_rate_percent, vat_rate_percent)
-- ─────────────────────────────────────────────────────────────

-- 카테고리(top) → duty category_tag 매핑 (간단 휴리스틱)
--   health  → 식품/보조제 ≈ 'OTHER' (8%)
--   living  → 생활용품 ≈ 'OTHER' (8%)
--   digital → 'ELECTRONICS' (8%, 가전)
-- 매핑이 없으면 fallback 8% / VAT 10%.

CREATE OR REPLACE VIEW jimscanner_pin_stress_inputs AS
WITH latest_scores AS (
  SELECT DISTINCT ON (product_id)
    product_id,
    final_score,
    trend_score,
    commerce_score,
    supplier_score,
    competition_score,
    computed_at
  FROM jimscanner_trends_scores
  ORDER BY product_id, computed_at DESC
),
best_supplier AS (
  -- 같은 product 의 supplier row 중 한국 도착 추정가(price_krw) 최저 1행
  SELECT DISTINCT ON (product_id)
    product_id,
    supplier_source,
    price_krw,
    price_original,
    price_currency,
    collected_at
  FROM jimscanner_trends_supplier
  WHERE price_krw IS NOT NULL AND price_krw > 0
  ORDER BY product_id, price_krw ASC
),
fx AS (
  SELECT
    COALESCE((SELECT rate_krw FROM jimscanner_exchange_rates WHERE currency = 'CNY'), 195.0)::numeric AS cny_krw,
    COALESCE((SELECT rate_krw FROM jimscanner_exchange_rates WHERE currency = 'USD'), 1450.0)::numeric AS usd_krw
),
duty_map AS (
  -- top → tag 매핑
  SELECT *
  FROM (
    VALUES
      ('digital', 'ELECTRONICS'),
      ('health',  'OTHER'),
      ('living',  'OTHER')
  ) AS m(category_top, category_tag)
)
SELECT
  p.id                                   AS product_id,
  p.canonical_name                       AS name,
  p.category_top,
  p.category_mid,
  s.final_score,
  s.trend_score,
  s.commerce_score,
  s.supplier_score,
  s.competition_score,
  s.computed_at                          AS scored_at,
  bs.supplier_source,
  bs.price_krw                           AS supplier_price_krw,
  bs.price_original                      AS supplier_price_original,
  bs.price_currency                      AS supplier_currency,
  bs.collected_at                        AS supplier_collected_at,
  fx.cny_krw,
  fx.usd_krw,
  COALESCE(dr.duty_rate_percent, 8.0)::numeric   AS duty_rate_percent,
  COALESCE(dr.vat_rate_percent, 10.0)::numeric   AS vat_rate_percent,
  -- 대표 택배비(국제 특송 1kg 가정) — shipping_rates 평균. 없으면 8000.
  COALESCE(
    (
      SELECT AVG(price_krw)::numeric
      FROM shipping_rates
      WHERE country IN ('CN', 'china', 'CHINA', 'CN-EX')
        AND weight_min <= 1 AND weight_max >= 1
        AND price_krw IS NOT NULL
    ),
    8000.0
  )                                       AS shipping_krw,
  -- 부대비(국내 발송·포장·결제수수료) — 휴리스틱
  1500.0::numeric                         AS handling_krw,
  -- 권장 판매가 추정: supplier_price_krw * 2.2 (위탁 평균 마크업)
  (COALESCE(bs.price_krw, 0) * 2.2)::numeric AS selling_price_krw_est
FROM jimscanner_trends_products p
LEFT JOIN latest_scores s   ON s.product_id = p.id
LEFT JOIN best_supplier bs  ON bs.product_id = p.id
LEFT JOIN duty_map dm       ON dm.category_top = p.category_top
LEFT JOIN jimscanner_duty_rates dr ON dr.category_tag = dm.category_tag
CROSS JOIN fx;

COMMENT ON VIEW jimscanner_pin_stress_inputs IS
  '핀별 마진 스트레스 테스트의 입력 뷰. 환율/관세/도매가/택배비 4개 외생인자를 ±% 흔들어 마진 민감도를 산출.';

-- 권한: anon/authenticated 차단, service-role 만 접근 (RLS 는 base 테이블이 보호).
REVOKE ALL ON jimscanner_pin_stress_inputs FROM anon, authenticated;
