-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 신규셀러 부상속도 / 카테고리 개방성 (2026-05-29)
-- ─────────────────────────────────────────────────────────────
-- 목적: 카테고리별 신규 셀러가 얼마나 빨리 TOP 노출로 올라오는지(동적 유동성)를
--       30/60/90일 윈도우로 계산하여 "Openness Index" 산출.
--       기존 #14 churn 생존(생존)·#43 아이템위너 혼잡도(정적)와 별개 축.
-- 적재: 로컬 cron (scripts/coupang-seller-rank-snapshot.mjs) 이 일일 SERP 스냅샷 적재.
-- 노출: service-role 한정.
-- ─────────────────────────────────────────────────────────────

-- 1) SERP 셀러 스냅샷 (카테고리/키워드 × 일자 × 셀러 × 순위)
CREATE TABLE IF NOT EXISTS jimscanner_serp_seller_snapshots (
  id bigserial PRIMARY KEY,

  snapshot_date date NOT NULL DEFAULT CURRENT_DATE,
  scope_kind text NOT NULL,              -- 'category' | 'keyword'
  scope_value text NOT NULL,             -- 카테고리코드(쿠팡 cate_id) 또는 키워드

  seller_id text NOT NULL,               -- 쿠팡 셀러 식별자 (vendorItemId 또는 vendor_id)
  seller_name text,

  product_id text,                       -- 대표 상품 (선택)
  product_title text,
  rank_position int NOT NULL,            -- 1..top_k
  top_k int NOT NULL DEFAULT 30,         -- 스냅샷 시점의 TOP-K

  price_krw int,
  review_count int,
  rating numeric,

  is_rocket boolean DEFAULT false,
  is_pb boolean DEFAULT false,

  raw_payload jsonb,
  collected_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (snapshot_date, scope_kind, scope_value, seller_id, rank_position)
);

CREATE INDEX IF NOT EXISTS jimscanner_serp_seller_snapshots_scope_date
  ON jimscanner_serp_seller_snapshots(scope_kind, scope_value, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS jimscanner_serp_seller_snapshots_seller_date
  ON jimscanner_serp_seller_snapshots(seller_id, snapshot_date DESC);

ALTER TABLE jimscanner_serp_seller_snapshots ENABLE ROW LEVEL SECURITY;


-- 2) 셀러 부상 트래킹 — 한 셀러의 (scope, 첫 진입일) → (TOP-10 도달일)
--    promote 미도달은 reached_at IS NULL.
CREATE TABLE IF NOT EXISTS jimscanner_serp_seller_velocity (
  id bigserial PRIMARY KEY,

  scope_kind text NOT NULL,
  scope_value text NOT NULL,
  seller_id text NOT NULL,

  first_seen_at date NOT NULL,           -- TOP-K 최초 진입일
  reached_top10_at date,                 -- TOP-10 최초 도달일 (NULL = 미도달)
  days_to_promote int,                   -- reached_top10_at - first_seen_at

  last_seen_at date NOT NULL,
  is_active boolean NOT NULL DEFAULT true,

  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (scope_kind, scope_value, seller_id, first_seen_at)
);

CREATE INDEX IF NOT EXISTS jimscanner_serp_seller_velocity_scope
  ON jimscanner_serp_seller_velocity(scope_kind, scope_value, first_seen_at DESC);

ALTER TABLE jimscanner_serp_seller_velocity ENABLE ROW LEVEL SECURITY;


-- 3) 카테고리 Openness Index — daily 재계산
--    (a) 신규 셀러 출현율  = 최근 30일 신규 진입 셀러 수 ÷ 평균 TOP-K
--    (b) 평균 days_to_promote = 최근 90일 promote 도달자의 평균 일수 (낮을수록 개방)
--    (c) TOP-K turnover ratio = 최근 30일 동안 새로 들어왔다 나간 셀러 비율
--    Openness = 0.4*newcomer_rate*100 + 0.3*(100-days_norm) + 0.3*turnover*100
CREATE TABLE IF NOT EXISTS jimscanner_category_openness (
  id bigserial PRIMARY KEY,

  computed_for date NOT NULL DEFAULT CURRENT_DATE,
  scope_kind text NOT NULL,
  scope_value text NOT NULL,

  newcomer_rate numeric NOT NULL DEFAULT 0,         -- 0..1
  avg_days_to_promote numeric,                       -- nullable
  turnover_ratio numeric NOT NULL DEFAULT 0,         -- 0..1

  openness_index numeric NOT NULL DEFAULT 0 CHECK (openness_index >= 0 AND openness_index <= 100),
  verdict text NOT NULL DEFAULT 'unknown',           -- 'blocked' | 'tight' | 'neutral' | 'open' | 'wide_open'

  -- 발행 후보 풀 사이즈 (산점도 Y축용) — recommend RPC 가 채워줘도 되고 nullable.
  candidate_sku_count int,

  components jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (computed_for, scope_kind, scope_value)
);

