-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v5 — 셀러 Churn 생존곡선 (카테고리 진입 함정 게이트)
-- ─────────────────────────────────────────────────────────────
-- 목적: 쿠팡 SERP 상위 N개 셀러 ID를 카테고리·키워드별로 매주 스냅샷 저장하고,
--       4·8·12주 후 동일 셀러 잔존율 (KM 생존곡선 근사) 을 카테고리별로 산출.
--       SERP 상에서 활기차 보이지만 실제로는 신규 셀러가 빠르게 죽어나가는
--       '진입 함정' 카테고리 (다이어트보조·휴대폰 액세서리 등) 를 사전 식별.
-- D5: 운영자 전용 (어드민 한정)
-- D7: 수집은 로컬 cron, 적재는 service-role, UI 는 어드민 read-only
-- ─────────────────────────────────────────────────────────────

-- 1) SERP 셀러 스냅샷 테이블
CREATE TABLE IF NOT EXISTS jimscanner_serp_seller_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword text NOT NULL,                  -- 검색 키워드
  category_top text,                      -- 카테고리 (health/living/digital 등)
  seller_id text NOT NULL,                -- 쿠팡 셀러 식별자 (vendorItemId 또는 store URL slug)
  seller_name text,                       -- 셀러명 (있으면)
  rank int NOT NULL,                      -- SERP 자연 검색 순위 (1~N)
  listing_url text,                       -- 상품 URL (참조용)
  captured_at timestamptz NOT NULL DEFAULT now(),
  -- 같은 주차의 동일 (keyword, seller_id, rank) 중복 방지
  UNIQUE (keyword, seller_id, rank, captured_at)
);

CREATE INDEX IF NOT EXISTS jimscanner_serp_seller_snapshots_kw_at
  ON jimscanner_serp_seller_snapshots(keyword, captured_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_serp_seller_snapshots_cat_at
  ON jimscanner_serp_seller_snapshots(category_top, captured_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_serp_seller_snapshots_seller_at
  ON jimscanner_serp_seller_snapshots(seller_id, captured_at DESC);

ALTER TABLE jimscanner_serp_seller_snapshots ENABLE ROW LEVEL SECURITY;
-- service-role 만 접근.


-- 2) 카테고리별 셀러 생존곡선 RPC
-- 입력: weeks_window (기본 12주). 분석 시점 기준 N주 전 코호트의 셀러들을
--       이후 1~N주차에 동일 카테고리 SERP 에서 다시 만났는지 비율 산출.
-- 출력: category_top, week_offset (1..N), cohort_size, surviving, survival_rate
CREATE OR REPLACE FUNCTION jimscanner_seller_churn_rpc(
  weeks_window int DEFAULT 12
)
RETURNS TABLE (
  category_top text,
  week_offset int,
  cohort_size int,
  surviving int,
  survival_rate numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH cohort AS (
    -- 카테고리별 cohort: 분석 시점에서 weeks_window 주 전 ± 3.5일 윈도우에 등장한 셀러 집합
    SELECT DISTINCT
      s.category_top,
      s.seller_id
    FROM jimscanner_serp_seller_snapshots s
    WHERE s.category_top IS NOT NULL
      AND s.captured_at BETWEEN
        now() - ((weeks_window * 7 + 3) || ' days')::interval
        AND now() - ((weeks_window * 7 - 3) || ' days')::interval
  ),
  weeks AS (
    SELECT generate_series(1, weeks_window) AS week_offset
  ),
  per_week AS (
    SELECT
      c.category_top,
      w.week_offset,
      COUNT(DISTINCT c.seller_id)::int AS cohort_size,
      COUNT(DISTINCT CASE
        WHEN EXISTS (
          SELECT 1 FROM jimscanner_serp_seller_snapshots later
          WHERE later.seller_id = c.seller_id
            AND later.category_top = c.category_top
            AND later.captured_at BETWEEN
              now() - (((weeks_window - w.week_offset) * 7 + 3) || ' days')::interval
              AND now() - (((weeks_window - w.week_offset) * 7 - 3) || ' days')::interval
        ) THEN c.seller_id END
      )::int AS surviving
    FROM cohort c
    CROSS JOIN weeks w
    GROUP BY c.category_top, w.week_offset
  )
  SELECT
    category_top,
    week_offset,
    cohort_size,
    surviving,
    CASE WHEN cohort_size > 0
      THEN ROUND((surviving::numeric / cohort_size::numeric) * 100, 2)
      ELSE NULL
    END AS survival_rate
  FROM per_week
  ORDER BY category_top, week_offset;
$$;

REVOKE ALL ON FUNCTION jimscanner_seller_churn_rpc(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_seller_churn_rpc(int) TO service_role;


-- 3) 특정 카테고리의 90일 생존율 단일값 RPC (배지용)
-- ~13주차 ≈ 90일 시점의 생존율. cohort 가 없거나 표본 부족이면 NULL.
CREATE OR REPLACE FUNCTION jimscanner_seller_churn_90d(
  p_category_top text
)
RETURNS TABLE (
  cohort_size int,
  surviving int,
  survival_rate numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH cohort AS (
    SELECT DISTINCT s.seller_id
    FROM jimscanner_serp_seller_snapshots s
    WHERE s.category_top = p_category_top
      AND s.captured_at BETWEEN
        now() - '93 days'::interval
        AND now() - '87 days'::interval
  ),
  surviving_set AS (
    SELECT DISTINCT c.seller_id
    FROM cohort c
    WHERE EXISTS (
      SELECT 1 FROM jimscanner_serp_seller_snapshots later
      WHERE later.seller_id = c.seller_id
        AND later.category_top = p_category_top
        AND later.captured_at >= now() - '10 days'::interval
    )
  )
  SELECT
    (SELECT COUNT(*)::int FROM cohort) AS cohort_size,
    (SELECT COUNT(*)::int FROM surviving_set) AS surviving,
    CASE WHEN (SELECT COUNT(*) FROM cohort) > 0
      THEN ROUND(
        ((SELECT COUNT(*) FROM surviving_set)::numeric
          / (SELECT COUNT(*) FROM cohort)::numeric) * 100, 2)
      ELSE NULL
    END AS survival_rate;
$$;

REVOKE ALL ON FUNCTION jimscanner_seller_churn_90d(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_seller_churn_90d(text) TO service_role;
