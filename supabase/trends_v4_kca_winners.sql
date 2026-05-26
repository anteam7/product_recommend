-- ────────────────────────────────────────────────────────────
-- PR-KCA-WINNERS: 한국소비자원 비교공감 Winner 마이닝 (2026-05-26)
-- ────────────────────────────────────────────────────────────
-- 한국소비자원 비교공감은 카테고리별 제품 성능·안전 비교 결과를
-- 매월 발표한다. '소비자원 1위 [카테고리]' 트래픽이 발표 후 3-6개월
-- 지속되므로, 이 발표를 SKU 단위로 정형화해 ggsan 위탁 카탈로그 +
-- 검색 트렌드와 3중 게이트로 진입 후보를 도출한다.
--
-- 호출 흐름:
--   /api/cron/collect-kca-comparative  (Vercel cron, KST 03:30)
--     → jimscanner_market_raw  (게시판 row 적재, source='kca_comparative')
--     → jimscanner_kca_winners (LLM 후 정형 SKU 적재 — 본 테이블)
--
-- jimscanner_kca_winners 는 LLM 정형화 후 입력. 본 마이그레이션에서는
-- 스키마만 정의하고, 실제 LLM 추출은 후속 PR.
-- ────────────────────────────────────────────────────────────

-- 1) 정부 인증 SKU (비교공감 1~3위 발표)
CREATE TABLE IF NOT EXISTS jimscanner_kca_winners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 발표 메타
  announcement_date date NOT NULL,           -- 게시판 게시일 (YYYY-MM-DD)
  source_url text NOT NULL,                  -- 비교공감 상세 URL
  external_id text NOT NULL,                 -- KCA 게시판 no
  comparison_topic text NOT NULL,            -- '수면 영양제 비교', '미세먼지 마스크 비교' 등
  category_top text,                         -- 'health' | 'living' | 'digital' | 'beauty' | 'food'
  category_mid text,                         -- 5-10자 한국어 ('수면영양제', '유산균')

  -- Winner SKU
  rank int NOT NULL CHECK (rank BETWEEN 1 AND 5),  -- 1=1위, 2=2위, 3=3위 (4-5 백업)
  brand text NOT NULL,
  model text,                                -- 모델명 (있으면)
  full_name text NOT NULL,                   -- 원문 그대로 '브랜드 모델'

  -- 평가 차원 (LLM 추출, JSON)
  -- 예: {"흡수율": "92%", "함량": "1mg", "원료": "식물성", "수상_차원": "안전성·효능 1위"}
  evaluation_dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- SEO 핸들 (소비자원 1위 키워드 자동 생성)
  -- 예: '소비자원 1위 수면영양제', '비교공감 미세먼지 마스크 1위'
  seo_handle text,

  -- 추천 진입 창 (발표일 + 3-6개월)
  trust_signal_until date,                   -- announcement_date + 180일 기본

  -- 원본 보존
  raw_excerpt text,                          -- LLM 입력으로 사용한 본문 발췌
  llm_extracted_at timestamptz,
  llm_model text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_kca_winner UNIQUE (external_id, rank, full_name)
);

CREATE INDEX IF NOT EXISTS jimscanner_kca_winners_announced
  ON jimscanner_kca_winners(announcement_date DESC);
CREATE INDEX IF NOT EXISTS jimscanner_kca_winners_category
  ON jimscanner_kca_winners(category_mid, announcement_date DESC);
CREATE INDEX IF NOT EXISTS jimscanner_kca_winners_active
  ON jimscanner_kca_winners(trust_signal_until DESC)
  WHERE trust_signal_until >= current_date;
CREATE INDEX IF NOT EXISTS jimscanner_kca_winners_full_name_trgm
  ON jimscanner_kca_winners USING gin (full_name gin_trgm_ops);

ALTER TABLE jimscanner_kca_winners ENABLE ROW LEVEL SECURITY;
-- service_role 만.

-- updated_at 트리거
CREATE OR REPLACE FUNCTION jimscanner_kca_winners_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_kca_winners_updated_at ON jimscanner_kca_winners;
CREATE TRIGGER jimscanner_kca_winners_updated_at
  BEFORE UPDATE ON jimscanner_kca_winners
  FOR EACH ROW EXECUTE FUNCTION jimscanner_kca_winners_set_updated_at();


-- 2) 3중 게이트 RPC — KCA 1위 + ggsan 위탁 가능 + 검색량 상승
-- 결과: 발표일 + 승자 SKU + ggsan 매칭(있으면) + 검색 시그널(있으면)
CREATE OR REPLACE FUNCTION jimscanner_kca_winners_matched(
  days_window int DEFAULT 180,
  min_sim numeric DEFAULT 0.20,
  trend_days int DEFAULT 30,
  active_only boolean DEFAULT true
)
RETURNS TABLE (
  winner_id uuid,
  announcement_date date,
  comparison_topic text,
  category_mid text,
  rank int,
  brand text,
  full_name text,
  evaluation_dimensions jsonb,
  seo_handle text,
  trust_signal_until date,
  source_url text,

  ggsan_goods_no text,
  ggsan_title text,
  ggsan_price_krw int,
  ggsan_detail_url text,
  ggsan_image_url text,
  ggsan_is_imminent boolean,
  sim real,

  trend_keyword text,
  trend_volume numeric,
  trend_source text,
  trend_collected_at timestamptz
)
LANGUAGE sql STABLE AS $$
  WITH w AS (
    SELECT *
    FROM jimscanner_kca_winners
    WHERE announcement_date >= current_date - (days_window || ' days')::interval
      AND (NOT active_only OR trust_signal_until IS NULL OR trust_signal_until >= current_date)
  ),
  g AS (
    SELECT
      w.id AS winner_id,
      g.goods_no,
      g.title,
      g.price_krw,
      g.detail_url,
      g.image_url,
      g.is_imminent,
      similarity(w.full_name, g.title) AS sim,
      ROW_NUMBER() OVER (
        PARTITION BY w.id
        ORDER BY similarity(w.full_name, g.title) DESC
      ) AS rn
    FROM w
    JOIN jimscanner_ggsan_products g
      ON g.title % w.full_name
     AND similarity(w.full_name, g.title) >= min_sim
  ),
  t AS (
    SELECT
      w.id AS winner_id,
      k.keyword,
      k.volume_relative,
      k.source,
      k.collected_at,
      ROW_NUMBER() OVER (
        PARTITION BY w.id
        ORDER BY k.collected_at DESC
      ) AS rn
    FROM w
    JOIN jimscanner_trends_keywords k
      ON (k.keyword ILIKE '%' || w.category_mid || '%'
          OR k.keyword ILIKE '%' || w.brand || '%')
     AND k.collected_at >= now() - (trend_days || ' days')::interval
  )
  SELECT
    w.id,
    w.announcement_date,
    w.comparison_topic,
    w.category_mid,
    w.rank,
    w.brand,
    w.full_name,
    w.evaluation_dimensions,
    w.seo_handle,
    w.trust_signal_until,
    w.source_url,

    g.goods_no,
    g.title,
    g.price_krw,
    g.detail_url,
    g.image_url,
    g.is_imminent,
    g.sim,

    t.keyword,
    t.volume_relative,
    t.source,
    t.collected_at
  FROM w
  LEFT JOIN g ON g.winner_id = w.id AND g.rn = 1
  LEFT JOIN t ON t.winner_id = w.id AND t.rn = 1
  ORDER BY w.announcement_date DESC, w.rank ASC;
$$;
