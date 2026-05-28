-- ────────────────────────────────────────────────────────────
-- 쿠팡 로켓배송 점유율 게이트 (Rocket Saturation Filter)
-- ────────────────────────────────────────────────────────────
-- SERP 1페이지(상위 36개) 샘플링 → 로켓·로켓프레시·로켓직구·PB 비율 집계.
-- 위탁 셀러는 로켓 직영 카탈로그와 경합 불가하므로 진입 전 필수 게이트.
-- 점유율 색띠: <40% 그린(진입가능존) · 40-70% 옐로우(경합존) · >70% 레드(위험존)
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_rocket_saturation (
  id bigserial PRIMARY KEY,
  category text,                                    -- ggsan cate_label 또는 자유 분류
  keyword text NOT NULL,                            -- 검색 쿼리
  rocket_share numeric(5,4) NOT NULL DEFAULT 0,     -- 로켓배송 전체 비율 (0.0~1.0)
  rocket_fresh_share numeric(5,4) NOT NULL DEFAULT 0, -- 로켓프레시 비율
  jet_share numeric(5,4) NOT NULL DEFAULT 0,        -- 로켓직구 비율
  pb_in_rocket_share numeric(5,4) NOT NULL DEFAULT 0, -- 로켓 중 쿠팡 PB(곰곰/탐사 등) 비율
  total_listings integer NOT NULL DEFAULT 0,        -- 샘플 SERP 슬롯 수 (보통 36)
  rocket_count integer NOT NULL DEFAULT 0,
  rocket_fresh_count integer NOT NULL DEFAULT 0,
  jet_count integer NOT NULL DEFAULT 0,
  pb_count integer NOT NULL DEFAULT 0,
  zone text GENERATED ALWAYS AS (
    CASE
      WHEN rocket_share < 0.40 THEN 'green'
      WHEN rocket_share < 0.70 THEN 'yellow'
      ELSE 'red'
    END
  ) STORED,
  sampled_at timestamptz NOT NULL DEFAULT now(),
  raw_payload jsonb,                                -- 디버그용 (SERP 항목 sample)
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_rocket_saturation_keyword
  ON jimscanner_rocket_saturation (keyword, sampled_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_rocket_saturation_category
  ON jimscanner_rocket_saturation (category, sampled_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_rocket_saturation_zone
  ON jimscanner_rocket_saturation (zone, sampled_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_rocket_saturation_sampled_at
  ON jimscanner_rocket_saturation (sampled_at DESC);

ALTER TABLE jimscanner_rocket_saturation ENABLE ROW LEVEL SECURITY;
-- admin (service_role) 전용. 공개 SELECT 정책 없음.

-- 최신 keyword 별 가장 최근 sample 만 (대시보드 보드용)
CREATE OR REPLACE VIEW jimscanner_rocket_saturation_latest AS
SELECT DISTINCT ON (keyword)
  id, category, keyword, rocket_share, rocket_fresh_share, jet_share,
  pb_in_rocket_share, total_listings, rocket_count, rocket_fresh_count,
  jet_count, pb_count, zone, sampled_at
FROM jimscanner_rocket_saturation
ORDER BY keyword, sampled_at DESC;

-- 주간 델타 (직전 7일 대비)
CREATE OR REPLACE VIEW jimscanner_rocket_saturation_weekly_delta AS
WITH cur AS (
  SELECT DISTINCT ON (keyword) keyword, category, rocket_share, sampled_at
  FROM jimscanner_rocket_saturation
  ORDER BY keyword, sampled_at DESC
),
prev AS (
  SELECT DISTINCT ON (keyword) keyword, rocket_share AS prev_share, sampled_at AS prev_at
  FROM jimscanner_rocket_saturation
  WHERE sampled_at < now() - interval '5 days'
  ORDER BY keyword, sampled_at DESC
)
SELECT
  cur.keyword,
  cur.category,
  cur.rocket_share,
  prev.prev_share,
  (cur.rocket_share - COALESCE(prev.prev_share, cur.rocket_share)) AS delta,
  cur.sampled_at,
  prev.prev_at
FROM cur
LEFT JOIN prev ON prev.keyword = cur.keyword;
