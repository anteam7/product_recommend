-- ────────────────────────────────────────────────────────────
-- 수요 변동성 기반 위탁 vs 사입 분기 게이트 RPC (2026-05-29)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/fulfillment 페이지
--
-- jimscanner_trends_keywords 의 (keyword, source) 별 volume_relative
-- 시계열(collected_at 누적 row)에서 수요 변동성 지표를 계산해
-- 위탁(委託) vs 사입(仕入) 권고를 데이터로 추천한다.
--
-- 지표:
--   cv        = stddev_samp / mean        (변동계수 = 변동성 핵심 지표)
--   spike_freq= (mean+stddev 초과 관측)/n  (간헐 스파이크 빈도)
--   autocorr  = corr(v_t, v_{t-1})        (lag-1 자기상관 = 추세 지속성)
--   mean_vol  = avg(volume_relative)       (평균 수요)
--
-- 3분면 라벨(mode):
--   ① consignment '위탁 적합' : 高CV·간헐 스파이크 → 재고 무리스크
--   ② purchase    '사입 검토'  : 低CV·고볼륨·안정 → 마진 우위
--   ③ hold        '보류'      : 低볼륨·잡음
--
-- service_role 로만 호출 (어드민 한정) — SECURITY DEFINER + grant 명시
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_trends_fulfillment_mode(
  days_window int DEFAULT 90,
  min_observations int DEFAULT 4,
  min_volume numeric DEFAULT 5,
  result_limit int DEFAULT 300
)
RETURNS TABLE (
  keyword text,
  source text,
  category_top text,
  n_obs int,
  mean_vol numeric,
  stddev_vol numeric,
  cv numeric,
  spike_freq numeric,
  autocorr numeric,
  first_seen timestamptz,
  last_seen timestamptz,
  mode text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH series AS (
    SELECT
      k.keyword,
      k.source,
      k.category_top,
      k.volume_relative::numeric AS v,
      k.collected_at,
      LAG(k.volume_relative::numeric) OVER (
        PARTITION BY k.keyword, k.source ORDER BY k.collected_at
      ) AS v_prev
    FROM jimscanner_trends_keywords k
    WHERE k.collected_at > now() - (days_window || ' days')::interval
      AND k.volume_relative IS NOT NULL
  ),
  agg AS (
    SELECT
      s.keyword,
      s.source,
      -- 같은 (keyword, source) 안에서 category_top 가 섞여도 대표값 하나
      MAX(s.category_top) AS category_top,
      COUNT(*)::int AS n_obs,
      AVG(s.v) AS mean_vol,
      STDDEV_SAMP(s.v) AS stddev_vol,
      -- 스파이크: 평균 + 1σ 초과 관측 비율
      AVG(
        CASE
          WHEN s.v > AVG(s.v) OVER (PARTITION BY s.keyword, s.source)
                     + COALESCE(STDDEV_SAMP(s.v) OVER (PARTITION BY s.keyword, s.source), 0)
          THEN 1 ELSE 0
        END
      ) AS spike_freq,
      CORR(s.v, s.v_prev) AS autocorr,
      MIN(s.collected_at) AS first_seen,
      MAX(s.collected_at) AS last_seen
    FROM series s
    GROUP BY s.keyword, s.source
  ),
  scored AS (
    SELECT
      a.keyword,
      a.source,
      a.category_top,
      a.n_obs,
      ROUND(a.mean_vol, 2) AS mean_vol,
      ROUND(COALESCE(a.stddev_vol, 0), 2) AS stddev_vol,
      CASE
        WHEN a.mean_vol > 0 THEN ROUND(COALESCE(a.stddev_vol, 0) / a.mean_vol, 3)
        ELSE NULL
      END AS cv,
      ROUND(COALESCE(a.spike_freq, 0), 3) AS spike_freq,
      ROUND(a.autocorr, 3) AS autocorr,
      a.first_seen,
      a.last_seen
    FROM agg a
    WHERE a.n_obs >= min_observations
      AND a.mean_vol >= min_volume
  )
  SELECT
    sc.keyword,
    sc.source,
    sc.category_top,
    sc.n_obs,
    sc.mean_vol,
    sc.stddev_vol,
    sc.cv,
    sc.spike_freq,
    sc.autocorr,
    sc.first_seen,
    sc.last_seen,
    CASE
      -- ① 高CV·간헐 스파이크 → 위탁 (재고 리스크 회피)
      WHEN sc.cv >= 0.5 OR sc.spike_freq >= 0.18 THEN 'consignment'
      -- ② 低CV·고볼륨·안정 → 사입 (마진 우위)
      WHEN sc.cv < 0.5 AND sc.mean_vol >= 30 THEN 'purchase'
      -- ③ 그 외 (低볼륨·잡음) → 보류
      ELSE 'hold'
    END AS mode
  FROM scored sc
  ORDER BY sc.mean_vol DESC
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출 (anon/authenticated 차단)
REVOKE ALL ON FUNCTION jimscanner_trends_fulfillment_mode(int, int, numeric, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_trends_fulfillment_mode(int, int, numeric, int) TO service_role;
