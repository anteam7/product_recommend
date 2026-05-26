-- ─────────────────────────────────────────────────────────────
-- 버즈 분포 분석 — Sponsored vs Organic 버즈 판별 게이트
-- ─────────────────────────────────────────────────────────────
-- 문제: market_raw(naver_blog, naver_news, quasarzone_sale) 에 동일 키워드 burst 가
--      광고대행사 paid push 인지 organic 후기·뉴스인지 현재는 구분 안 됨.
-- 가설: 시간분포 첨도(kurtosis) · top1_day 집중도 · cluster lag 으로 판별 가능.
--      sponsored 는 단시간 집중, organic 은 분산.
-- 출력: product_id 별 burst_score + grade ('organic' | 'mixed' | 'sponsored_suspect').
-- 적용: trends_buzz_quality 테이블 일별 적재 (scripts/buzz-quality-classify.mjs).
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_buzz_quality (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,
  window_days int NOT NULL DEFAULT 14,         -- 분석 윈도 (보통 14d)

  sample_count int NOT NULL DEFAULT 0,         -- 윈도 내 매칭 buzz 건수
  unique_days  int NOT NULL DEFAULT 0,         -- 등장 unique day 수

  kurtosis numeric,                            -- 일별 카운트의 첨도 (높을수록 한 날에 집중)
  top1_share numeric,                          -- top-1 day 의 점유율 (0.0~1.0)
  cluster_lag_h numeric,                       -- 첫 등장 → 80% 적재 시점까지의 시간 (시간 단위)
  burst_score numeric,                         -- 종합 burst 강도 (높을수록 sponsored 의심)

  grade text NOT NULL,                         -- 'organic' | 'mixed' | 'sponsored_suspect' | 'insufficient'

  source_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb, -- {naver_blog: 3, naver_news: 5, quasarzone_sale: 2}

  computed_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (product_id, window_days, computed_at)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_buzz_quality_product
  ON jimscanner_trends_buzz_quality(product_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_buzz_quality_grade
  ON jimscanner_trends_buzz_quality(grade, computed_at DESC);

ALTER TABLE jimscanner_trends_buzz_quality ENABLE ROW LEVEL SECURITY;
-- service-role 만 접근 (RLS 정책 정의 X).


-- ─────────────────────────────────────────────────────────────
-- 헬퍼 RPC: 특정 product 의 alias 들과 매칭되는 market_raw 의 captured_at 목록 반환.
-- alias.alias 가 title 또는 query 에 포함된 buzz 만.
-- buzz-quality-classify.mjs 가 client 측에서 시간분포 계산.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_buzz_raw_for_product(
  p_product_id uuid,
  p_window_days int DEFAULT 14
)
RETURNS TABLE (
  source text,
  captured_at timestamptz,
  matched_alias text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH aliases AS (
    SELECT DISTINCT alias
    FROM jimscanner_trends_aliases
    WHERE product_id = p_product_id
      AND length(alias) >= 2
  )
  SELECT DISTINCT
    r.source,
    r.captured_at,
    a.alias AS matched_alias
  FROM jimscanner_market_raw r
  CROSS JOIN aliases a
  WHERE r.source IN ('naver_blog', 'naver_news', 'quasarzone_sale')
    AND r.captured_at > now() - (p_window_days || ' days')::interval
    AND (
      r.title ILIKE '%' || a.alias || '%'
      OR r.query ILIKE '%' || a.alias || '%'
    )
  ORDER BY r.captured_at ASC;
$$;

REVOKE ALL ON FUNCTION jimscanner_buzz_raw_for_product(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_buzz_raw_for_product(uuid, int) TO service_role;


-- ─────────────────────────────────────────────────────────────
-- 일별 distribution view — products/[id] sparkline 패널용.
-- 최근 14일의 일별 buzz 카운트 (source 별 분해).
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_buzz_daily_for_product(
  p_product_id uuid,
  p_window_days int DEFAULT 14
)
RETURNS TABLE (
  day date,
  source text,
  cnt int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH aliases AS (
    SELECT DISTINCT alias
    FROM jimscanner_trends_aliases
    WHERE product_id = p_product_id
      AND length(alias) >= 2
  ),
  matched AS (
    SELECT DISTINCT
      r.id,
      r.source,
      (r.captured_at AT TIME ZONE 'Asia/Seoul')::date AS day
    FROM jimscanner_market_raw r
    CROSS JOIN aliases a
    WHERE r.source IN ('naver_blog', 'naver_news', 'quasarzone_sale')
      AND r.captured_at > now() - (p_window_days || ' days')::interval
      AND (
        r.title ILIKE '%' || a.alias || '%'
        OR r.query ILIKE '%' || a.alias || '%'
      )
  )
  SELECT day, source, COUNT(*)::int AS cnt
  FROM matched
  GROUP BY day, source
  ORDER BY day ASC;
$$;

REVOKE ALL ON FUNCTION jimscanner_buzz_daily_for_product(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_buzz_daily_for_product(uuid, int) TO service_role;
