-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 핀 부패 워치독 (Pin Decay / Health)
-- ─────────────────────────────────────────────────────────────
-- 목적: pinned=true 인 jimscanner_trends_keywords 행에 대해
--       최근 N일 동안의 점수 기울기(slope), competition 증가량,
--       supplier 단가 분위수 이동 등을 묶어 'pin_health_score' 산출.
--
-- 의존: jimscanner_trends_keywords, jimscanner_trends_products,
--       jimscanner_trends_aliases, jimscanner_trends_scores,
--       jimscanner_trends_supplier
--
-- 적용 정책: D5 운영자 전용 (service-role 만), RLS enable + policy 없음.
-- ─────────────────────────────────────────────────────────────


-- 1) 일 1회 스냅샷 적재 — 시계열 확보
CREATE TABLE IF NOT EXISTS jimscanner_pin_health_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Seoul')::date,

  -- 핀 식별 (keyword 단위 — products 도 alias 매칭 시 products.id 채움)
  keyword text NOT NULL,
  source  text NOT NULL,
  product_id uuid REFERENCES jimscanner_trends_products(id) ON DELETE SET NULL,

  -- 점수 스냅샷
  final_score numeric,
  trend_score numeric,
  commerce_score numeric,
  competition_score numeric,
  supplier_score numeric,

  -- 변동 메트릭 (RPC 계산값 캐시)
  final_slope_14d numeric,
  final_slope_30d numeric,
  competition_delta_14d numeric,
  supply_price_delta_pct_14d numeric,
  serp_supply_count int,            -- 동일 키워드 노출 supplier row 수 (SERP 포화 프록시)

  -- 합성 부패도 (0~100, 낮을수록 살아있음 / 높을수록 부패)
  pin_health_score numeric,

  -- 4사분면 라벨: alive | slowing | saturated | dead
  pin_quadrant text,

  last_pinned_at timestamptz,

  computed_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (snapshot_date, keyword, source)
);

CREATE INDEX IF NOT EXISTS jimscanner_pin_health_snapshots_date
  ON jimscanner_pin_health_snapshots(snapshot_date DESC);
