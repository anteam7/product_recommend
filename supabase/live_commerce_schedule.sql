-- ────────────────────────────────────────────────────────────
-- 라이브커머스 편성표 + ggsan 매칭 (Live-Push Surge, 2026-05-26)
-- ────────────────────────────────────────────────────────────
-- 네이버 쇼핑라이브 · 카카오쇼핑라이브 · 쿠팡라이브 의 향후 6~48h
-- 공개 편성을 cron 으로 수집해 적재, pg_trgm 으로 ggsan 카탈로그
-- 와 fuzzy 매칭. 어드민 /trend-radar/live-push 에서 surge 윈도우
-- (편성 후 24h) 카운트다운 보드로 시각화.
-- ────────────────────────────────────────────────────────────

-- 1) 편성 테이블 (UPSERT 단위: platform + external_id)
CREATE TABLE IF NOT EXISTS jimscanner_live_commerce_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL,                    -- 'naver' | 'kakao' | 'coupang'
  external_id text NOT NULL,                 -- 플랫폼 내 라이브 ID
  product_title text NOT NULL,               -- 정규화된 상품명
  brand text,                                -- 브랜드 (제목/메타에서 추출)
  category text,                             -- 플랫폼 카테고리 (있으면)
  mc text,                                   -- 진행자/쇼호스트
  scheduled_at timestamptz NOT NULL,         -- 방송 예정 시각 (KST 표시용 timestamptz)
  ends_at timestamptz,                       -- 방송 종료 시각 (있으면)
  image_url text,
  detail_url text,
  raw_payload jsonb,                         -- 원본 페이로드 (디버그용)
  collected_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, external_id)
);

CREATE INDEX IF NOT EXISTS jimscanner_live_commerce_schedule_scheduled
  ON jimscanner_live_commerce_schedule(scheduled_at);
CREATE INDEX IF NOT EXISTS jimscanner_live_commerce_schedule_platform
  ON jimscanner_live_commerce_schedule(platform, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_live_commerce_schedule_title_trgm
  ON jimscanner_live_commerce_schedule USING gin (product_title gin_trgm_ops);

ALTER TABLE jimscanner_live_commerce_schedule ENABLE ROW LEVEL SECURITY;
-- service-role 만 (RLS 정책 미정의 → 차단 default)

CREATE OR REPLACE FUNCTION jimscanner_live_commerce_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_live_commerce_updated_at
  ON jimscanner_live_commerce_schedule;
CREATE TRIGGER jimscanner_live_commerce_updated_at
  BEFORE UPDATE ON jimscanner_live_commerce_schedule
  FOR EACH ROW EXECUTE FUNCTION jimscanner_live_commerce_set_updated_at();


-- 2) 매칭 RPC — 라이브 편성 × ggsan 도매 카탈로그
--    윈도우: 과거 24h 시작분 ~ 미래 48h 예정분 (surge 윈도우 = 방송 후 24h)
CREATE OR REPLACE FUNCTION jimscanner_live_ggsan_match(
  past_hours int DEFAULT 24,
  future_hours int DEFAULT 48,
  min_sim float DEFAULT 0.20,
  per_live_limit int DEFAULT 3,
  result_limit int DEFAULT 300
)
RETURNS TABLE (
  live_id uuid,
  platform text,
  external_id text,
  product_title text,
  brand text,
  category text,
  mc text,
  scheduled_at timestamptz,
  live_image_url text,
  live_detail_url text,
  goods_no text,
  ggsan_title text,
  price_krw int,
  is_imminent boolean,
  cate_cd text,
  cate_label text,
  image_url text,
  detail_url text,
  ggsan_last_seen timestamptz,
  sim real,
  surge_window_ends_at timestamptz,
  hours_until_live double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH live AS (
    SELECT
      l.id,
      l.platform,
      l.external_id,
      l.product_title,
      l.brand,
      l.category,
      l.mc,
      l.scheduled_at,
      l.image_url,
      l.detail_url
    FROM jimscanner_live_commerce_schedule l
    WHERE l.scheduled_at >= now() - (past_hours || ' hours')::interval
      AND l.scheduled_at <= now() + (future_hours || ' hours')::interval
  )
  SELECT
    live.id AS live_id,
    live.platform,
    live.external_id,
    live.product_title,
    live.brand,
    live.category,
    live.mc,
    live.scheduled_at,
    live.image_url AS live_image_url,
    live.detail_url AS live_detail_url,
    g.goods_no,
    g.title AS ggsan_title,
    g.price_krw,
    g.is_imminent,
    g.cate_cd,
    g.cate_label,
    g.image_url,
    g.detail_url,
    g.last_seen_at AS ggsan_last_seen,
    similarity(live.product_title, g.title)::real AS sim,
    (live.scheduled_at + interval '24 hours') AS surge_window_ends_at,
    EXTRACT(EPOCH FROM (live.scheduled_at - now())) / 3600.0 AS hours_until_live
  FROM live
  CROSS JOIN LATERAL (
    SELECT
      gp.goods_no, gp.title, gp.price_krw, gp.is_imminent,
      gp.cate_cd, gp.cate_label, gp.image_url, gp.detail_url, gp.last_seen_at
    FROM jimscanner_ggsan_products gp
    WHERE gp.title % live.product_title
    ORDER BY similarity(live.product_title, gp.title) DESC
    LIMIT per_live_limit
  ) g
  WHERE similarity(live.product_title, g.title) >= min_sim
  ORDER BY
    (CASE WHEN g.is_imminent THEN 1 ELSE 0 END) DESC,
    live.scheduled_at ASC,
    similarity(live.product_title, g.title) DESC
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_live_ggsan_match(int, int, float, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_live_ggsan_match(int, int, float, int, int) TO service_role;
