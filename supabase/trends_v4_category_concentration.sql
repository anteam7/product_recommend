-- ────────────────────────────────────────────────────────────
-- 카테고리 수요 집중도(HHI) 진입난이도 지도 (2026-05-29)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/concentration
--
-- 상품 단위가 아닌 카테고리 '분포 형태(구조)'를 측정한다.
--   HHI            = Σ(키워드 점유율²)  → 0(완전 파편화)~1(독점)
--   유효키워드수    = 1 / HHI            → 실질적으로 수요를 나눠 갖는 키워드 수
--   top1/top3 점유  = 헤드 키워드 쏠림
--   demand momentum = 최근 30일 총수요 / 직전 30일 총수요
--   hhi_delta       = 최근 HHI − 직전 HHI (양수=집중 강화/거인 고착, 음수=파편화/개방)
--
-- 1인 위탁 셀러 관점: 저(低)HHI × 성장 = 진입 사냥터.
--
-- 키워드 테이블은 시계열(매 수집마다 row 추가)이므로
-- (category_top, keyword) 별 윈도우 내 '가장 최근' volume_relative 만 표본으로 쓴다.
-- service_role(어드민) 전용. 뷰는 SECURITY INVOKER 기본 — base 테이블 RLS 따름.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW jimscanner_trends_category_concentration AS
WITH recent_kw AS (
  SELECT DISTINCT ON (k.category_top, k.keyword)
    k.category_top,
    k.keyword,
    k.volume_relative AS vol
  FROM jimscanner_trends_keywords k
  WHERE k.category_top IS NOT NULL
    AND k.volume_relative IS NOT NULL
    AND k.volume_relative > 0
    AND k.collected_at >= now() - interval '30 days'
  ORDER BY k.category_top, k.keyword, k.collected_at DESC
),
prior_kw AS (
  SELECT DISTINCT ON (k.category_top, k.keyword)
    k.category_top,
    k.keyword,
    k.volume_relative AS vol
  FROM jimscanner_trends_keywords k
  WHERE k.category_top IS NOT NULL
    AND k.volume_relative IS NOT NULL
    AND k.volume_relative > 0
    AND k.collected_at >= now() - interval '60 days'
    AND k.collected_at <  now() - interval '30 days'
  ORDER BY k.category_top, k.keyword, k.collected_at DESC
),
recent_shares AS (
  SELECT
    category_top,
    keyword,
    vol,
    vol / NULLIF(SUM(vol) OVER (PARTITION BY category_top), 0) AS share
  FROM recent_kw
),
prior_shares AS (
  SELECT
    category_top,
    vol / NULLIF(SUM(vol) OVER (PARTITION BY category_top), 0) AS share
  FROM prior_kw
),
recent_agg AS (
  SELECT
    rs.category_top,
    COUNT(*)::int             AS keyword_count,
    SUM(rs.vol)               AS total_volume,
    SUM(rs.share * rs.share)  AS hhi,
    MAX(rs.share)             AS top1_share,
    (
      SELECT COALESCE(SUM(s.share), 0)
      FROM (
        SELECT rs2.share
        FROM recent_shares rs2
        WHERE rs2.category_top = rs.category_top
        ORDER BY rs2.share DESC
        LIMIT 3
      ) s
    )                         AS top3_share
  FROM recent_shares rs
  GROUP BY rs.category_top
),
prior_agg AS (
  SELECT
    category_top,
    SUM(share * share) AS hhi,
    SUM(vol)           AS total_volume
  FROM prior_kw pk
  -- prior_shares 와 같은 분모를 쓰기 위해 윈도우 재계산
  JOIN LATERAL (
    SELECT pk.vol / NULLIF(SUM(pk2.vol), 0) AS share
    FROM prior_kw pk2
    WHERE pk2.category_top = pk.category_top
  ) ps ON true
  GROUP BY category_top
)
SELECT
  ra.category_top,
  ra.keyword_count,
  ROUND(ra.total_volume::numeric, 2)               AS total_volume,
  ROUND(ra.hhi::numeric, 4)                         AS hhi,
  ROUND((1.0 / NULLIF(ra.hhi, 0))::numeric, 2)      AS effective_keywords,
  ROUND((ra.top1_share * 100)::numeric, 1)          AS top1_share_pct,
  ROUND((ra.top3_share * 100)::numeric, 1)          AS top3_share_pct,
  ROUND(pa.hhi::numeric, 4)                         AS prior_hhi,
  ROUND((ra.hhi - COALESCE(pa.hhi, ra.hhi))::numeric, 4) AS hhi_delta,
  ROUND(COALESCE(pa.total_volume, 0)::numeric, 2)   AS prior_total_volume,
  CASE
    WHEN COALESCE(pa.total_volume, 0) > 0
      THEN ROUND(((ra.total_volume / pa.total_volume) - 1)::numeric, 3)
    ELSE NULL
  END                                               AS demand_momentum
FROM recent_agg ra
LEFT JOIN prior_agg pa USING (category_top)
WHERE ra.keyword_count >= 2          -- HHI 가 의미 있으려면 최소 2개 키워드
ORDER BY ra.total_volume DESC;

COMMENT ON VIEW jimscanner_trends_category_concentration IS
  '카테고리 수요 집중도(HHI) 진입난이도 지도. category_top 별 키워드 volume_relative 분포로 HHI·유효키워드수·top1/3점유·수요모멘텀·HHI추세 산출. /admin/trend-radar/concentration 사용.';
