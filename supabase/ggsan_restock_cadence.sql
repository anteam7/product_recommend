-- ────────────────────────────────────────────────────────────
-- ggsan 재입고 사이클(Restock Cadence) 핫템 보드
-- 2026-05-18 — `jimscanner_ggsan_price_history.status` 시계열에서
--   'sold_out/removed → active' 전이를 SKU별로 집계.
--   도매 회전(=재입고 빈도) 실측이 트렌드 점수의 leak signal.
-- ────────────────────────────────────────────────────────────

-- 1) 재입고 사이클 집계 뷰
DROP VIEW IF EXISTS jimscanner_ggsan_restock_cadence CASCADE;
CREATE OR REPLACE VIEW jimscanner_ggsan_restock_cadence AS
WITH ordered AS (
  SELECT
    goods_no,
    observed_at,
    status,
    price_krw,
    LAG(status)      OVER (PARTITION BY goods_no ORDER BY observed_at) AS prev_status,
    LAG(observed_at) OVER (PARTITION BY goods_no ORDER BY observed_at) AS prev_at
  FROM jimscanner_ggsan_price_history
  WHERE observed_at > now() - interval '90 days'
),
-- active → sold_out/removed 시점 (OOS 시작)
oos_start AS (
  SELECT goods_no, observed_at AS oos_at
  FROM ordered
  WHERE prev_status = 'active'
    AND status IN ('sold_out', 'removed')
),
-- sold_out/removed → active 시점 (재입고)
restocks AS (
  SELECT
    goods_no,
    observed_at AS restock_at
  FROM ordered
  WHERE prev_status IN ('sold_out', 'removed')
    AND status = 'active'
),
-- 각 재입고에 대응하는 직전 OOS 시작점 매칭
restock_with_oos AS (
  SELECT
    r.goods_no,
    r.restock_at,
    (
      SELECT MAX(o.oos_at)
      FROM oos_start o
      WHERE o.goods_no = r.goods_no
        AND o.oos_at <= r.restock_at
    ) AS oos_at
  FROM restocks r
),
-- 30일 집계
agg_30d AS (
  SELECT
    goods_no,
    COUNT(*)::int AS restock_count_30d,
    AVG(CASE WHEN oos_at IS NOT NULL
        THEN EXTRACT(EPOCH FROM (restock_at - oos_at)) / 86400.0
        ELSE NULL END)::real AS mean_oos_days,
    MAX(restock_at) AS last_restock_at
  FROM restock_with_oos
  WHERE restock_at > now() - interval '30 days'
  GROUP BY goods_no
),
-- 재입고 간 간격 (CV 계산용, 90일 윈도우)
intervals AS (
  SELECT
    goods_no,
    EXTRACT(EPOCH FROM (
      restock_at - LAG(restock_at) OVER (PARTITION BY goods_no ORDER BY restock_at)
    )) / 86400.0 AS interval_days
  FROM restocks
),
interval_stats AS (
  SELECT
    goods_no,
    AVG(interval_days)::real AS mean_interval_days,
    CASE
      WHEN AVG(interval_days) > 0
        THEN (STDDEV_SAMP(interval_days) / NULLIF(AVG(interval_days), 0))::real
      ELSE NULL
    END AS restock_cv
  FROM intervals
  WHERE interval_days IS NOT NULL
  GROUP BY goods_no
),
-- 30일 가격 변동 폭
price_stats AS (
  SELECT
    goods_no,
    MIN(price_krw) FILTER (WHERE price_krw IS NOT NULL)::int AS min_price_30d,
    MAX(price_krw) FILTER (WHERE price_krw IS NOT NULL)::int AS max_price_30d,
    COUNT(*) FILTER (WHERE price_krw IS NOT NULL)::int AS price_obs_30d
  FROM jimscanner_ggsan_price_history
  WHERE observed_at > now() - interval '30 days'
  GROUP BY goods_no
)
SELECT
  p.goods_no,
  p.title,
  p.cate_cd,
  p.cate_label,
  p.price_krw,
  p.image_url,
  p.detail_url,
  p.status         AS current_status,
  p.is_imminent,
  p.last_seen_at,
  COALESCE(a.restock_count_30d, 0)  AS restock_count_30d,
  a.mean_oos_days,
  a.last_restock_at,
  i.mean_interval_days,
  i.restock_cv,
  ps.min_price_30d,
  ps.max_price_30d,
  ps.price_obs_30d,
  -- 재입고 속도: 짧은 OOS + 잦은 재입고일수록 높음
  -- restock_velocity = restock_count_30d / (1 + mean_oos_days)
  (COALESCE(a.restock_count_30d, 0)::real /
    GREATEST(1.0, 1.0 + COALESCE(a.mean_oos_days, 30.0)))::real AS restock_velocity
