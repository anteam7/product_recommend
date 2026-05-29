-- ─────────────────────────────────────────────────────────────
-- 수요 대체 레이더 — 쇠퇴 incumbent → 부상 substitute 자금이동 추적
-- (Demand Substitution Radar, 2026-05-29)
-- ─────────────────────────────────────────────────────────────
-- 같은 need-space(category_top 동일) 안에서 한 키워드(faller)의 검색 수요가
-- 하락하는 동시에 형제 키워드(riser)가 상승하며 '음의 상관'을 보이는 쌍을 탐지.
--
-- 입력: jimscanner_trends_keywords(시계열 volume_relative) + (선택) synonym_clusters
-- 산출: (faller → riser) 방향 엣지, 트레일링 N일 기울기, 두 궤적의 anti-correlation
--       (Pearson), 교차 시점, faller 가 쥐고 있던 '이전 추정 수요량(peak)'.
--
-- opportunity 보드(단일 상품 점수)와 달리 '상품 쌍의 수요 교대'를 본다.
-- 인접 렌즈: lead-lag(#44 선행지표) · self-cannibal(#43 자기SKU) · co-search(#31 보완재)
--           와 달리 '경쟁 need-space 내 교체'를 음상관으로 잡는다.
--
-- 노출 정책: service-role 만 호출 (어드민 RPC). SECURITY INVOKER.
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_demand_substitution(
  days_window  int     DEFAULT 28,    -- 트레일링 관측 창
  min_points   int     DEFAULT 5,     -- 키워드별 최소 관측일(노이즈 제거)
  min_slope    numeric DEFAULT 0.0,   -- |기울기| 최소 (0 = 부호만 본다)
  max_corr     numeric DEFAULT -0.4,  -- Pearson 상한 (이 값 이하 = 음상관)
  result_limit int     DEFAULT 100
)
RETURNS TABLE (
  category_top         text,
  faller_keyword       text,
  riser_keyword        text,
  faller_source        text,
  riser_source         text,
  faller_slope         numeric,
  riser_slope          numeric,
  pearson              numeric,
  overlap_days         int,
  faller_recent        numeric,
  riser_recent         numeric,
  faller_peak          numeric,
  riser_recent_share   numeric,   -- riser 현재값 / (faller peak) — 수요 흡수율 추정
  prev_demand_estimate numeric,   -- faller 가 쥐고 있던 이전 추정 수요량 (peak)
  crossing_at          timestamptz,
  cluster_label        text
)
LANGUAGE sql
STABLE
AS $$
  WITH daily AS (
    -- 키워드×소스 단위 일별 평균 volume_relative (시계열 정규화)
    SELECT
      k.keyword,
      k.source,
      COALESCE(k.category_top, 'all') AS category_top,
      date_trunc('day', k.collected_at) AS day,
      avg(k.volume_relative) AS val
    FROM jimscanner_trends_keywords k
    WHERE k.collected_at >= now() - (days_window || ' days')::interval
      AND k.volume_relative IS NOT NULL
    GROUP BY 1, 2, 3, 4
  ),
  stats AS (
    -- 키워드별 트레일링 기울기(선형회귀) + 피크
    SELECT
      keyword,
      source,
      category_top,
      count(*)::int AS n,
      regr_slope(val, extract(epoch FROM day) / 86400.0) AS slope,
      max(val) AS peak_val
    FROM daily
    GROUP BY 1, 2, 3
  ),
  recent AS (
    -- 키워드별 최신일 값
    SELECT DISTINCT ON (keyword, source)
      keyword, source, val AS recent_val
    FROM daily
    ORDER BY keyword, source, day DESC
  ),
  pairs AS (
    -- 같은 need-space 안에서 (하락 faller) × (상승 riser) 방향 쌍
    SELECT
      f.category_top,
      f.keyword AS faller_keyword, f.source AS faller_source,
      f.slope   AS faller_slope,   f.peak_val AS faller_peak,
      r.keyword AS riser_keyword,  r.source AS riser_source,
      r.slope   AS riser_slope
    FROM stats f
    JOIN stats r
      ON f.category_top = r.category_top
     AND NOT (f.keyword = r.keyword AND f.source = r.source)
    WHERE f.n >= min_points
      AND r.n >= min_points
      AND f.category_top <> 'all'
      AND f.slope < -abs(min_slope)   -- 하락
      AND r.slope >  abs(min_slope)   -- 상승
  ),
  corr_calc AS (
    -- 두 궤적을 같은 날짜로 정렬해 Pearson + 교차 시점 계산
    SELECT
      p.category_top,
      p.faller_keyword, p.faller_source, p.faller_slope, p.faller_peak,
      p.riser_keyword,  p.riser_source,  p.riser_slope,
      corr(dr.val, df.val) AS pearson,
      count(*)::int AS overlap_days,
      min(df.day) FILTER (WHERE dr.val >= df.val) AS crossing_at
    FROM pairs p
    JOIN daily df
      ON df.keyword = p.faller_keyword AND df.source = p.faller_source
    JOIN daily dr
      ON dr.keyword = p.riser_keyword  AND dr.source = p.riser_source
     AND dr.day = df.day
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
  )
  SELECT
    c.category_top,
    c.faller_keyword,
    c.riser_keyword,
    c.faller_source,
    c.riser_source,
    round(c.faller_slope, 4) AS faller_slope,
    round(c.riser_slope, 4)  AS riser_slope,
    round(c.pearson, 4)      AS pearson,
    c.overlap_days,
    round(rf.recent_val, 2)  AS faller_recent,
    round(rr.recent_val, 2)  AS riser_recent,
    round(c.faller_peak, 2)  AS faller_peak,
    CASE WHEN c.faller_peak > 0
         THEN round(rr.recent_val / c.faller_peak, 3)
         ELSE NULL END       AS riser_recent_share,
    round(c.faller_peak, 2)  AS prev_demand_estimate,
    c.crossing_at,
    cl.canonical_label       AS cluster_label
  FROM corr_calc c
  LEFT JOIN recent rf ON rf.keyword = c.faller_keyword AND rf.source = c.faller_source
  LEFT JOIN recent rr ON rr.keyword = c.riser_keyword  AND rr.source = c.riser_source
  LEFT JOIN LATERAL (
    SELECT scm.cluster_id
    FROM jimscanner_signal_cluster_map scm
    WHERE scm.signal_kind = 'trends_keyword'
      AND scm.surface_term = c.faller_keyword
    LIMIT 1
  ) m ON true
  LEFT JOIN jimscanner_synonym_clusters cl ON cl.id = m.cluster_id
  WHERE c.pearson IS NOT NULL
    AND c.pearson <= max_corr
    AND c.overlap_days >= min_points
  ORDER BY c.pearson ASC, c.faller_peak DESC
  LIMIT result_limit;
$$;

-- 어드민(service-role) 외 접근 차단: 명시적 grant 없음 = service-role 만.
REVOKE ALL ON FUNCTION jimscanner_demand_substitution(int, int, numeric, numeric, int) FROM PUBLIC;
