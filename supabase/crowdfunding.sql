-- ────────────────────────────────────────────────────────────
-- 와디즈·텀블벅 펀딩 성공 → 리테일 선점 보드
-- 2026-05-28 / Phase 0 / product_discovery
-- ────────────────────────────────────────────────────────────
-- 펀딩 종료된 프로젝트의 메타(카테고리·펀딩액·달성률·서포터수·종료일)를
-- 적재하고, 1억+ 또는 1000%+ 인 '검증 통과' 프로젝트의 카테고리에 대해
-- 종료 후 D+30/60/90 시점 naver_search_trend lift 분포를 학습한다.
--
-- 신호 의의:
--   - quasarzone/뉴스/TV 는 출시된 상품의 후행 신호.
--   - 펀딩은 출시 전 신호 → lead horizon 3~9개월.
--   - 펀딩 SKU 자체 카피보다 같은 카테고리 ggsan 도매 대체품 선점이 목적.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_crowdfunding_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('wadiz','tumblbug')),
  source_project_id text NOT NULL,
  title text NOT NULL,
  maker text,
  category text,                          -- 원본 카테고리 (예: 'Tech & Designer Goods')
  category_top text,                      -- 정규화 (예: 'digital'|'living'|'health'|'fashion'|'food')
  funded_amount_krw bigint NOT NULL DEFAULT 0,
  goal_amount_krw bigint,
  achievement_rate numeric,               -- percent (예: 1532.4)
  supporter_count int,
  started_at timestamptz,
  ended_at timestamptz NOT NULL,
  project_url text,
  thumbnail_url text,
  -- 검증 게이트: 펀딩액 1억+ 또는 달성률 1000%+
  is_verified boolean NOT NULL DEFAULT false,
  verified_reason text,                   -- 'amount_1e8' / 'rate_1000' / 'both'
  raw jsonb,
  collected_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jimscanner_crowdfunding_projects_uniq UNIQUE (source, source_project_id)
);

CREATE INDEX IF NOT EXISTS jimscanner_crowdfunding_projects_ended_at
  ON jimscanner_crowdfunding_projects(ended_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_crowdfunding_projects_verified_ended
  ON jimscanner_crowdfunding_projects(ended_at DESC) WHERE is_verified;
CREATE INDEX IF NOT EXISTS jimscanner_crowdfunding_projects_category
  ON jimscanner_crowdfunding_projects(category_top, ended_at DESC);

ALTER TABLE jimscanner_crowdfunding_projects ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────────────────
-- 카테고리별 retail lag distribution (자동 학습)
--   ended_at 기준 D+30/60/90 윈도우에서 naver_search_trend volume_relative 평균
--   대비 펀딩 종료 시점 직전 30일 평균의 lift 비율.
-- 학습 결과 view — 펀딩 → 검색 lift 회귀의 입력.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW jimscanner_crowdfunding_lag_lift AS
WITH verified AS (
  SELECT id, category_top, ended_at, title
  FROM jimscanner_crowdfunding_projects
  WHERE is_verified AND category_top IS NOT NULL
    AND ended_at < now() - interval '30 days'
),
windows AS (
  SELECT
    v.id,
    v.category_top,
    v.ended_at,
    w.label AS lag_bucket,
    w.lo,
    w.hi
  FROM verified v
  CROSS JOIN (VALUES
    ('d30',  interval '0 days',  interval '30 days'),
    ('d60',  interval '30 days', interval '60 days'),
    ('d90',  interval '60 days', interval '90 days')
  ) AS w(label, lo, hi)
),
baseline AS (
  -- 종료 시점 직전 30일 카테고리 평균 검색 volume
  SELECT
    v.id,
    AVG(k.volume_relative)::numeric AS base_vol
  FROM verified v
  LEFT JOIN jimscanner_trends_keywords k
    ON k.source = 'naver_search_trend'
   AND k.category_top = v.category_top
   AND k.collected_at BETWEEN v.ended_at - interval '30 days' AND v.ended_at
  GROUP BY v.id
),
post AS (
  SELECT
    w.id,
    w.category_top,
    w.lag_bucket,
    AVG(k.volume_relative)::numeric AS post_vol
  FROM windows w
  LEFT JOIN jimscanner_trends_keywords k
    ON k.source = 'naver_search_trend'
   AND k.category_top = w.category_top
   AND k.collected_at BETWEEN w.ended_at + w.lo AND w.ended_at + w.hi
  GROUP BY w.id, w.category_top, w.lag_bucket
)
SELECT
  p.category_top,
  p.lag_bucket,
  COUNT(*)::int AS n_projects,
  AVG(CASE WHEN COALESCE(b.base_vol, 0) > 0
           THEN p.post_vol / NULLIF(b.base_vol, 0)
           ELSE NULL END)::numeric AS avg_lift,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY
    CASE WHEN COALESCE(b.base_vol, 0) > 0
         THEN p.post_vol / NULLIF(b.base_vol, 0)
         ELSE NULL END
  )::numeric AS p50_lift
FROM post p
LEFT JOIN baseline b ON b.id = p.id
GROUP BY p.category_top, p.lag_bucket;

-- ────────────────────────────────────────────────────────────
-- 리테일 진입 임박 큐 (lag p50 도달 프로젝트)
--   ended_at 으로부터 카테고리별 p50 lag 가 도달한 검증 프로젝트.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW jimscanner_crowdfunding_imminent_queue AS
WITH p50_days AS (
  -- 카테고리별 p50 lag 도달 일수 (lag bucket 의 중간값 기준 정규화)
  SELECT
    category_top,
    -- p50_lift 가 가장 큰 lag_bucket 의 중앙 일수
    (CASE lag_bucket
       WHEN 'd30' THEN 15
       WHEN 'd60' THEN 45
       WHEN 'd90' THEN 75
     END)::int AS days_to_p50
  FROM (
    SELECT
      category_top, lag_bucket,
      p50_lift,
      ROW_NUMBER() OVER (PARTITION BY category_top ORDER BY p50_lift DESC NULLS LAST) AS rk
    FROM jimscanner_crowdfunding_lag_lift
    WHERE p50_lift IS NOT NULL
  ) ranked
  WHERE rk = 1
)
SELECT
  p.id,
  p.source,
  p.title,
  p.category_top,
  p.funded_amount_krw,
  p.achievement_rate,
  p.supporter_count,
  p.ended_at,
  p.project_url,
  COALESCE(d.days_to_p50, 60) AS days_to_p50_default,
  p.ended_at + (COALESCE(d.days_to_p50, 60) || ' days')::interval AS p50_eta,
  EXTRACT(DAY FROM (now() - p.ended_at))::int AS days_since_end
FROM jimscanner_crowdfunding_projects p
LEFT JOIN p50_days d ON d.category_top = p.category_top
WHERE p.is_verified
  AND p.ended_at < now()
  AND p.ended_at + (COALESCE(d.days_to_p50, 60) || ' days')::interval BETWEEN now() - interval '21 days' AND now() + interval '21 days'
ORDER BY p50_eta;
