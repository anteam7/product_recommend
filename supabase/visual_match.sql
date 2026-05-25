-- ────────────────────────────────────────────────────────────
-- 비주얼 소싱 브릿지 — ggsan 도매 이미지 ↔ KR SERP 썸네일 매칭
-- (Improvement-Scout 2026-05-25)
-- ────────────────────────────────────────────────────────────
-- 목적:
--   ggsan(jimscanner_ggsan_products.image_url) 의 CLIP 임베딩과
--   쿠팡/네이버쇼핑 상위 SERP 썸네일 CLIP 임베딩을 비교해
--   cosine similarity ≥ 0.85 인 페어를 적재.
--   텍스트 alias 매핑(jimscanner_trends_aliases)이 못 잡는
--   OEM 동일품 / 브랜드 리네이밍을 시각 신호로 보강.
--
-- 노출 정책: 기존 jimscanner_* 패턴과 동일 — RLS enable, policy 없음 → service-role 만.
-- 수집: WSL collector (fetch_serp_thumbnails.mjs + embed_clip.py).
--       임베딩(vector(512)) 은 collector 측에서 채움.
-- ────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS vector;

-- 1) ggsan 상품 이미지 임베딩 캐시 (1:1)
CREATE TABLE IF NOT EXISTS jimscanner_ggsan_image_embeddings (
  goods_no       text PRIMARY KEY REFERENCES jimscanner_ggsan_products(goods_no) ON DELETE CASCADE,
  image_url      text NOT NULL,
  embedding      vector(512),                  -- CLIP ViT-B/32
  model_version  text NOT NULL DEFAULT 'clip-vit-b32',
  computed_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE jimscanner_ggsan_image_embeddings ENABLE ROW LEVEL SECURITY;

-- 2) KR SERP 상위 노출 썸네일 + 임베딩
CREATE TABLE IF NOT EXISTS jimscanner_serp_thumbnails (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  marketplace     text NOT NULL,               -- 'coupang' | 'naver_shopping' | 'gmarket' 등
  query           text NOT NULL,               -- SERP 추출 키워드
  market_url      text NOT NULL,               -- 상품 상세 URL
  thumbnail_url   text NOT NULL,
  title           text,
  market_price_krw integer,
  review_count    integer,
  market_rank     integer,                     -- SERP 노출 순위 (1=top)
  embedding       vector(512),
  model_version   text NOT NULL DEFAULT 'clip-vit-b32',
  observed_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (marketplace, market_url, query)
);

CREATE INDEX IF NOT EXISTS jimscanner_serp_thumbnails_query_rank
  ON jimscanner_serp_thumbnails(query, marketplace, market_rank);
CREATE INDEX IF NOT EXISTS jimscanner_serp_thumbnails_observed
  ON jimscanner_serp_thumbnails(observed_at DESC);

ALTER TABLE jimscanner_serp_thumbnails ENABLE ROW LEVEL SECURITY;

-- 3) 매칭 결과 (코사인 유사도 ≥ 0.85)
CREATE TABLE IF NOT EXISTS jimscanner_visual_match (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goods_no         text NOT NULL REFERENCES jimscanner_ggsan_products(goods_no) ON DELETE CASCADE,
  marketplace      text NOT NULL,
  market_url       text NOT NULL,
  thumbnail_url    text,
  title            text,
  market_price_krw integer,
  review_count     integer,
  market_rank      integer,
  similarity       numeric(5,4) NOT NULL,      -- 0.0000 ~ 1.0000
  observed_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (goods_no, marketplace, market_url)
);

CREATE INDEX IF NOT EXISTS jimscanner_visual_match_goods
  ON jimscanner_visual_match(goods_no, similarity DESC);
CREATE INDEX IF NOT EXISTS jimscanner_visual_match_marketplace_rank
  ON jimscanner_visual_match(marketplace, market_rank);
CREATE INDEX IF NOT EXISTS jimscanner_visual_match_observed
  ON jimscanner_visual_match(observed_at DESC);

ALTER TABLE jimscanner_visual_match ENABLE ROW LEVEL SECURITY;


-- 4) 어드민 보드용 집계 뷰
--    각 ggsan 상품별: 시장 최저가, 최고가, 매치 수, 평균 유사도, 즉시 마진(% / 원)
CREATE OR REPLACE VIEW jimscanner_visual_bridge_board AS
SELECT
  p.goods_no,
  p.title              AS ggsan_title,
  p.cate_label,
  p.image_url          AS ggsan_image_url,
  p.price_krw          AS wholesale_krw,
  p.is_imminent,
  p.last_changed_at,
  COUNT(m.id)::int                                    AS match_count,
  MIN(m.market_price_krw)                             AS market_min_krw,
  MAX(m.market_price_krw)                             AS market_max_krw,
  ROUND(AVG(m.market_price_krw))::int                 AS market_avg_krw,
  ROUND(AVG(m.similarity)::numeric, 4)                AS avg_similarity,
  MAX(m.observed_at)                                  AS last_match_at,
  -- 즉시 마진 (시장 최저가 − 도매가)
  CASE
    WHEN MIN(m.market_price_krw) IS NULL OR p.price_krw IS NULL OR p.price_krw = 0 THEN NULL
    ELSE MIN(m.market_price_krw) - p.price_krw
  END                                                 AS margin_krw,
  CASE
    WHEN MIN(m.market_price_krw) IS NULL OR p.price_krw IS NULL OR p.price_krw = 0 THEN NULL
    ELSE ROUND(((MIN(m.market_price_krw) - p.price_krw)::numeric * 100.0) / p.price_krw, 1)
  END                                                 AS margin_pct,
  -- 가격 분산: max/min 비율 (1.0 평탄 → 레드오션 / 큼 → 가격 다양 → 기회)
  CASE
    WHEN MIN(m.market_price_krw) IS NULL OR MIN(m.market_price_krw) = 0 THEN NULL
    ELSE ROUND(MAX(m.market_price_krw)::numeric / MIN(m.market_price_krw)::numeric, 2)
  END                                                 AS price_spread_ratio
FROM jimscanner_ggsan_products p
LEFT JOIN jimscanner_visual_match m ON m.goods_no = p.goods_no
GROUP BY p.goods_no, p.title, p.cate_label, p.image_url, p.price_krw, p.is_imminent, p.last_changed_at;

COMMENT ON VIEW jimscanner_visual_bridge_board IS
  'ggsan 도매 × KR SERP 비주얼 매치 집계. /admin/trend-radar/visual-bridge 보드 source.';