CREATE INDEX IF NOT EXISTS jimscanner_category_openness_recent
  ON jimscanner_category_openness(computed_for DESC, openness_index DESC);

ALTER TABLE jimscanner_category_openness ENABLE ROW LEVEL SECURITY;


-- ─────────────────────────────────────────────────────────────
-- RPC: jimscanner_compute_openness_index(date)
--   인자 날짜 기준으로 categories 전체에 대해 (a)(b)(c) 계산 후 upsert.
--   호출: 일일 cron 끝에서 1회 실행.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_compute_openness_index(p_date date DEFAULT CURRENT_DATE)
RETURNS TABLE (
  scope_kind text,
  scope_value text,
  openness_index numeric,
  verdict text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  r record;
  v_newcomer_rate numeric;
  v_avg_days numeric;
  v_turnover numeric;
  v_openness numeric;
  v_verdict text;
  v_days_norm numeric;
BEGIN
  FOR r IN
    SELECT DISTINCT s.scope_kind, s.scope_value
    FROM jimscanner_serp_seller_snapshots s
    WHERE s.snapshot_date >= p_date - INTERVAL '90 days'
  LOOP
    -- (a) newcomer rate (최근 30일 신규 진입 / 평균 top_k)
    SELECT
      COALESCE(
        (SELECT COUNT(DISTINCT v.seller_id)::numeric
           FROM jimscanner_serp_seller_velocity v
          WHERE v.scope_kind = r.scope_kind AND v.scope_value = r.scope_value
            AND v.first_seen_at BETWEEN p_date - INTERVAL '30 days' AND p_date)
        / NULLIF(
          (SELECT AVG(s.top_k)
             FROM jimscanner_serp_seller_snapshots s
            WHERE s.scope_kind = r.scope_kind AND s.scope_value = r.scope_value
              AND s.snapshot_date BETWEEN p_date - INTERVAL '30 days' AND p_date), 0),
        0)
    INTO v_newcomer_rate;
    v_newcomer_rate := LEAST(GREATEST(COALESCE(v_newcomer_rate, 0), 0), 1);

    -- (b) avg days_to_promote (최근 90일 promote 도달자)
    SELECT AVG(v.days_to_promote)::numeric
      INTO v_avg_days
      FROM jimscanner_serp_seller_velocity v
     WHERE v.scope_kind = r.scope_kind AND v.scope_value = r.scope_value
       AND v.reached_top10_at IS NOT NULL
       AND v.reached_top10_at BETWEEN p_date - INTERVAL '90 days' AND p_date;

    -- 0..90 → 100..0 정규화 (낮을수록 개방)
    v_days_norm := CASE
      WHEN v_avg_days IS NULL THEN 50
      ELSE GREATEST(0, LEAST(100, (90 - v_avg_days) * 100.0 / 90))
    END;

    -- (c) turnover ratio (최근 30일 첫 진입 + 동기간 last_seen 이후 미관측 셀러 / 평균 top_k)
    SELECT COALESCE(
      (SELECT COUNT(DISTINCT v.seller_id)::numeric
         FROM jimscanner_serp_seller_velocity v
        WHERE v.scope_kind = r.scope_kind AND v.scope_value = r.scope_value
          AND v.first_seen_at BETWEEN p_date - INTERVAL '30 days' AND p_date
          AND (v.last_seen_at < p_date - INTERVAL '3 days' OR NOT v.is_active))
      / NULLIF(
        (SELECT AVG(s.top_k)
           FROM jimscanner_serp_seller_snapshots s
          WHERE s.scope_kind = r.scope_kind AND s.scope_value = r.scope_value
            AND s.snapshot_date BETWEEN p_date - INTERVAL '30 days' AND p_date), 0),
      0)
    INTO v_turnover;
    v_turnover := LEAST(GREATEST(COALESCE(v_turnover, 0), 0), 1);

    -- 합성: 0..100
    v_openness := ROUND(
      (0.4 * v_newcomer_rate * 100
       + 0.3 * v_days_norm
       + 0.3 * v_turnover * 100)::numeric,
      2
    );

    v_verdict := CASE
      WHEN v_openness < 20 THEN 'blocked'
      WHEN v_openness < 40 THEN 'tight'
      WHEN v_openness < 60 THEN 'neutral'
      WHEN v_openness < 80 THEN 'open'
      ELSE 'wide_open'
    END;

    INSERT INTO jimscanner_category_openness (
      computed_for, scope_kind, scope_value,
      newcomer_rate, avg_days_to_promote, turnover_ratio,
      openness_index, verdict, components
    )
    VALUES (
      p_date, r.scope_kind, r.scope_value,
      v_newcomer_rate, v_avg_days, v_turnover,
      v_openness, v_verdict,
      jsonb_build_object(
        'newcomer_rate', v_newcomer_rate,
        'avg_days_to_promote', v_avg_days,
        'days_norm', v_days_norm,
        'turnover_ratio', v_turnover,
        'weights', jsonb_build_object('newcomer', 0.4, 'days', 0.3, 'turnover', 0.3)
      )
    )
    ON CONFLICT (computed_for, scope_kind, scope_value)
    DO UPDATE SET
      newcomer_rate = EXCLUDED.newcomer_rate,
      avg_days_to_promote = EXCLUDED.avg_days_to_promote,
      turnover_ratio = EXCLUDED.turnover_ratio,
      openness_index = EXCLUDED.openness_index,
      verdict = EXCLUDED.verdict,
      components = EXCLUDED.components,
      computed_at = now();

    scope_kind := r.scope_kind;
    scope_value := r.scope_value;
    openness_index := v_openness;
    verdict := v_verdict;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- ─────────────────────────────────────────────────────────────
-- RPC: jimscanner_refresh_seller_velocity()
--   스냅샷에서 velocity 표를 derive — 매일 1회 cron 끝에서 호출.
--   - 신규 첫 진입: scope×seller_id 가 velocity에 없을 때 first_seen_at = 오늘
--   - TOP-10 도달: rank_position <= 10 관측 시 reached_top10_at, days_to_promote 채움
--   - last_seen_at 갱신 + is_active 판단 (3일 이상 미관측 → false)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_refresh_seller_velocity(p_date date DEFAULT CURRENT_DATE)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_inserted int := 0;
BEGIN
  -- 1) 신규 진입 (오늘 처음 본 scope×seller)
  WITH today_sellers AS (
    SELECT DISTINCT scope_kind, scope_value, seller_id,
           MIN(rank_position) AS best_rank
      FROM jimscanner_serp_seller_snapshots
     WHERE snapshot_date = p_date
     GROUP BY scope_kind, scope_value, seller_id
  ),
  inserted AS (
    INSERT INTO jimscanner_serp_seller_velocity (
      scope_kind, scope_value, seller_id,
      first_seen_at, reached_top10_at, days_to_promote,
      last_seen_at, is_active
    )
    SELECT t.scope_kind, t.scope_value, t.seller_id,
           p_date,
           CASE WHEN t.best_rank <= 10 THEN p_date ELSE NULL END,
           CASE WHEN t.best_rank <= 10 THEN 0 ELSE NULL END,
           p_date, true
      FROM today_sellers t
      LEFT JOIN jimscanner_serp_seller_velocity v
        ON v.scope_kind = t.scope_kind
       AND v.scope_value = t.scope_value
       AND v.seller_id = t.seller_id
     WHERE v.id IS NULL
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inserted FROM inserted;

  -- 2) TOP-10 도달 update (아직 reached_top10_at NULL 인 row)
  UPDATE jimscanner_serp_seller_velocity v
     SET reached_top10_at = p_date,
         days_to_promote = (p_date - v.first_seen_at),
         updated_at = now()
    FROM (
      SELECT DISTINCT scope_kind, scope_value, seller_id
        FROM jimscanner_serp_seller_snapshots
       WHERE snapshot_date = p_date AND rank_position <= 10
    ) hits
   WHERE v.scope_kind = hits.scope_kind
     AND v.scope_value = hits.scope_value
     AND v.seller_id = hits.seller_id
     AND v.reached_top10_at IS NULL;

  -- 3) last_seen + active flag
  UPDATE jimscanner_serp_seller_velocity v
     SET last_seen_at = p_date, is_active = true, updated_at = now()
    FROM (
      SELECT DISTINCT scope_kind, scope_value, seller_id
        FROM jimscanner_serp_seller_snapshots
       WHERE snapshot_date = p_date
    ) seen
   WHERE v.scope_kind = seen.scope_kind
     AND v.scope_value = seen.scope_value
     AND v.seller_id = seen.seller_id;

  UPDATE jimscanner_serp_seller_velocity
     SET is_active = false, updated_at = now()
   WHERE is_active = true
     AND last_seen_at < p_date - INTERVAL '3 days';

  RETURN v_inserted;
END;
$$;
