-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 시장규모 역산 (TAM·SOM ₩/월)  2026-06-03
-- ─────────────────────────────────────────────────────────────
-- 목적: 4점수·단위순이익이 답 못 하는 '이 시장이 월 몇 원짜리이고
--       내가 얼마 먹나'를 추가 수집 없이 기존 재료로 역산.
--   재료: #3 검색량 시그널(volume_relative) · supplier.price_krw(도매가)
--         · competition_score(경쟁 혼잡) · final_score(진입 타이밍)
--   산식:
--     TAM(₩/월) = 월추정검색량 × 카테고리 base-rate 전환율 × 추정판매가
--     SOM(₩/월) = TAM ÷ (competitor_count+1) 를 경쟁혼잡·타이밍으로 보정
--     추정판매가 = (도매가 + 배송비) / (1 - 쿠팡수수료 - 목표마진)
-- 노출 정책: 기존 jimscanner_trends_* 와 동일 (RLS enable, 정책 X = service-role)
-- recompute_scores 루틴 끝단에서 jimscanner_recompute_market_size() 호출.
-- ─────────────────────────────────────────────────────────────


-- 1) derived 테이블 — 시계열 (매 재계산 시 새 row, UI 는 product_id 별 latest)
CREATE TABLE IF NOT EXISTS jimscanner_trends_market_size (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  est_monthly_searches numeric,          -- 월 추정 절대 검색량
  assumed_conversion numeric,            -- 카테고리 base-rate 전환율 (0~1)
  est_avg_price_krw numeric,             -- 추정 판매가 (도매가 + 쿠팡 마진공식)
  tam_krw numeric,                       -- = searches × conversion × price
  competitor_count int,                  -- 경쟁 셀러/등록 추정 수
  est_som_krw numeric,                   -- = TAM ÷ (competitor+1), 혼잡·타이밍 보정
  est_som_share numeric,                 -- SOM ÷ TAM (0~1) — 점유 추정율 (사분면 Y축)

  assumptions jsonb NOT NULL DEFAULT '{}'::jsonb,  -- 근거·상수·민감도 기준값

  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_market_size_product_at
  ON jimscanner_trends_market_size(product_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_market_size_tam_recent
  ON jimscanner_trends_market_size(tam_krw DESC, computed_at DESC);

ALTER TABLE jimscanner_trends_market_size ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.


-- 2) 카테고리별 base-rate 전환율 (쿠팡 건기식/식품 카테고리 norm 가정)
--    민감도 슬라이더의 기본값. 추후 실측으로 교체.
CREATE OR REPLACE FUNCTION jimscanner_market_size_conv_rate(p_category text)
RETURNS numeric AS $$
BEGIN
  RETURN CASE p_category
    WHEN 'health'  THEN 0.018   -- 건기식: 검색 → 구매 전환 보수적
    WHEN 'living'  THEN 0.025
    WHEN 'digital' THEN 0.020
    ELSE 0.020
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;


-- 3) 재계산 루틴 — recompute_scores 끝단에서 호출.
--    각 product 의 latest score + latest supplier price + category 검색 시그널을
--    한 base CTE 에 모은 뒤 단계적으로 ₩ 단위 역산.
CREATE OR REPLACE FUNCTION jimscanner_recompute_market_size()
RETURNS int AS $$
DECLARE
  v_count int := 0;
  c_ship   numeric := 3000;     -- 배송비 (coupang_pricing_model 동기화)
  c_fee    numeric := 0.106;    -- 쿠팡 수수료율 (기타영양제 기준)
  c_margin numeric := 0.20;     -- 목표 순마진 (보수적)
  c_vol_base numeric := 800;    -- volume_relative 1점 ≈ 월 800회 (절대값 연동 전 proxy)
BEGIN
  WITH base AS (
    SELECT
      p.id AS product_id,
      p.category_top,
      sc.competition_score,
      sc.final_score,
      sup.price_krw AS supplier_price,
      COALESCE(kv.vol_rel, 30) AS vol_rel
    FROM jimscanner_trends_products p
    JOIN LATERAL (
      SELECT s.competition_score, s.final_score
      FROM jimscanner_trends_scores s
      WHERE s.product_id = p.id
      ORDER BY s.computed_at DESC
      LIMIT 1
    ) sc ON true
    LEFT JOIN LATERAL (
      SELECT su.price_krw
      FROM jimscanner_trends_supplier su
      WHERE su.product_id = p.id AND su.price_krw IS NOT NULL
      ORDER BY su.collected_at DESC
      LIMIT 1
    ) sup ON true
    LEFT JOIN LATERAL (
      SELECT AVG(k.volume_relative) AS vol_rel
      FROM jimscanner_trends_keywords k
      WHERE k.category_top = p.category_top
        AND k.volume_relative IS NOT NULL
        AND k.collected_at > now() - interval '7 days'
    ) kv ON true
  ),
  derived AS (
    SELECT
      product_id,
      category_top,
      competition_score,
      final_score,
      supplier_price,
      vol_rel,
      ROUND(vol_rel * c_vol_base) AS est_searches,
      jimscanner_market_size_conv_rate(category_top) AS conv,
      CASE WHEN supplier_price IS NULL OR supplier_price <= 0 THEN NULL
           ELSE ROUND((supplier_price + c_ship) / (1 - c_fee - c_margin)) END AS sell_price,
      GREATEST(0, ROUND((100 - competition_score) / 5.0))::int AS competitors
    FROM base
  ),
  computed AS (
    SELECT
      *,
      ROUND(est_searches * conv * COALESCE(sell_price, 0)) AS tam
    FROM derived
  )
  INSERT INTO jimscanner_trends_market_size (
    product_id, est_monthly_searches, assumed_conversion, est_avg_price_krw,
    tam_krw, competitor_count, est_som_krw, est_som_share, assumptions
  )
  SELECT
    c.product_id,
    c.est_searches,
    c.conv,
    c.sell_price,
    c.tam,
    c.competitors,
    -- SOM = TAM ÷ (competitor+1) × 진입타이밍(final_score) 보정 0.5~1.0
    ROUND((c.tam / (c.competitors + 1)) * (0.5 + c.final_score / 200.0)) AS som,
    CASE WHEN c.tam > 0
      THEN LEAST(1.0, ((c.tam / (c.competitors + 1)) * (0.5 + c.final_score / 200.0)) / c.tam)
      ELSE 0 END AS som_share,
    jsonb_build_object(
      'volume_relative', c.vol_rel,
      'vol_base_per_point', c_vol_base,
      'conversion_base_rate', c.conv,
      'supplier_price_krw', c.supplier_price,
      'ship', c_ship, 'fee', c_fee, 'target_margin', c_margin,
      'competition_score', c.competition_score,
      'final_score', c.final_score,
      'note', '검색 절대량은 category volume_relative proxy. 키워드도구 절대값 연동 시 교체.'
    )
  FROM computed c;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;


-- 4) 최초 백필 (적용 시 1회 실행)
SELECT jimscanner_recompute_market_size();
