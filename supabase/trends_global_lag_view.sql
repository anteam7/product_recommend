-- ─────────────────────────────────────────────────────────────
-- 글로벌 선행 → 국내 미포화 갭 레이더 (global-lag) 집계 뷰
-- ─────────────────────────────────────────────────────────────
-- 목적: 해외/글로벌 베스트 출처(aliex_best·musinsa_best 등)에서 alias 가
--   잡힌 canonical 중, 국내 경쟁(competition_score)은 약하고 trend 는
--   상승 중인 '시차 차익(time-lag arbitrage)' 후보를 추출.
--
-- provenance 는 jimscanner_trends_aliases.source 에 이미 존재 → 추가 수집 불필요.
-- /admin/trend-radar/global-lag 페이지에서 read-only 로 조회 (service-role).
--
-- 해외 출처 정의: 현재 aliex_best(알리), musinsa_best(무신사 글로벌 베스트).
--   새 해외 베스트 수집기 추가 시 OVERSEAS_SOURCES 배열에 추가.
-- 관련 문서: docs/architecture.md · platform_direction.md
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW jimscanner_trends_global_lag AS
WITH alias_agg AS (
  SELECT
    a.product_id,
    count(*)                                                              AS alias_total,
    count(*) FILTER (WHERE a.source = ANY (ARRAY['aliex_best','musinsa_best']))
                                                                         AS overseas_alias_count,
    min(a.created_at)                                                     AS first_alias_at,
    (array_agg(a.source ORDER BY a.created_at ASC NULLS LAST))[1]         AS first_source
  FROM jimscanner_trends_aliases a
  GROUP BY a.product_id
),
latest_score AS (
  SELECT DISTINCT ON (s.product_id)
    s.product_id,
    s.trend_score,
    s.commerce_score,
    s.supplier_score,
    s.competition_score,
    s.final_score,
    s.computed_at
  FROM jimscanner_trends_scores s
  ORDER BY s.product_id, s.computed_at DESC
),
ggsan_match AS (
  -- trends_supplier 에 도매(ggsan 포함) row 가 있으면 소싱 가능 후보
  SELECT DISTINCT product_id
  FROM jimscanner_trends_supplier
)
SELECT
  p.id                                                                   AS product_id,
  p.canonical_name,
  p.category_top,
  aa.alias_total,
  aa.overseas_alias_count,
  aa.first_source,
  (aa.first_source = ANY (ARRAY['aliex_best','musinsa_best']))           AS first_source_overseas,
  -- 해외 alias 비율 (0~100)
  CASE WHEN aa.alias_total > 0
       THEN round(aa.overseas_alias_count::numeric / aa.alias_total * 100, 1)
       ELSE 0 END                                                        AS overseas_ratio,
  -- 글로벌 선행도 (0~100): 해외 alias 비율(최대 70) + 최초출현이 해외면 +30
  round(
    least(
      100,
      (CASE WHEN aa.alias_total > 0
            THEN aa.overseas_alias_count::numeric / aa.alias_total * 70
            ELSE 0 END)
      + (CASE WHEN aa.first_source = ANY (ARRAY['aliex_best','musinsa_best']) THEN 30 ELSE 0 END)
    ), 1)                                                                AS global_lead_score,
  ls.trend_score,
  ls.commerce_score,
  ls.supplier_score,
  ls.competition_score,
  ls.final_score,
  ls.computed_at,
  (gm.product_id IS NOT NULL)                                            AS ggsan_sourceable
FROM jimscanner_trends_products p
JOIN alias_agg aa            ON aa.product_id = p.id
LEFT JOIN latest_score ls    ON ls.product_id = p.id
LEFT JOIN ggsan_match gm     ON gm.product_id = p.id
WHERE aa.overseas_alias_count > 0;   -- 해외 시그널이 하나라도 있는 canonical 만

-- 뷰는 service-role 어드민 클라이언트로만 조회 (기존 trends_* 패턴과 동일).
COMMENT ON VIEW jimscanner_trends_global_lag IS
  '글로벌 선행 × 국내 미포화 갭 레이더 — aliases.source provenance + latest scores 집계';
