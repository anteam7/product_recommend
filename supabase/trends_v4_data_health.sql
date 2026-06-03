-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 수집 파이프라인 신뢰도 (data-health, 2026-06-04)
-- ─────────────────────────────────────────────────────────────
-- sources/page.tsx 가 "나열"만 하던 last_at·count 를 데이터 무결성 진단으로 격상.
-- jimscanner_trends_runs 시계열에서 소스별 건강도를 계산하고,
-- 그 건강도를 발굴(products)로 전파하기 위한 view 2개.
--
-- D5: 운영자 전용. RLS 는 base table(jimscanner_trends_runs/_aliases) 정책을 상속.
-- 적용은 사람이 psql 로. (코드는 적용 후 상태를 가정, supabase 타입 미생성이라 `as any` 캐스팅)
-- 관련 페이지: src/app/admin/(dashboard)/trend-radar/data-health/page.tsx
-- ─────────────────────────────────────────────────────────────

-- 1) 소스별 건강도 — 자기-baseline 대비 z-score, freshness lag, partial/error율
--    무성 급락(naver_news=24 vs 평소) · 신선도 지연(recompute_scores stale) 탐지.
CREATE OR REPLACE VIEW jimscanner_trends_source_health AS
WITH recent AS (
  SELECT
    source,
    status,
    inserted_count,
    fetched_count,
    started_at,
    row_number() OVER (PARTITION BY source ORDER BY started_at DESC) AS rn
  FROM jimscanner_trends_runs
  WHERE started_at > now() - interval '30 days'
),
stats AS (
  SELECT
    source,
    count(*)                                  AS n_runs,
    avg(inserted_count)                       AS mean_inserted,
    stddev_pop(inserted_count)                AS sd_inserted,
    avg((status = 'ok')::int)::numeric        AS ok_rate,
    avg((status = 'partial')::int)::numeric   AS partial_rate,
    avg((status = 'error')::int)::numeric     AS error_rate
  FROM recent
  GROUP BY source
),
latest AS (
  SELECT source, inserted_count AS last_inserted, fetched_count AS last_fetched,
         status AS last_status, started_at AS last_started
  FROM recent
  WHERE rn = 1
)
SELECT
  s.source,
  s.n_runs,
  round(s.mean_inserted, 1)                                   AS mean_inserted,
  round(s.sd_inserted, 1)                                     AS sd_inserted,
  l.last_inserted,
  l.last_fetched,
  l.last_status,
  l.last_started,
  -- 자기-baseline 대비 z-score (음수 = 평소보다 폭락)
  CASE
    WHEN s.sd_inserted IS NULL OR s.sd_inserted = 0 THEN 0
    ELSE round(((l.last_inserted - s.mean_inserted) / s.sd_inserted)::numeric, 2)
  END                                                         AS inserted_z,
  round(s.ok_rate, 3)                                         AS ok_rate,
  round(s.partial_rate, 3)                                    AS partial_rate,
  round(s.error_rate, 3)                                      AS error_rate,
  round((extract(epoch FROM (now() - l.last_started)) / 3600)::numeric, 1) AS hours_since_last
FROM stats s
JOIN latest l USING (source);

-- 2) 상품별 데이터 신뢰 — alias.source × 소스 건강도 역추적
--    "현재 degraded/stale 한 소스만으로" 떠받쳐진 product 를 탐지해
--    products 보드에 '데이터 신뢰 디스카운트' 배지를 붙이는 근거.
CREATE OR REPLACE VIEW jimscanner_trends_product_trust AS
WITH alias_health AS (
  SELECT
    a.product_id,
    a.source,
    h.inserted_z,
    h.hours_since_last,
    h.last_status,
    -- 소스가 degraded(무성 급락 z<=-1.5 / error / 30h+ stale) 인지
    CASE
      WHEN h.source IS NULL THEN false
      WHEN h.inserted_z <= -1.5 OR h.last_status = 'error' OR h.hours_since_last > 30 THEN true
      ELSE false
    END AS source_degraded
  FROM jimscanner_trends_aliases a
  LEFT JOIN jimscanner_trends_source_health h ON h.source = a.source
)
SELECT
  product_id,
  count(*)                                              AS alias_count,
  count(*) FILTER (WHERE source IS NOT NULL)            AS sourced_alias_count,
  count(*) FILTER (WHERE source_degraded)               AS degraded_alias_count,
  -- 신뢰 디스카운트: degraded 소스에만 의존할수록 1.0 에 근접
  CASE
    WHEN count(*) FILTER (WHERE source IS NOT NULL) = 0 THEN 0
    ELSE round(
      count(*) FILTER (WHERE source_degraded)::numeric
      / count(*) FILTER (WHERE source IS NOT NULL),
    2)
  END                                                   AS trust_discount
FROM alias_health
GROUP BY product_id;
