-- ────────────────────────────────────────────────────────────
-- 멀티채널 가격분산(CV) 차익 보드 (2026-05-18)
-- ────────────────────────────────────────────────────────────
-- 동일·유사 SKU 의 채널별 가격 분산(CV = stddev/mean) 계산.
-- 입력 채널:
--   1) jimscanner_trends_supplier (aliex / domeggook / 1688 / temu / ...)
--   2) jimscanner_ggsan_products (ggsan 도매 — alias='sku', source='ggsan' 매핑된 항목만)
-- 출력:
--   - VIEW jimscanner_price_dispersion : (product_id, channel, price, fetched_at, normalized_unit_price)
--   - RPC  rpc_jimscanner_price_dispersion(top_n, min_cv) : 분산 큰 순으로 차익 후보
-- 사용처: /admin/trend-radar/arbitrage
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW jimscanner_price_dispersion AS
WITH latest_supplier AS (
  SELECT DISTINCT ON (product_id, supplier_source)
    product_id,
    supplier_source                                AS channel,
    price_krw::numeric                             AS price,
    collected_at                                   AS fetched_at,
    moq,
    supplier_url                                   AS url,
    url_image                                      AS image_url
  FROM jimscanner_trends_supplier
  WHERE price_krw IS NOT NULL AND price_krw > 0
  ORDER BY product_id, supplier_source, collected_at DESC
),
ggsan_linked AS (
  SELECT DISTINCT ON (a.product_id)
    a.product_id,
    'ggsan'::text                                  AS channel,
    g.price_krw::numeric                           AS price,
    g.last_seen_at                                 AS fetched_at,
    NULL::int                                      AS moq,
    g.detail_url                                   AS url,
    g.image_url                                    AS image_url
  FROM jimscanner_trends_aliases a
  JOIN jimscanner_ggsan_products g ON g.goods_no = a.alias
  WHERE a.alias_type = 'sku'
    AND a.source = 'ggsan'
    AND g.price_krw IS NOT NULL
    AND g.price_krw > 0
  ORDER BY a.product_id, g.last_seen_at DESC
)
SELECT
  product_id,
  channel,
  price,
  fetched_at,
  moq,
  url,
  image_url,
  -- MOQ 가 있으면 단가 정규화, 없으면 그대로
  CASE WHEN moq IS NOT NULL AND moq > 0 THEN (price / moq)::numeric
       ELSE price END AS normalized_unit_price
FROM latest_supplier
UNION ALL
SELECT
  product_id, channel, price, fetched_at, moq, url, image_url,
  price AS normalized_unit_price
FROM ggsan_linked;

COMMENT ON VIEW jimscanner_price_dispersion IS
  '채널별 최신 가격 분산 분석용 통합 뷰 (#11 vision twin / #12 alias 매칭 기반).';


CREATE OR REPLACE FUNCTION rpc_jimscanner_price_dispersion(
  top_n  int   DEFAULT 50,
  min_cv float DEFAULT 0.10
)
RETURNS TABLE (
  product_id      uuid,
  canonical_name  text,
  category_top    text,
  brand           text,
  channels        jsonb,        -- [{channel, price, normalized_unit_price, url, image_url, fetched_at, moq}]
  channel_count   int,
  min_price       numeric,
  max_price       numeric,
  mean_price      numeric,
  stddev_price    numeric,
  cv              numeric,      -- stddev / mean
  gap_pct         numeric,      -- (max - min) / min * 100
  est_margin_krw  numeric,      -- max * 0.88 - min - 3000 (수수료 12% + 배송 3k 가정)
  est_margin_pct  numeric,
  best_buy_channel  text,
  best_sell_channel text
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH agg AS (
    SELECT
      pd.product_id,
      COUNT(*)::int                                          AS channel_count,
      AVG(pd.normalized_unit_price)::numeric                 AS mean_price,
      STDDEV_POP(pd.normalized_unit_price)::numeric          AS stddev_price,
      MIN(pd.normalized_unit_price)::numeric                 AS min_price,
      MAX(pd.normalized_unit_price)::numeric                 AS max_price,
      (ARRAY_AGG(pd.channel ORDER BY pd.normalized_unit_price ASC))[1]
        AS best_buy_channel,
      (ARRAY_AGG(pd.channel ORDER BY pd.normalized_unit_price DESC))[1]
        AS best_sell_channel,
      jsonb_agg(
        jsonb_build_object(
          'channel',  pd.channel,
          'price',    pd.price,
          'normalized_unit_price', pd.normalized_unit_price,
          'url',      pd.url,
          'image_url', pd.image_url,
          'fetched_at', pd.fetched_at,
          'moq',      pd.moq
        )
        ORDER BY pd.normalized_unit_price ASC
      ) AS channels
    FROM jimscanner_price_dispersion pd
    GROUP BY pd.product_id
    HAVING COUNT(*) >= 2
  )
  SELECT
    a.product_id,
    p.canonical_name,
    p.category_top,
    p.brand,
    a.channels,
    a.channel_count,
    a.min_price,
    a.max_price,
    a.mean_price,
    a.stddev_price,
    CASE WHEN a.mean_price > 0
         THEN (a.stddev_price / a.mean_price)::numeric
         ELSE 0::numeric END AS cv,
    CASE WHEN a.min_price > 0
         THEN ((a.max_price - a.min_price) / a.min_price * 100)::numeric
         ELSE 0::numeric END AS gap_pct,
    GREATEST(0::numeric, (a.max_price * 0.88) - a.min_price - 3000)::numeric AS est_margin_krw,
    CASE WHEN a.min_price > 0
         THEN (GREATEST(0::numeric, (a.max_price * 0.88) - a.min_price - 3000) / a.min_price * 100)::numeric
         ELSE 0::numeric END AS est_margin_pct,
    a.best_buy_channel,
    a.best_sell_channel
  FROM agg a
  JOIN jimscanner_trends_products p ON p.id = a.product_id
  WHERE (CASE WHEN a.mean_price > 0 THEN a.stddev_price / a.mean_price ELSE 0 END) >= min_cv
  ORDER BY
    -- CV 큰 순 → 같으면 마진 큰 순
    (CASE WHEN a.mean_price > 0 THEN a.stddev_price / a.mean_price ELSE 0 END) DESC,
    GREATEST(0::numeric, (a.max_price * 0.88) - a.min_price - 3000) DESC
  LIMIT top_n;
$$;

REVOKE ALL ON FUNCTION rpc_jimscanner_price_dispersion(int, float) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpc_jimscanner_price_dispersion(int, float) TO service_role;
