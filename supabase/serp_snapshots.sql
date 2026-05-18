-- jimscanner_serp_snapshots — 카테고리별 SERP 상위 50 주간 스냅샷.
-- 신규 진입자 생존율(Penetration Index) 분석용.
-- 매주 1회 수집 (KST 18:00, recompute_scores 직후).
-- 4주 전 신규 진입한 SKU(이전 8주 미존재)가 현재 상위 50 에 잔존하는 비율 산출.

CREATE TABLE IF NOT EXISTS jimscanner_serp_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,                 -- 'health' / 'living' / 'digital' / ...
  week date NOT NULL,                     -- 해당 주 월요일 (KST)
  rank int NOT NULL,                      -- 1~50
  product_id text NOT NULL,               -- naver shopping productId (SKU)
  seller text,                            -- 판매자(쇼핑몰) 이름
  reviews int,                            -- 누적 리뷰 수 (없으면 NULL)
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category, week, rank)
);

CREATE INDEX IF NOT EXISTS jimscanner_serp_snapshots_cat_week
  ON jimscanner_serp_snapshots(category, week DESC);

CREATE INDEX IF NOT EXISTS jimscanner_serp_snapshots_product
  ON jimscanner_serp_snapshots(product_id, week);

ALTER TABLE jimscanner_serp_snapshots ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.

-- Penetration Index 계산 RPC.
-- 4주 전 신규 진입(이전 8주 미존재) SKU 의 현재 잔존율을 카테고리별로 산출.
CREATE OR REPLACE FUNCTION jimscanner_serp_penetration_index(weeks_window int DEFAULT 12)
RETURNS TABLE (
  category text,
  current_week date,
  cohort_week date,
  new_entries int,
  survived int,
  survival_pct numeric,
  avg_settled_rank numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH params AS (
    SELECT
      (SELECT MAX(week) FROM jimscanner_serp_snapshots) AS cur_week
  ),
  cohort AS (
    -- 4주 전 (current - 28일) 에 처음 등장한 SKU
    SELECT s.category, s.product_id, MIN(s.rank) AS entry_rank
    FROM jimscanner_serp_snapshots s, params p
    WHERE s.week = p.cur_week - INTERVAL '4 weeks'
      AND NOT EXISTS (
        SELECT 1 FROM jimscanner_serp_snapshots s2
        WHERE s2.product_id = s.product_id
          AND s2.category = s.category
          AND s2.week >= p.cur_week - INTERVAL '12 weeks'
          AND s2.week <  p.cur_week - INTERVAL '4 weeks'
      )
    GROUP BY s.category, s.product_id
  ),
  survived AS (
    SELECT c.category, c.product_id, s.rank AS settled_rank
    FROM cohort c
    JOIN jimscanner_serp_snapshots s
      ON s.product_id = c.product_id AND s.category = c.category
    JOIN params p ON s.week = p.cur_week
  )
  SELECT
    c.category,
    p.cur_week AS current_week,
    (p.cur_week - INTERVAL '4 weeks')::date AS cohort_week,
    COUNT(c.product_id)::int AS new_entries,
    COUNT(s.product_id)::int AS survived,
    CASE WHEN COUNT(c.product_id) = 0 THEN 0
         ELSE ROUND(100.0 * COUNT(s.product_id) / COUNT(c.product_id), 1) END AS survival_pct,
    COALESCE(ROUND(AVG(s.settled_rank)::numeric, 1), NULL) AS avg_settled_rank
  FROM cohort c
  LEFT JOIN survived s
    ON s.category = c.category AND s.product_id = c.product_id
  CROSS JOIN params p
  GROUP BY c.category, p.cur_week
  ORDER BY survival_pct DESC NULLS LAST;
$$;