CREATE INDEX IF NOT EXISTS jimscanner_pin_health_snapshots_keyword
  ON jimscanner_pin_health_snapshots(keyword, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS jimscanner_pin_health_snapshots_quadrant
  ON jimscanner_pin_health_snapshots(pin_quadrant, snapshot_date DESC);

ALTER TABLE jimscanner_pin_health_snapshots ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.


-- 2) RPC — jimscanner_pin_decay(days_window)
--   pinned=true 핀별로 최근 N일 slope/Δ를 한 행으로 반환.
--   계산은 Postgres 안에서 끝내서 UI 는 stateless 로 사용.
DROP FUNCTION IF EXISTS jimscanner_pin_decay(int);
CREATE OR REPLACE FUNCTION jimscanner_pin_decay(days_window int DEFAULT 14)
RETURNS TABLE (
  keyword text,
  source text,
  product_id uuid,
  category_top text,
  last_pinned_at timestamptz,

  final_score_latest numeric,
  trend_score_latest numeric,
  commerce_score_latest numeric,
  competition_score_latest numeric,
  supplier_score_latest numeric,

  final_slope_window numeric,
  final_slope_30d numeric,
  competition_delta_window numeric,
  supply_price_delta_pct_window numeric,
  serp_supply_count int,

  pin_health_score numeric,
  pin_quadrant text,

  note text
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  win_days int := COALESCE(days_window, 14);
BEGIN
  RETURN QUERY
  WITH pins AS (
    -- pinned=true 인 keyword 행 가장 최근 행만
    SELECT DISTINCT ON (k.keyword, k.source)
      k.keyword,
      k.source,
      k.collected_at AS last_pinned_at,
      k.classified_category
    FROM jimscanner_trends_keywords k
    WHERE k.pinned = true
    ORDER BY k.keyword, k.source, k.collected_at DESC
  ),
  -- alias 매칭으로 product_id 추적
  pin_products AS (
    SELECT
      p.keyword,
      p.source,
      p.last_pinned_at,
      p.classified_category,
      (
        SELECT a.product_id
        FROM jimscanner_trends_aliases a
        WHERE a.alias = p.keyword
        ORDER BY a.confidence DESC NULLS LAST, a.created_at DESC
        LIMIT 1
      ) AS product_id
    FROM pins p
  ),
  latest_scores AS (
    SELECT DISTINCT ON (s.product_id)
      s.product_id,
      s.final_score,
      s.trend_score,
      s.commerce_score,
      s.competition_score,
      s.supplier_score,
      s.computed_at
    FROM jimscanner_trends_scores s
    ORDER BY s.product_id, s.computed_at DESC
  ),
  window_scores AS (
    SELECT
      s.product_id,
      regr_slope(s.final_score, EXTRACT(EPOCH FROM s.computed_at)/86400.0) AS final_slope_window,
      MAX(s.competition_score) - MIN(s.competition_score) AS competition_delta_window
    FROM jimscanner_trends_scores s
    WHERE s.computed_at >= now() - (win_days || ' days')::interval
    GROUP BY s.product_id
  ),
  thirty_scores AS (
    SELECT
      s.product_id,
      regr_slope(s.final_score, EXTRACT(EPOCH FROM s.computed_at)/86400.0) AS final_slope_30d
    FROM jimscanner_trends_scores s
    WHERE s.computed_at >= now() - INTERVAL '30 days'
    GROUP BY s.product_id
  ),
  supply_now AS (
    SELECT
      s.product_id,
      AVG(s.price_krw) AS avg_price_now,
      COUNT(*)::int    AS supply_count_now
    FROM jimscanner_trends_supplier s
    WHERE s.collected_at >= now() - INTERVAL '3 days'
    GROUP BY s.product_id
  ),
  supply_past AS (
    SELECT
      s.product_id,
      AVG(s.price_krw) AS avg_price_past
    FROM jimscanner_trends_supplier s
    WHERE s.collected_at >= now() - (win_days + 3 || ' days')::interval
      AND s.collected_at <  now() - (win_days     || ' days')::interval
    GROUP BY s.product_id
  ),
  cat AS (
    SELECT pr.id AS product_id, pr.category_top
    FROM jimscanner_trends_products pr
  )
  SELECT
    pp.keyword,
    pp.source,
    pp.product_id,
    c.category_top,
    pp.last_pinned_at,

    ls.final_score        AS final_score_latest,
    ls.trend_score        AS trend_score_latest,
    ls.commerce_score     AS commerce_score_latest,
    ls.competition_score  AS competition_score_latest,
    ls.supplier_score     AS supplier_score_latest,

    ws.final_slope_window,
    ts.final_slope_30d,
    ws.competition_delta_window,
    CASE
      WHEN sp.avg_price_past IS NULL OR sp.avg_price_past = 0 THEN NULL
      ELSE ((sn.avg_price_now - sp.avg_price_past) / sp.avg_price_past) * 100.0
    END AS supply_price_delta_pct_window,
    COALESCE(sn.supply_count_now, 0) AS serp_supply_count,

    -- pin_health_score = 0(살아있음)~100(부패)
    -- 가중치: final 하락(40) + competition 증가(25) + supplier 포화(20) + 가격 붕괴(15)
    GREATEST(0, LEAST(100,
      CASE
        WHEN ws.final_slope_window IS NOT NULL AND ws.final_slope_window < 0
          THEN LEAST(40, ABS(ws.final_slope_window) * 12)
        ELSE 0
      END
      + CASE
          WHEN ws.competition_delta_window IS NOT NULL AND ws.competition_delta_window > 0
            THEN LEAST(25, ws.competition_delta_window * 1.2)
          ELSE 0
        END
      + CASE
          WHEN COALESCE(sn.supply_count_now, 0) > 12
            THEN LEAST(20, (sn.supply_count_now - 12) * 1.5)
          ELSE 0
        END
      + CASE
          WHEN sp.avg_price_past IS NOT NULL AND sn.avg_price_now IS NOT NULL
               AND sp.avg_price_past > 0
               AND ((sn.avg_price_now - sp.avg_price_past) / sp.avg_price_past) < -0.10
            THEN LEAST(15, ABS((sn.avg_price_now - sp.avg_price_past) / sp.avg_price_past) * 60)
          ELSE 0
        END
    )) AS pin_health_score,

    -- 4사분면: x=trend (살아있는 정도), y=competition (포화 정도)
    CASE
      WHEN ls.final_score IS NULL THEN 'unknown'
      WHEN COALESCE(ws.final_slope_window,0) >= 0 AND COALESCE(ls.competition_score,0) < 60 THEN 'alive'
      WHEN COALESCE(ws.final_slope_window,0) <  0 AND COALESCE(ls.competition_score,0) < 60 THEN 'slowing'
      WHEN COALESCE(ws.final_slope_window,0) >= 0 AND COALESCE(ls.competition_score,0) >= 60 THEN 'saturated'
      ELSE 'dead'
    END AS pin_quadrant,

    pp.classified_category AS note
  FROM pin_products pp
  LEFT JOIN latest_scores ls ON ls.product_id = pp.product_id
  LEFT JOIN window_scores ws ON ws.product_id = pp.product_id
  LEFT JOIN thirty_scores ts ON ts.product_id = pp.product_id
  LEFT JOIN supply_now    sn ON sn.product_id = pp.product_id
  LEFT JOIN supply_past   sp ON sp.product_id = pp.product_id
  LEFT JOIN cat           c  ON c.product_id  = pp.product_id;
END;
$$;

-- service-role grant
GRANT EXECUTE ON FUNCTION jimscanner_pin_decay(int) TO service_role;


-- 3) 헬퍼: 스냅샷 적재 (일 1회 cron 에서 호출)
CREATE OR REPLACE FUNCTION jimscanner_snapshot_pin_health()
RETURNS int
LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
  inserted_count int := 0;