FROM jimscanner_ggsan_products p
LEFT JOIN agg_30d        a  ON a.goods_no  = p.goods_no
LEFT JOIN interval_stats i  ON i.goods_no  = p.goods_no
LEFT JOIN price_stats    ps ON ps.goods_no = p.goods_no
WHERE COALESCE(a.restock_count_30d, 0) > 0;

COMMENT ON VIEW jimscanner_ggsan_restock_cadence IS
  '도매 재입고 사이클 집계 (30일). 잦은 재입고 + 짧은 OOS = 진성 회전 hot SKU. /admin/trend-radar/restock 에서 사용.';

REVOKE ALL ON jimscanner_ggsan_restock_cadence FROM PUBLIC;
GRANT SELECT ON jimscanner_ggsan_restock_cadence TO service_role;


-- 2) status 타임라인 sparkline 데이터 RPC
--    상품 ID 배열 → 각 상품별 최근 30일 status 이벤트 시계열
DROP FUNCTION IF EXISTS jimscanner_ggsan_status_timeline(text[]);
CREATE OR REPLACE FUNCTION jimscanner_ggsan_status_timeline(
  goods_nos text[]
)
RETURNS TABLE (
  goods_no text,
  events jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    h.goods_no,
    jsonb_agg(
      jsonb_build_object(
        'at', h.observed_at,
        's',  h.status,
        'p',  h.price_krw
      )
      ORDER BY h.observed_at
    ) AS events
  FROM jimscanner_ggsan_price_history h
  WHERE h.goods_no = ANY(goods_nos)
    AND h.observed_at > now() - interval '30 days'
  GROUP BY h.goods_no
$$;

REVOKE ALL ON FUNCTION jimscanner_ggsan_status_timeline(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_ggsan_status_timeline(text[]) TO service_role;


-- 3) ggsan_recommend RPC 확장 — restock_velocity 가산항 옵션 노출
--    기존 시그니처에 `restock_weight float DEFAULT 0` 추가.
--    0 이면 기존과 동일 (백워드 호환).
DROP FUNCTION IF EXISTS jimscanner_ggsan_recommend(int, float, float, int);
DROP FUNCTION IF EXISTS jimscanner_ggsan_recommend(int, float, float, int, float);

CREATE OR REPLACE FUNCTION jimscanner_ggsan_recommend(
  days_window int DEFAULT 30,
  min_sim float DEFAULT 0.20,
  min_score float DEFAULT 0.5,
  result_limit int DEFAULT 100,
  restock_weight float DEFAULT 0
)
RETURNS TABLE (
  goods_no text,
  title text,
  cate_cd text,
  cate_label text,
  price_krw int,
  is_imminent boolean,
  image_url text,
  detail_url text,
  ggsan_last_seen timestamptz,
  tv_score real,
  search_score real,
  raw_score real,
  imminent_bonus real,
  final_score real,
  tv_match_count int,
  tv_top_keyword text,
  tv_total_pushes int,
  search_match_count int,
  search_top_keyword text,
  search_sources text[],
  restock_velocity real,
  restock_count_30d int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  tv_keywords AS (
    SELECT keyword, COUNT(*)::int AS tv_count
    FROM jimscanner_trends_keywords
    WHERE source = 'naver_tvtime'
      AND collected_at > now() - (days_window || ' days')::interval
    GROUP BY keyword
  ),
  tv_matches AS (
    SELECT
      gp.goods_no,
      tv.keyword AS tv_keyword,
      tv.tv_count,
      similarity(tv.keyword, gp.title) AS sim,
      tv.tv_count::real * similarity(tv.keyword, gp.title) AS strength
    FROM tv_keywords tv
    CROSS JOIN LATERAL (
      SELECT g.goods_no, g.title
      FROM jimscanner_ggsan_products g
      WHERE g.title % tv.keyword
      ORDER BY similarity(tv.keyword, g.title) DESC
      LIMIT 5
    ) gp
    WHERE similarity(tv.keyword, gp.title) >= min_sim
  ),
  tv_agg AS (
    SELECT
      goods_no,
      SUM(strength)::real AS tv_score,
      COUNT(DISTINCT tv_keyword)::int AS tv_match_count,
      SUM(tv_count)::int AS tv_total_pushes,
      (ARRAY_AGG(tv_keyword ORDER BY strength DESC))[1] AS tv_top_keyword
    FROM tv_matches
    GROUP BY goods_no
  ),
  search_keywords AS (
    SELECT keyword, source, COUNT(*)::int AS occurrences
    FROM jimscanner_trends_keywords
    WHERE source IN (
      'naver_shopping_hot','naver_search_trend','aliex_best','musinsa_best'
    )
      AND collected_at > now() - (days_window || ' days')::interval
    GROUP BY keyword, source
  ),
  search_matches AS (
    SELECT
      gp.goods_no,
      sk.keyword AS search_keyword,
      sk.source,
      sk.occurrences,
      similarity(sk.keyword, gp.title) AS sim,
      sk.occurrences::real * similarity(sk.keyword, gp.title) AS strength
    FROM search_keywords sk
    CROSS JOIN LATERAL (
      SELECT g.goods_no, g.title
      FROM jimscanner_ggsan_products g
      WHERE g.title % sk.keyword
      ORDER BY similarity(sk.keyword, g.title) DESC
      LIMIT 5
    ) gp
    WHERE similarity(sk.keyword, gp.title) >= min_sim
  ),
  search_agg AS (
    SELECT
      goods_no,
      SUM(strength)::real AS search_score,
      COUNT(DISTINCT search_keyword)::int AS search_match_count,
      (ARRAY_AGG(search_keyword ORDER BY strength DESC))[1] AS search_top_keyword,
      ARRAY_AGG(DISTINCT source) AS search_sources
    FROM search_matches
    GROUP BY goods_no
  ),
  restock_agg AS (
    SELECT
      goods_no,
      restock_velocity,
      restock_count_30d
    FROM jimscanner_ggsan_restock_cadence
  ),
  scored AS (
    SELECT
      gp.goods_no, gp.title, gp.cate_cd, gp.cate_label, gp.price_krw,
      gp.is_imminent, gp.image_url, gp.detail_url, gp.last_seen_at,
      COALESCE(tv.tv_score, 0)::real AS tv_score,
      COALESCE(s.search_score, 0)::real AS search_score,
      COALESCE(tv.tv_match_count, 0) AS tv_match_count,
      COALESCE(tv.tv_top_keyword, '') AS tv_top_keyword,
      COALESCE(tv.tv_total_pushes, 0) AS tv_total_pushes,
      COALESCE(s.search_match_count, 0) AS search_match_count,
      COALESCE(s.search_top_keyword, '') AS search_top_keyword,
      COALESCE(s.search_sources, ARRAY[]::text[]) AS search_sources,
      COALESCE(r.restock_velocity, 0)::real AS restock_velocity,
      COALESCE(r.restock_count_30d, 0) AS restock_count_30d
    FROM jimscanner_ggsan_products gp
    LEFT JOIN tv_agg tv ON tv.goods_no = gp.goods_no
    LEFT JOIN search_agg s ON s.goods_no = gp.goods_no
    LEFT JOIN restock_agg r ON r.goods_no = gp.goods_no
    WHERE tv.tv_score IS NOT NULL
       OR s.search_score IS NOT NULL
       OR (restock_weight > 0 AND r.restock_velocity IS NOT NULL)
  )

  SELECT
    s.goods_no,
    s.title,
    s.cate_cd,
    s.cate_label,
    s.price_krw,
    s.is_imminent,
    s.image_url,
    s.detail_url,
    s.last_seen_at AS ggsan_last_seen,
    s.tv_score,
    s.search_score,
    (s.tv_score * 1.5 + s.search_score * 1.0 + s.restock_velocity * restock_weight)::real AS raw_score,
    (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)::real AS imminent_bonus,
    ((s.tv_score * 1.5 + s.search_score * 1.0 + s.restock_velocity * restock_weight)
       * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END))::real AS final_score,
    s.tv_match_count,
    s.tv_top_keyword,
    s.tv_total_pushes,
    s.search_match_count,
    s.search_top_keyword,
    s.search_sources,
    s.restock_velocity,
    s.restock_count_30d
  FROM scored s
  WHERE ((s.tv_score * 1.5 + s.search_score * 1.0 + s.restock_velocity * restock_weight)
           * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)) >= min_score
  ORDER BY
    (CASE WHEN s.is_imminent THEN 1 ELSE 0 END) DESC,
    ((s.tv_score * 1.5 + s.search_score * 1.0 + s.restock_velocity * restock_weight)
       * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)) DESC
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_ggsan_recommend(int, float, float, int, float) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_ggsan_recommend(int, float, float, int, float) TO service_role;
