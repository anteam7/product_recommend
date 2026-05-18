-- ────────────────────────────────────────────────────────────
-- ggsan 임박 전환 속도 (depletion velocity) — 공급사 선행지표 보드
-- (2026-05-18, PR: ggsan-depletion-velocity-v0)
-- ────────────────────────────────────────────────────────────
-- 배경: jimscanner_ggsan_products.is_imminent 는 단일 시점 스냅샷이라
--   "다른 셀러들이 도매에서 얼마나 빠르게 쓸어담는가" 라는 시계열 신호를 못 본다.
-- 이 마이그레이션은 ggsan refresh cron 매 실행마다 모든 SKU 의 상태를
-- jimscanner_ggsan_snapshots 에 기록하고, 매일 머터리얼라이즈드 뷰로
-- depletion_velocity 와 imminent_streak 를 산출한다.
-- ────────────────────────────────────────────────────────────

-- 1) 스냅샷 테이블 — 매 refresh 마다 모든 SKU upsert
CREATE TABLE IF NOT EXISTS jimscanner_ggsan_snapshots (
  goods_no text NOT NULL REFERENCES jimscanner_ggsan_products(goods_no) ON DELETE CASCADE,
  captured_at timestamptz NOT NULL DEFAULT now(),
  is_imminent boolean NOT NULL DEFAULT false,
  price_krw integer,
  stock_label text,                       -- 원본 재고 라벨 ('충분','적음','품절' 등 — 가용 시 collector 에서 채움)
  status text,                            -- 'active' | 'sold_out' | 'imminent' | 'removed'
  PRIMARY KEY (goods_no, captured_at)
);

CREATE INDEX IF NOT EXISTS jimscanner_ggsan_snapshots_captured
  ON jimscanner_ggsan_snapshots(captured_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_ggsan_snapshots_imminent_captured
  ON jimscanner_ggsan_snapshots(goods_no, captured_at DESC) WHERE is_imminent;

ALTER TABLE jimscanner_ggsan_snapshots ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role) 만.


-- 2) collector 가 호출하는 헬퍼: 현재 카탈로그 전체를 스냅샷으로 떠서 한 번에 적재
CREATE OR REPLACE FUNCTION jimscanner_ggsan_snapshot_now()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  inserted_count integer;
  ts timestamptz := now();
BEGIN
  INSERT INTO jimscanner_ggsan_snapshots(goods_no, captured_at, is_imminent, price_krw, stock_label, status)
  SELECT
    gp.goods_no,
    ts,
    COALESCE(gp.is_imminent, false),
    gp.price_krw,
    NULL::text,
    COALESCE(gp.status, 'active')
  FROM jimscanner_ggsan_products gp
  ON CONFLICT (goods_no, captured_at) DO NOTHING;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

REVOKE ALL ON FUNCTION jimscanner_ggsan_snapshot_now() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_ggsan_snapshot_now() TO service_role;