BEGIN
  INSERT INTO jimscanner_pin_health_snapshots (
    snapshot_date, keyword, source, product_id,
    final_score, trend_score, commerce_score, competition_score, supplier_score,
    final_slope_14d, final_slope_30d,
    competition_delta_14d, supply_price_delta_pct_14d,
    serp_supply_count, pin_health_score, pin_quadrant, last_pinned_at
  )
  SELECT
    (now() AT TIME ZONE 'Asia/Seoul')::date,
    d.keyword, d.source, d.product_id,
    d.final_score_latest, d.trend_score_latest, d.commerce_score_latest,
    d.competition_score_latest, d.supplier_score_latest,
    d.final_slope_window, d.final_slope_30d,
    d.competition_delta_window, d.supply_price_delta_pct_window,
    d.serp_supply_count, d.pin_health_score, d.pin_quadrant, d.last_pinned_at
  FROM jimscanner_pin_decay(14) d
  ON CONFLICT (snapshot_date, keyword, source) DO UPDATE
    SET final_score = EXCLUDED.final_score,
        trend_score = EXCLUDED.trend_score,
        commerce_score = EXCLUDED.commerce_score,
        competition_score = EXCLUDED.competition_score,
        supplier_score = EXCLUDED.supplier_score,
        final_slope_14d = EXCLUDED.final_slope_14d,
        final_slope_30d = EXCLUDED.final_slope_30d,
        competition_delta_14d = EXCLUDED.competition_delta_14d,
        supply_price_delta_pct_14d = EXCLUDED.supply_price_delta_pct_14d,
        serp_supply_count = EXCLUDED.serp_supply_count,
        pin_health_score = EXCLUDED.pin_health_score,
        pin_quadrant = EXCLUDED.pin_quadrant,
        last_pinned_at = EXCLUDED.last_pinned_at,
        computed_at = now();

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

GRANT EXECUTE ON FUNCTION jimscanner_snapshot_pin_health() TO service_role;
