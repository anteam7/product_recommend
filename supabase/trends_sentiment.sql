-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 — 커뮤니티 감성×언급량 매트릭스 (2026-05-15)
-- ─────────────────────────────────────────────────────────────
-- 목적: jimscanner_market_raw + jimscanner_trends_raw 의 커뮤니티/블로그/뉴스
--       페이로드에서 상품·키워드별 언급 sentiment 를 추출.
--       claim_risk (환불/고장/사기/배송지연 등) 가 도배되는 상품을
--       위탁 후보에서 사전 차단하기 위한 데이터셋.
--
-- 노출 정책: service_role only (RLS enable, no public policy).
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_sentiment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  -- 상품 매핑이 안 된 raw mention 도 일단 저장 (keyword level)
  keyword text,

  source text NOT NULL,                 -- '82cook' | 'natepan' | 'dcinside' | 'ppomppu' | 'naver_blog' | 'naver_news' | 'clien_park' | 'quasarzone_sale' | ...

  -- 윈도 집계 (예: 시간 단위 / 일 단위)
  window_start timestamptz NOT NULL,
  window_end   timestamptz NOT NULL,

  mention_count int NOT NULL DEFAULT 0,
  pos_count     int NOT NULL DEFAULT 0,
  neu_count     int NOT NULL DEFAULT 0,
  neg_count     int NOT NULL DEFAULT 0,
  claim_count   int NOT NULL DEFAULT 0,   -- claim_risk (환불/고장/사기 등)

  pos_ratio numeric NOT NULL DEFAULT 0,   -- 0~1
  neg_ratio numeric NOT NULL DEFAULT 0,
  claim_ratio numeric NOT NULL DEFAULT 0,

  claim_keywords text[] NOT NULL DEFAULT '{}',  -- ['환불 안 됨','짝퉁','고장','배송지연',...]
  sample_sentences jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{text, label, source_url}]

  classified_by text,                    -- 'manual' | 'llm_haiku' | 'rule_engine'
  model text,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT jimscanner_trends_sentiment_window_chk CHECK (window_end >= window_start)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_sentiment_product_window
  ON jimscanner_trends_sentiment(product_id, window_end DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_sentiment_keyword_window
  ON jimscanner_trends_sentiment(keyword, window_end DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_sentiment_source_window
  ON jimscanner_trends_sentiment(source, window_end DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_sentiment_claim
  ON jimscanner_trends_sentiment(claim_ratio DESC, mention_count DESC)
  WHERE claim_ratio > 0.1;

ALTER TABLE jimscanner_trends_sentiment ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.


-- ─────────────────────────────────────────────────────────────
-- 처리 진척 추적: raw row 가 sentiment 분류에 사용됐는지 마킹.
-- jimscanner_market_raw 는 processed 컬럼이 이미 있지만 다른 파이프라인이 쓰니까
-- sentiment 전용 별도 ledger 로 분리한다.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jimscanner_trends_sentiment_processed (
  raw_table text NOT NULL,             -- 'jimscanner_market_raw' | 'jimscanner_trends_raw'
  raw_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  sentiment_count int NOT NULL DEFAULT 0,
  PRIMARY KEY (raw_table, raw_id)
);

ALTER TABLE jimscanner_trends_sentiment_processed ENABLE ROW LEVEL SECURITY;


-- ─────────────────────────────────────────────────────────────
-- 최신 sentiment 요약 뷰 (per product, latest window).
-- /admin/trend-radar/sentiment scatter 가 직접 쓴다.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW jimscanner_trends_sentiment_latest AS
SELECT DISTINCT ON (s.product_id)
  s.product_id,
  s.window_end,
  s.window_start,
  s.mention_count,
  s.pos_count,
  s.neg_count,
  s.claim_count,
  s.pos_ratio,
  s.neg_ratio,
  s.claim_ratio,
  s.claim_keywords,
  s.sample_sentences
FROM jimscanner_trends_sentiment s
WHERE s.product_id IS NOT NULL
ORDER BY s.product_id, s.window_end DESC;
