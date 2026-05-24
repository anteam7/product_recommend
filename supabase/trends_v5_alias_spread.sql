-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v5 — Alias 분산 통합 리스팅 Capture Uplift 보드
-- ─────────────────────────────────────────────────────────────
-- 목적:
--   각 canonical product 의 alias 가 검색량(volume_relative) 기준으로
--   얼마나 분산되어 있는지(=단일 표준 리스팅으로 모두 흡수 가능한지) 측정.
--
-- 컬럼:
--   alias_n              : 해당 product 의 alias 개수
--   total_volume         : alias 들의 최근 volume_relative 합
--   top1_alias           : 가장 많이 검색되는 alias
--   top1_share           : top1 alias 의 점유율 (0~1)
--   top3_share           : top3 alias 누적 점유율 (0~1)
--   effective_alias_count: 1/HHI (실효 alias 수, 분산 정도 척도)
--   capture_uplift       : 1/top1_share (= 단일 표준 리스팅으로 모두
--                          흡수했을 때 top1 단독 대비 검색량 배수)
--   gini                 : 0 (완전 균등) ~ 1 (완전 집중)
--
-- 적용:
--   - top1_share ≥ 0.7  → 단일 표준 리스팅으로 충분 (capture_uplift 작음)
--   - top1_share < 0.4  → alias 별 분산 listing 또는 SEO 통합 가치 큼
-- ─────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS jimscanner_alias_spread;

CREATE VIEW jimscanner_alias_spread AS
WITH alias_volume AS (
  SELECT
    a.product_id,
    a.alias,
    COALESCE((
      SELECT k.volume_relative
      FROM jimscanner_trends_keywords k
      WHERE k.keyword = a.alias
        AND k.volume_relative IS NOT NULL
        AND k.collected_at > now() - interval '30 days'
      ORDER BY k.collected_at DESC
      LIMIT 1
    ), 0)::numeric AS volume
  FROM jimscanner_trends_aliases a
),
totals AS (
  SELECT
    product_id,
    SUM(volume) AS total_volume,
    COUNT(*)    AS alias_n
  FROM alias_volume
  GROUP BY product_id
),
shares AS (
  SELECT
    av.product_id,
    av.alias,
    av.volume,
    t.total_volume,
    t.alias_n,
    CASE WHEN t.total_volume > 0 THEN av.volume / t.total_volume ELSE 0 END AS share,
    ROW_NUMBER() OVER (PARTITION BY av.product_id ORDER BY av.volume DESC, av.alias) AS rn_desc,
    ROW_NUMBER() OVER (PARTITION BY av.product_id ORDER BY av.volume ASC,  av.alias) AS rn_asc
  FROM alias_volume av
  JOIN totals t ON t.product_id = av.product_id
)
SELECT
  product_id,
  MAX(alias_n)::int                                                 AS alias_n,
  ROUND(MAX(total_volume)::numeric, 2)                              AS total_volume,
  MAX(CASE WHEN rn_desc = 1 THEN alias END)                         AS top1_alias,
  ROUND(COALESCE(MAX(CASE WHEN rn_desc = 1 THEN share END), 0)::numeric, 4) AS top1_share,
  ROUND(COALESCE(SUM(CASE WHEN rn_desc <= 3 THEN share ELSE 0 END), 0)::numeric, 4) AS top3_share,
  ROUND(
    CASE WHEN SUM(share * share) > 0
      THEN (1.0 / SUM(share * share))
      ELSE 0
    END::numeric, 3
  ) AS effective_alias_count,
  ROUND(
    CASE WHEN MAX(CASE WHEN rn_desc = 1 THEN share END) > 0
      THEN (1.0 / MAX(CASE WHEN rn_desc = 1 THEN share END))
      ELSE 0
    END::numeric, 3
  ) AS capture_uplift,
  ROUND(
    CASE
      WHEN MAX(alias_n) > 1 AND MAX(total_volume) > 0 THEN
        GREATEST(0::numeric, LEAST(1::numeric,
          ((2.0 * SUM(rn_asc * share) / NULLIF(MAX(alias_n), 0))
            - ((MAX(alias_n) + 1.0) / NULLIF(MAX(alias_n), 0)))::numeric
        ))
      ELSE 0
    END, 3
  ) AS gini
FROM shares
GROUP BY product_id;

COMMENT ON VIEW jimscanner_alias_spread IS
  'product 별 alias 검색량 분산 지표. capture_uplift = 1/top1_share = 단일 표준 리스팅 통합 시 top1 단독 대비 검색량 배수. effective_alias_count = 1/HHI.';

-- 옵션: 정적 RPC (Supabase 의 view permission 우회 / 서비스롤에서 호출용).
CREATE OR REPLACE FUNCTION jimscanner_alias_spread_for(p_product_id uuid)
RETURNS TABLE (
  product_id uuid,
  alias_n int,
  total_volume numeric,
  top1_alias text,
  top1_share numeric,
  top3_share numeric,
  effective_alias_count numeric,
  capture_uplift numeric,
  gini numeric
) LANGUAGE sql STABLE AS $$
  SELECT * FROM jimscanner_alias_spread WHERE product_id = p_product_id;
$$;
