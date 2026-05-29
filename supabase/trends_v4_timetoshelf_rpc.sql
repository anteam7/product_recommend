-- ────────────────────────────────────────────────────────────
-- 트렌드 반감기 × 소싱 리드타임 진입 타당성 게이트 RPC
-- (PR-TIMETOSHELF, 2026-05-29)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/time-to-shelf 페이지 ('도착타당성')
--
-- 핵심 아이디어:
--   위탁 판매의 최대 실패요인 = '도착 전 트렌드 소멸'.
--   trends_keywords.volume_relative 시계열로 키워드별 잔여 '반감기(일)'를
--   선형회귀(최근 N포인트 기울기 → 현재값의 절반 도달 예상일)로 추정하고,
--   trends_supplier.lead_time_days + 발행/세팅 버퍼를 차감해
--   '선반 도착 여유(shelf buffer)'를 산출한다.
--
--   shelf_buffer = halflife_days - (lead_time_days + publish_buffer_days)
--     ≥ +7  → GO        (도착 후에도 충분한 잔존 수요)
--     0 ~ 7 → CAUTION    (빠듯함 — 단리드 소스로 우회 권장)
--     < 0   → TOO_LATE   (물리적으로 도착 전 소멸 — 진입 차단)
--
--   slope ≥ 0 (수요 상승/유지)  → 소멸 없음 → GO
--   1688 등 장리드 소스는 자동 NO-GO 쪽으로, ggsan 국내 단리드는 GO 비중↑.
--
-- 키워드 ↔ 공급원 연결: trends_aliases(alias = keyword) → product_id → trends_supplier.
--   매칭 공급원 중 lead_time_days 가 가장 짧은(빠른) row 채택.
--   미매칭 시 default_lead_time_days 적용.
--
-- service_role 로만 호출 (어드민 한정) — SECURITY DEFINER + grant 명시
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_trends_time_to_shelf(
  days_window int DEFAULT 30,
  min_points int DEFAULT 3,
  publish_buffer_days int DEFAULT 3,
  default_lead_time_days int DEFAULT 7,
  result_limit int DEFAULT 200
)
RETURNS TABLE (
  keyword text,
  category_top text,
  n_points int,
  first_seen timestamptz,
  last_seen timestamptz,
  current_volume numeric,
  peak_volume numeric,
  slope_per_day numeric,
  halflife_days numeric,
  supplier_source text,
  lead_time_days int,
  is_domestic boolean,
  publish_buffer_days int,
  shelf_buffer_days numeric,
  gate text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH series AS (
    -- 키워드별 volume_relative 시계열 (수집 시각, 값)
    SELECT
      k.keyword,
      MAX(k.category_top) AS category_top,
      COUNT(*) FILTER (WHERE k.volume_relative IS NOT NULL)::int AS n_points,
      MIN(k.collected_at) AS first_seen,
      MAX(k.collected_at) AS last_seen,
      MAX(k.volume_relative) AS peak_volume,
      -- 일 단위 기울기 (volume / day)
      regr_slope(
        k.volume_relative,
        EXTRACT(EPOCH FROM k.collected_at) / 86400.0
      ) AS slope_per_day,
      -- 가장 최근 포인트의 값 (현재 수요 수준)
      (ARRAY_AGG(k.volume_relative ORDER BY k.collected_at DESC))[1] AS current_volume
    FROM jimscanner_trends_keywords k
    WHERE k.collected_at > now() - (days_window || ' days')::interval
      AND k.volume_relative IS NOT NULL
      AND k.source IN ('naver_search_trend', 'naver_shopping_insight')
    GROUP BY k.keyword
    HAVING COUNT(*) FILTER (WHERE k.volume_relative IS NOT NULL) >= min_points
  ),
  withhalf AS (
    SELECT
      s.*,
      -- 반감기: slope < 0 (하락) 일 때만 유한. 현재값의 절반까지 며칠?
      -- halflife = (current/2) / (-slope) = current / (2 * -slope)
      CASE
        WHEN s.slope_per_day < 0 AND s.current_volume > 0
          THEN s.current_volume / (2.0 * (-s.slope_per_day))
        ELSE NULL   -- 상승/유지 → 소멸 없음
      END AS halflife_days
    FROM series s
  ),
  withsup AS (
    SELECT
      w.*,
      sup.supplier_source,
      COALESCE(sup.lead_time_days, default_lead_time_days) AS lead_time_days,
      -- 국내 단리드 소스 판별 (ggsan/도매꾹/오너클랜 = 국내, 1688/알리/temu = 해외 장리드)
      CASE
        WHEN sup.supplier_source IS NULL THEN NULL
        WHEN sup.supplier_source IN ('1688', 'aliexpress', 'temu') THEN false
        ELSE true
      END AS is_domestic
    FROM withhalf w
    LEFT JOIN LATERAL (
      -- 키워드 → alias → product → supplier 중 가장 빠른(단리드) 공급원
      SELECT su.supplier_source, su.lead_time_days
      FROM jimscanner_trends_aliases al
      JOIN jimscanner_trends_supplier su ON su.product_id = al.product_id
      WHERE lower(al.alias) = lower(w.keyword)
        AND su.lead_time_days IS NOT NULL
      ORDER BY su.lead_time_days ASC
      LIMIT 1
    ) sup ON true
  )
  SELECT
    ws.keyword,
    ws.category_top,
    ws.n_points,
    ws.first_seen,
    ws.last_seen,
    ws.current_volume,
    ws.peak_volume,
    ws.slope_per_day,
    ws.halflife_days,
    ws.supplier_source,
    ws.lead_time_days,
    ws.is_domestic,
    publish_buffer_days,
    -- shelf buffer: NULL halflife(상승/유지) 면 NULL (게이트에서 GO 처리)
    CASE
      WHEN ws.halflife_days IS NULL THEN NULL
      ELSE ws.halflife_days - (ws.lead_time_days + publish_buffer_days)
    END AS shelf_buffer_days,
    -- 게이트 판정
    CASE
      WHEN ws.halflife_days IS NULL THEN 'GO'                               -- 수요 상승/유지
      WHEN ws.halflife_days - (ws.lead_time_days + publish_buffer_days) >= 7  THEN 'GO'
      WHEN ws.halflife_days - (ws.lead_time_days + publish_buffer_days) >= 0  THEN 'CAUTION'
      ELSE 'TOO_LATE'
    END AS gate
  FROM withsup ws
  ORDER BY
    -- 위험한 것(TOO_LATE)·빠듯한 것(CAUTION) 먼저 보이게 + 현재 수요 강한 순
    CASE
      WHEN ws.halflife_days IS NULL THEN 3
      WHEN ws.halflife_days - (ws.lead_time_days + publish_buffer_days) >= 7 THEN 2
      WHEN ws.halflife_days - (ws.lead_time_days + publish_buffer_days) >= 0 THEN 0  -- CAUTION 최상단
      ELSE 1                                                                          -- TOO_LATE 다음
    END ASC,
    ws.current_volume DESC NULLS LAST
  LIMIT result_limit;
$$;

-- 어드민 service-role 만 호출 (anon/authenticated 차단)
REVOKE ALL ON FUNCTION jimscanner_trends_time_to_shelf(int, int, int, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_trends_time_to_shelf(int, int, int, int, int) TO service_role;