-- 3) 머터리얼라이즈드 뷰: SKU 별 depletion velocity + imminent streak
-- depletion_velocity =
--   최근 21일 윈도우 안에서 "false → true" 임박 전환이 발생한 경우
--   "1 / (전환까지 걸린 일수)" 의 7일 이동평균. 빠를수록 높음.
-- imminent_streak = 가장 최근 연속 임박 일수.
CREATE MATERIALIZED VIEW IF NOT EXISTS jimscanner_ggsan_depletion_mv AS
WITH daily AS (
  -- 일자별로 SKU 당 최신 상태만 (마지막 스냅샷)
  SELECT DISTINCT ON (goods_no, (captured_at AT TIME ZONE 'Asia/Seoul')::date)
    goods_no,
    (captured_at AT TIME ZONE 'Asia/Seoul')::date AS day,
    is_imminent,
    price_krw,
    captured_at
  FROM jimscanner_ggsan_snapshots
  WHERE captured_at > now() - interval '60 days'
  ORDER BY goods_no, (captured_at AT TIME ZONE 'Asia/Seoul')::date, captured_at DESC
),
transitions AS (
  -- 직전 일자 대비 false→true 전환 탐지
  SELECT
    goods_no,
    day,
    is_imminent,
    LAG(is_imminent) OVER (PARTITION BY goods_no ORDER BY day) AS prev_imminent,
    LAG(day) OVER (PARTITION BY goods_no ORDER BY day) AS prev_day
  FROM daily
),
flips AS (
  SELECT
    goods_no,
    day AS imminent_at,
    (day - prev_day)::int AS days_to_imminent
  FROM transitions
  WHERE prev_imminent IS FALSE AND is_imminent IS TRUE AND prev_day IS NOT NULL
),
velocity AS (
  -- 최근 21일 안의 전환만 채택, 1/days_to_imminent 의 7일 가중 평균 근사 (단순 평균으로 시작)
  SELECT
    goods_no,
    AVG(1.0 / GREATEST(days_to_imminent, 1))::real AS depletion_velocity,
    COUNT(*)::int AS flips_21d,
    MAX(imminent_at) AS last_flip_at
  FROM flips
  WHERE imminent_at > (now() AT TIME ZONE 'Asia/Seoul')::date - 21
  GROUP BY goods_no
),
recent_state AS (
  -- 가장 최근 일자 + 직전 일자 비교용 정렬
  SELECT
    goods_no,
    day,
    is_imminent,
    ROW_NUMBER() OVER (PARTITION BY goods_no ORDER BY day DESC) AS rn
  FROM daily
),
streak AS (
  -- 최근 연속 imminent=true 일수
  SELECT
    goods_no,
    COUNT(*)::int AS imminent_streak
  FROM (
    SELECT
      goods_no,
      day,
      is_imminent,
      SUM(CASE WHEN is_imminent THEN 0 ELSE 1 END)
        OVER (PARTITION BY goods_no ORDER BY day DESC) AS reset_flag
    FROM daily
  ) t
  WHERE is_imminent AND reset_flag = 0
  GROUP BY goods_no
),
latest AS (
  SELECT goods_no, is_imminent AS is_imminent_now, day AS latest_day
  FROM recent_state WHERE rn = 1
)
SELECT
  gp.goods_no,
  gp.title,
  gp.cate_cd,
  gp.cate_label,
  gp.brand,
  gp.price_krw,
  gp.image_url,
  gp.detail_url,
  gp.is_imminent AS is_imminent_current,
  COALESCE(v.depletion_velocity, 0)::real AS depletion_velocity,
  COALESCE(v.flips_21d, 0) AS flips_21d,
  v.last_flip_at,
  COALESCE(s.imminent_streak, 0) AS imminent_streak,
  l.latest_day,
  -- 최종 점수: velocity*1.0 + streak*0.05 (streak 보너스)
  (COALESCE(v.depletion_velocity, 0) + COALESCE(s.imminent_streak, 0) * 0.05)::real AS depletion_velocity_score
FROM jimscanner_ggsan_products gp
LEFT JOIN velocity v ON v.goods_no = gp.goods_no
LEFT JOIN streak s ON s.goods_no = gp.goods_no
LEFT JOIN latest l ON l.goods_no = gp.goods_no;

CREATE UNIQUE INDEX IF NOT EXISTS jimscanner_ggsan_depletion_mv_goods_no
  ON jimscanner_ggsan_depletion_mv(goods_no);
CREATE INDEX IF NOT EXISTS jimscanner_ggsan_depletion_mv_velocity
  ON jimscanner_ggsan_depletion_mv(depletion_velocity_score DESC);
CREATE INDEX IF NOT EXISTS jimscanner_ggsan_depletion_mv_cate
  ON jimscanner_ggsan_depletion_mv(cate_cd);


-- 4) 매일 배치로 호출: REFRESH MATERIALIZED VIEW CONCURRENTLY
CREATE OR REPLACE FUNCTION jimscanner_ggsan_depletion_refresh()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY jimscanner_ggsan_depletion_mv;
EXCEPTION WHEN OTHERS THEN
  -- CONCURRENTLY 실패 시 일반 REFRESH 폴백 (최초 1회 빈 MV 일 때)
  REFRESH MATERIALIZED VIEW jimscanner_ggsan_depletion_mv;
