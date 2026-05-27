-- ────────────────────────────────────────────────────────────
-- 퀘이사존 핫딜 Reply-Velocity 보드 + ggsan fuzzy 매칭 (2026-05-28)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/community-deals
--
-- 1) jimscanner_quasar_deals 뷰: jimscanner_market_raw 의 quasarzone_sale row 를
--    metadata 키 (reply_count / posted_at / hours_since_post / sold_out 등) 와 함께
--    flat 한 컬럼으로 노출. reply_velocity 는 metadata 가 있으면 그대로,
--    없으면 (captured_at - 추정 posted_at) 으로 보정.
--
-- 2) jimscanner_quasar_ggsan_match RPC: 핫딜의 clean_title 을 ggsan 카탈로그와
--    pg_trgm similarity() 로 매칭. reply_velocity 상위 + 도매재고 보유 + 24h 신규
--    교집합 사분면 데이터.
-- ────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DROP VIEW IF EXISTS jimscanner_quasar_deals CASCADE;
CREATE VIEW jimscanner_quasar_deals AS
SELECT
  r.id,
  r.external_id                                                            AS quasar_id,
  r.source_url,
  r.title,
  COALESCE(NULLIF(r.metadata->>'clean_title', ''), r.title)                AS clean_title,
  NULLIF(r.metadata->>'site_label', '')                                    AS site_label,
  NULLIF(r.metadata->>'posted_at_raw', '')                                 AS posted_at_raw,
  CASE
    WHEN (r.metadata->>'posted_at') ~ '^\d{4}-\d{2}-\d{2}T'
      THEN (r.metadata->>'posted_at')::timestamptz
    ELSE NULL
  END                                                                      AS posted_at,
  NULLIF(r.metadata->>'reply_count', '')::int                              AS reply_count,
  COALESCE((r.metadata->>'sold_out')::boolean, false)                      AS sold_out,
  -- velocity: metadata 우선, 없으면 captured_at 기준 보정
  CASE
    WHEN (r.metadata->>'reply_velocity') ~ '^-?\d+(\.\d+)?$'
      THEN (r.metadata->>'reply_velocity')::numeric
    WHEN (r.metadata->>'reply_count') ~ '^\d+$'
     AND (r.metadata->>'posted_at') ~ '^\d{4}-\d{2}-\d{2}T'
      THEN ROUND(
        (r.metadata->>'reply_count')::numeric /
          GREATEST(0.25, EXTRACT(EPOCH FROM (now() - (r.metadata->>'posted_at')::timestamptz)) / 3600),
        3
      )
    WHEN (r.metadata->>'reply_count') ~ '^\d+$'
      THEN ROUND(
        (r.metadata->>'reply_count')::numeric /
          GREATEST(0.25, EXTRACT(EPOCH FROM (now() - r.captured_at)) / 3600),
        3
      )
    ELSE NULL
  END                                                                      AS reply_velocity,
  CASE
    WHEN (r.metadata->>'hours_since_post') ~ '^-?\d+(\.\d+)?$'
      THEN (r.metadata->>'hours_since_post')::numeric
    WHEN (r.metadata->>'posted_at') ~ '^\d{4}-\d{2}-\d{2}T'
      THEN ROUND(EXTRACT(EPOCH FROM (now() - (r.metadata->>'posted_at')::timestamptz)) / 3600, 2)
    ELSE NULL
  END                                                                      AS hours_since_post,
  r.captured_at,
  r.metadata
FROM jimscanner_market_raw r
WHERE r.source = 'quasarzone_sale';

COMMENT ON VIEW jimscanner_quasar_deals IS
  '퀘이사존 핫딜 시그널 + reply_velocity (replies/h). collect-quasarzone-sale cron 이 채운 metadata 에서 펼침.';

-- ────────────────────────────────────────────────────────────
-- RPC: quasar ↔ ggsan fuzzy 매칭
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_quasar_ggsan_match(
  days_window int DEFAULT 7,
  min_sim float DEFAULT 0.18,
  per_deal_limit int DEFAULT 3,
  result_limit int DEFAULT 300,
  min_velocity numeric DEFAULT 0
)
RETURNS TABLE (
  quasar_id text,
  deal_title text,
  deal_clean_title text,
  site_label text,
  source_url text,
  reply_count int,
  reply_velocity numeric,
  hours_since_post numeric,
  posted_at timestamptz,
  captured_at timestamptz,
  sold_out boolean,
  goods_no text,
  ggsan_title text,
  price_krw int,
  is_imminent boolean,
  cate_cd text,
  cate_label text,
  image_url text,
  detail_url text,
  sim real
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH deals AS (
    SELECT
      d.quasar_id,
      d.title          AS deal_title,
      d.clean_title    AS deal_clean_title,
      d.site_label,
      d.source_url,
      d.reply_count,
      d.reply_velocity,
      d.hours_since_post,
      d.posted_at,
      d.captured_at,
      d.sold_out
    FROM jimscanner_quasar_deals d
    WHERE d.captured_at > now() - (days_window || ' days')::interval
      AND (d.reply_velocity IS NULL OR d.reply_velocity >= min_velocity)
      AND d.clean_title IS NOT NULL
      AND length(d.clean_title) >= 2
  )
  SELECT
    deals.quasar_id,
    deals.deal_title,
    deals.deal_clean_title,
    deals.site_label,
    deals.source_url,
    deals.reply_count,
    deals.reply_velocity,
    deals.hours_since_post,
    deals.posted_at,
    deals.captured_at,
    deals.sold_out,
    g.goods_no,
    g.title         AS ggsan_title,
    g.price_krw,
    g.is_imminent,
    g.cate_cd,
    g.cate_label,
    g.image_url,
    g.detail_url,
    similarity(deals.deal_clean_title, g.title)::real AS sim
  FROM deals
  CROSS JOIN LATERAL (
    SELECT
      gp.goods_no, gp.title, gp.price_krw, gp.is_imminent,
      gp.cate_cd, gp.cate_label, gp.image_url, gp.detail_url
    FROM jimscanner_ggsan_products gp
    WHERE gp.title % deals.deal_clean_title
    ORDER BY similarity(deals.deal_clean_title, gp.title) DESC
    LIMIT per_deal_limit
  ) g
  WHERE similarity(deals.deal_clean_title, g.title) >= min_sim
  ORDER BY
    -- velocity 우선, 임박특가 가산, 그리고 sim
    COALESCE(deals.reply_velocity, 0) DESC,
    (CASE WHEN g.is_imminent THEN 1 ELSE 0 END) DESC,
    similarity(deals.deal_clean_title, g.title) DESC
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_quasar_ggsan_match(int, float, int, int, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_quasar_ggsan_match(int, float, int, int, numeric) TO service_role;

COMMENT ON FUNCTION jimscanner_quasar_ggsan_match IS
  '퀘이사존 핫딜 ↔ ggsan 위탁 카탈로그 fuzzy 매칭. /admin/trend-radar/community-deals 에서 호출.';
