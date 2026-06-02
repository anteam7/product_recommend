-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 카테고리 섹터 로테이션 (RRG)
-- ─────────────────────────────────────────────────────────────
-- 목적: 개별 상품(product altitude)이 아니라 category_top/category_mid 단위로
--   한 단계 위 거시 뷰를 제공한다. "이번 주 어느 카테고리 우물을 팔지" 자원 배분 결정용.
--
-- 데이터 소스: jimscanner_trends_scores (시계열, computed_at) + jimscanner_trends_products
-- 추가 수집 없이 기존 누적 시계열을 집계만 한다.
--
-- 산출 지표 (금융권 RRG = Relative Rotation Graph 방식):
--   level     : 현재 윈도우 평균 final_score (= 상대 강도, X축)
--   momentum  : 현재 윈도우 평균 - 직전 윈도우 평균 (= 변화율, Y축)
--   breadth   : 카테고리 내 '상승(current>prior)' 상품 비중 % (시장 폭)
--
-- RRG 4분면(축은 cross-category 평균에서 교차):
--   주도(Leading)   : level↑ momentum↑   → 지금 파야 할 우물
--   둔화(Weakening) : level↑ momentum↓   → 수확 마무리
--   소외(Lagging)   : level↓ momentum↓   → 방치
--   회복(Improving) : level↓ momentum↑   → 관찰 진입
--
-- 노출 정책: jimscanner_trends_* 동일 — service-role 만 접근.
-- 관련: src/app/admin/(dashboard)/trend-radar/sectors/page.tsx
-- ─────────────────────────────────────────────────────────────

-- 카테고리(top·mid) × 윈도우 집계 RPC.
--   cur_days     : 현재 윈도우 길이(일). 기본 7.
--   prior_days   : 직전 윈도우 길이(일). 기본 7. (현재 윈도우 직전 prior_days 구간)
--   group_mid    : true 면 (category_top, category_mid) 단위, false 면 category_top 단위.
--   top_filter   : NULL 이 아니면 해당 category_top 으로 한정 (mid 드릴다운용).
CREATE OR REPLACE FUNCTION jimscanner_trends_sector_rotation(
  cur_days   int DEFAULT 7,
  prior_days int DEFAULT 7,
  group_mid  boolean DEFAULT false,
  top_filter text DEFAULT NULL
)
RETURNS TABLE (
  category_top    text,
  category_mid    text,
  product_count   bigint,
  rising_count    bigint,
  breadth_pct     numeric,
  level           numeric,   -- 현재 윈도우 평균 final_score
  prior_level     numeric,   -- 직전 윈도우 평균 final_score
  momentum        numeric,   -- level - prior_level
  trend_level     numeric    -- 현재 윈도우 평균 trend_score (참고)
)
LANGUAGE sql
STABLE
AS $$
  WITH params AS (
    SELECT
      now() - make_interval(days => cur_days)               AS cur_start,
      now()                                                  AS cur_end,
      now() - make_interval(days => cur_days + prior_days)   AS prior_start,
      now() - make_interval(days => cur_days)                AS prior_end
  ),
  -- 상품별 현재 윈도우 평균
  cur AS (
    SELECT s.product_id,
           avg(s.final_score) AS final_score,
           avg(s.trend_score) AS trend_score
    FROM jimscanner_trends_scores s, params p
    WHERE s.computed_at >= p.cur_start AND s.computed_at < p.cur_end
    GROUP BY s.product_id
  ),
  -- 상품별 직전 윈도우 평균
  prior AS (
    SELECT s.product_id,
           avg(s.final_score) AS final_score
    FROM jimscanner_trends_scores s, params p
    WHERE s.computed_at >= p.prior_start AND s.computed_at < p.prior_end
    GROUP BY s.product_id
  ),
  -- 상품 + 카테고리 결합 (현재 윈도우에 점이 있는 상품만)
  joined AS (
    SELECT
      pr.category_top,
      CASE WHEN group_mid THEN COALESCE(pr.category_mid, '(미지정)') ELSE NULL END AS category_mid,
      c.final_score                          AS cur_final,
      COALESCE(prv.final_score, c.final_score) AS prior_final,
      c.trend_score                          AS cur_trend
    FROM cur c
    JOIN jimscanner_trends_products pr ON pr.id = c.product_id
    LEFT JOIN prior prv ON prv.product_id = c.product_id
    WHERE (top_filter IS NULL OR pr.category_top = top_filter)
  )
  SELECT
    j.category_top,
    j.category_mid,
    count(*)                                                       AS product_count,
    count(*) FILTER (WHERE j.cur_final > j.prior_final)            AS rising_count,
    round(100.0 * count(*) FILTER (WHERE j.cur_final > j.prior_final) / NULLIF(count(*), 0), 1) AS breadth_pct,
    round(avg(j.cur_final), 1)                                     AS level,
    round(avg(j.prior_final), 1)                                   AS prior_level,
    round(avg(j.cur_final) - avg(j.prior_final), 1)                AS momentum,
    round(avg(j.cur_trend), 1)                                     AS trend_level
  FROM joined j
  GROUP BY j.category_top, j.category_mid
  ORDER BY level DESC NULLS LAST;
$$;

-- 사용 예:
--   SELECT * FROM jimscanner_trends_sector_rotation();                       -- top 단위
--   SELECT * FROM jimscanner_trends_sector_rotation(7, 7, true, 'health');   -- health 의 mid 드릴다운