END;
$$;

REVOKE ALL ON FUNCTION jimscanner_ggsan_depletion_refresh() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_ggsan_depletion_refresh() TO service_role;


-- 5) 카테고리 burn-rate (히트맵용) — view 로 가볍게
CREATE OR REPLACE VIEW jimscanner_ggsan_depletion_by_cate AS
SELECT
  cate_cd,
  cate_label,
  COUNT(*)::int AS sku_count,
  AVG(depletion_velocity)::real AS avg_velocity,
  SUM(CASE WHEN is_imminent_current THEN 1 ELSE 0 END)::int AS imminent_now,
  SUM(flips_21d)::int AS total_flips_21d
FROM jimscanner_ggsan_depletion_mv
GROUP BY cate_cd, cate_label;


-- 6) jimscanner_ggsan_recommend RPC 확장:
--    depletion_velocity_score 컬럼 추가 + final_score 가중치 합산.
DROP FUNCTION IF EXISTS jimscanner_ggsan_recommend(int, float, float, int);

CREATE OR REPLACE FUNCTION jimscanner_ggsan_recommend(
  days_window int DEFAULT 30,
  min_sim float DEFAULT 0.20,
  min_score float DEFAULT 0.5,
  result_limit int DEFAULT 100
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
  depletion_velocity_score real,
  final_score real,
  tv_match_count int,
  tv_top_keyword text,
  tv_total_pushes int,
  search_match_count int,
  search_top_keyword text,
  search_sources text[]
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
  -- 신규: depletion velocity (재고 소진 속도)
  vel AS (
    SELECT goods_no, depletion_velocity_score
    FROM jimscanner_ggsan_depletion_mv
  ),
  scored AS (
    SELECT
      gp.goods_no, gp.title, gp.cate_cd, gp.cate_label, gp.price_krw,
      gp.is_imminent, gp.image_url, gp.detail_url, gp.last_seen_at,
      COALESCE(tv.tv_score, 0)::real AS tv_score,
      COALESCE(s.search_score, 0)::real AS search_score,
      COALESCE(v.depletion_velocity_score, 0)::real AS dvs,
      COALESCE(tv.tv_match_count, 0) AS tv_match_count,
      COALESCE(tv.tv_top_keyword, '') AS tv_top_keyword,
      COALESCE(tv.tv_total_pushes, 0) AS tv_total_pushes,
      COALESCE(s.search_match_count, 0) AS search_match_count,
      COALESCE(s.search_top_keyword, '') AS search_top_keyword,
      COALESCE(s.search_sources, ARRAY[]::text[]) AS search_sources
    FROM jimscanner_ggsan_products gp
    LEFT JOIN tv_agg tv ON tv.goods_no = gp.goods_no
    LEFT JOIN search_agg s ON s.goods_no = gp.goods_no
    LEFT JOIN vel v ON v.goods_no = gp.goods_no
    WHERE tv.tv_score IS NOT NULL OR s.search_score IS NOT NULL OR v.depletion_velocity_score > 0
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
    (s.tv_score * 1.5 + s.search_score * 1.0)::real AS raw_score,
    (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)::real AS imminent_bonus,
    s.dvs AS depletion_velocity_score,
    (
      ((s.tv_score * 1.5 + s.search_score * 1.0)
        * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END))
      + s.dvs * 2.0
    )::real AS final_score,
    s.tv_match_count,
    s.tv_top_keyword,
    s.tv_total_pushes,
    s.search_match_count,
    s.search_top_keyword,
    s.search_sources
  FROM scored s
  WHERE (
    ((s.tv_score * 1.5 + s.search_score * 1.0)
      * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END))
    + s.dvs * 2.0
  ) >= min_score
  ORDER BY
    (CASE WHEN s.is_imminent THEN 1 ELSE 0 END) DESC,
    (
      ((s.tv_score * 1.5 + s.search_score * 1.0)
        * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END))
      + s.dvs * 2.0
    ) DESC
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_ggsan_recommend(int, float, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_ggsan_recommend(int, float, float, int) TO service_role;
