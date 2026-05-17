-- ────────────────────────────────────────────────────────────
-- Winning-Pin Lookalike 발굴 RPC (2026-05-17)
-- ────────────────────────────────────────────────────────────
-- 검증된 핀(jimscanner_trends_pins)을 기준으로 ggsan 도매 카탈로그에서
-- "유사하지만 아직 미진입(미핀)" 상품을 attribute distance 로 매칭.
--
-- 입력: pin_keyword + pin_source
-- 1) 핀 키워드에 trigram 매칭되는 ggsan 상품 = "winner candidates" 의 프로파일 계산
--    - price_band: avg/min/max price_krw
--    - dominant cate_cd
-- 2) 동일/인접 cate_cd, 유사 price band, 핀과 trigram 거리 멀고(중복 회피),
--    pinned 키워드와 매칭 없는 ggsan 상품 = lookalike 후보
-- 3) 4축 유사도 분해 + composite similarity 반환
--    - category_sim: 동일 cate_cd=1.0 / 인접 (cate_cd 첫 2자리 동일)=0.6 / else=0.0
--    - price_sim: 1 - min(|p - avg|/avg, 1)
--    - supply_sim: ggsan_price_history 기반 가격 인하 추세 + is_imminent 보너스
--    - demand_sim: ggsan_recommend 점수 (있으면) — 없으면 trigram by category top keywords
--
-- 카테고리 인접: ggsan cate_cd 가 3자리 ('001'~'020') — 동일 첫 2자리 매칭 사용
--
-- 의존성: pg_trgm (이미 trends_v4_ggsan.sql 에서 enable)
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_pin_lookalikes(
  pin_keyword text,
  pin_source text DEFAULT NULL,
  top_n int DEFAULT 12,
  min_winner_sim float DEFAULT 0.20
)
RETURNS TABLE (
  goods_no text,
  title text,
  cate_cd text,
  cate_label text,
  price_krw integer,
  is_imminent boolean,
  image_url text,
  detail_url text,
  -- 유사도 분해 (0.0 ~ 1.0)
  category_sim real,
  price_sim real,
  supply_sim real,
  demand_sim real,
  -- composite (가중 평균)
  composite_sim real,
  -- winner 프로파일 (디버깅·UI 설명용)
  winner_avg_price integer,
  winner_dominant_cate text,
  winner_match_count int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  -- 1) 핀 키워드에 매칭되는 ggsan 상품 = "winner candidates"
  winner_products AS (
    SELECT
      gp.goods_no,
      gp.title,
      gp.cate_cd,
      gp.price_krw,
      similarity(pin_keyword, gp.title) AS sim
    FROM jimscanner_ggsan_products gp
    WHERE gp.title % pin_keyword
      AND similarity(pin_keyword, gp.title) >= min_winner_sim
      AND gp.status = 'active'
  ),
  -- 2) winner 프로파일 (avg price + dominant cate)
  winner_profile AS (
    SELECT
      (AVG(price_krw))::int AS avg_price,
      MIN(price_krw)::int AS min_price,
      MAX(price_krw)::int AS max_price,
      (
        SELECT cate_cd
        FROM winner_products
        WHERE cate_cd IS NOT NULL
        GROUP BY cate_cd
        ORDER BY COUNT(*) DESC, SUM(sim) DESC
        LIMIT 1
      ) AS dominant_cate,
      COUNT(*)::int AS winner_match_count
    FROM winner_products
    WHERE price_krw IS NOT NULL
  ),
  -- 3) 이미 다른 핀에 매칭된 ggsan goods_no (제외 대상)
  --    (모든 핀 키워드 vs 모든 ggsan 상품 — trigram > 0.4 이면 already-known)
  pinned_goods AS (
    SELECT DISTINCT gp.goods_no
    FROM jimscanner_trends_pins p
    JOIN jimscanner_ggsan_products gp
      ON gp.title % p.keyword
     AND similarity(p.keyword, gp.title) >= 0.4
  ),
  -- 4) lookalike 후보: winner 와 다른 ggsan 상품
  --    - winner 자신 제외
  --    - 다른 pin 에 이미 매칭된 상품 제외
  --    - active 상태
  --    - cate_cd 또는 인접 cate_cd 동일
  candidates AS (
    SELECT
      gp.goods_no,
      gp.title,
      gp.cate_cd,
      gp.cate_label,
      gp.price_krw,
      gp.is_imminent,
      gp.image_url,
      gp.detail_url,
      wp.avg_price,
      wp.min_price,
      wp.max_price,
      wp.dominant_cate,
      wp.winner_match_count,
      -- category_sim
      (CASE
        WHEN gp.cate_cd = wp.dominant_cate THEN 1.0
        WHEN wp.dominant_cate IS NOT NULL
         AND gp.cate_cd IS NOT NULL
         AND LEFT(gp.cate_cd, 2) = LEFT(wp.dominant_cate, 2) THEN 0.6
        ELSE 0.0
      END)::real AS category_sim,
      -- price_sim (avg 기준 상대 거리)
      (CASE
        WHEN wp.avg_price IS NULL OR wp.avg_price = 0 OR gp.price_krw IS NULL THEN 0.5
        ELSE GREATEST(0.0, 1.0 - LEAST(ABS(gp.price_krw - wp.avg_price)::float / wp.avg_price, 1.0))
      END)::real AS price_sim,
      -- supply_sim: imminent + 가격 인하 추세
      (CASE WHEN gp.is_imminent THEN 0.4 ELSE 0.0 END
       + CASE
           WHEN gp.price_krw IS NULL THEN 0.0
           WHEN gp.price_krw <= COALESCE(wp.avg_price, gp.price_krw) THEN 0.6
           ELSE 0.3
         END
      )::real AS supply_sim,
      -- 핀 키워드와 후보 title 간 trigram (demand 프록시 — 약한 동시언급 신호)
      similarity(pin_keyword, gp.title)::real AS pin_title_sim
    FROM jimscanner_ggsan_products gp
    CROSS JOIN winner_profile wp
    WHERE gp.status = 'active'
      AND gp.goods_no NOT IN (SELECT goods_no FROM winner_products)
      AND gp.goods_no NOT IN (SELECT goods_no FROM pinned_goods)
      AND (
        gp.cate_cd = wp.dominant_cate
        OR (wp.dominant_cate IS NOT NULL
            AND gp.cate_cd IS NOT NULL
            AND LEFT(gp.cate_cd, 2) = LEFT(wp.dominant_cate, 2))
      )
  )
  SELECT
    c.goods_no,
    c.title,
    c.cate_cd,
    c.cate_label,
    c.price_krw,
    c.is_imminent,
    c.image_url,
    c.detail_url,
    c.category_sim,
    c.price_sim,
    LEAST(1.0, c.supply_sim)::real AS supply_sim,
    -- demand_sim: 약한 trigram + imminent 부스트 (LLM 분류·DataLab 가 들어오면 강화)
    LEAST(1.0,
      c.pin_title_sim * 2.0
      + (CASE WHEN c.is_imminent THEN 0.2 ELSE 0.0 END)
    )::real AS demand_sim,
    -- composite: 가중합 (category 0.35 / price 0.25 / supply 0.20 / demand 0.20)
    (0.35 * c.category_sim
     + 0.25 * c.price_sim
     + 0.20 * LEAST(1.0, c.supply_sim)
     + 0.20 * LEAST(1.0, c.pin_title_sim * 2.0 + (CASE WHEN c.is_imminent THEN 0.2 ELSE 0.0 END))
    )::real AS composite_sim,
    c.avg_price AS winner_avg_price,
    c.dominant_cate AS winner_dominant_cate,
    c.winner_match_count
  FROM candidates c
  WHERE c.winner_match_count > 0
  ORDER BY
    (0.35 * c.category_sim
     + 0.25 * c.price_sim
     + 0.20 * LEAST(1.0, c.supply_sim)
     + 0.20 * LEAST(1.0, c.pin_title_sim * 2.0 + (CASE WHEN c.is_imminent THEN 0.2 ELSE 0.0 END))
    ) DESC,
    c.is_imminent DESC
  LIMIT top_n;
$$;

REVOKE ALL ON FUNCTION jimscanner_pin_lookalikes(text, text, int, float) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_pin_lookalikes(text, text, int, float) TO service_role;


-- 편의용 뷰: 모든 핀 × top 5 후보 (대시보드 요약용)
-- 핀 수가 많아지면 비싸짐 — 페이지 단위 호출에선 RPC 직접 호출 권장
CREATE OR REPLACE VIEW jimscanner_pin_lookalike_candidates AS
SELECT
  p.keyword AS pin_keyword,
  p.source AS pin_source,
  p.pinned_at,
  la.goods_no,
  la.title,
  la.cate_cd,
  la.cate_label,
  la.price_krw,
  la.is_imminent,
  la.image_url,
  la.detail_url,
  la.category_sim,
  la.price_sim,
  la.supply_sim,
  la.demand_sim,
  la.composite_sim,
  la.winner_avg_price,
  la.winner_dominant_cate,
  la.winner_match_count
FROM jimscanner_trends_pins p
CROSS JOIN LATERAL jimscanner_pin_lookalikes(p.keyword, p.source, 5, 0.20) la;

GRANT SELECT ON jimscanner_pin_lookalike_candidates TO service_role;
