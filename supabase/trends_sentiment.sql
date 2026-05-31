-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 — 커뮤니티 감성 극성 게이트 (2026-06-01)
-- ─────────────────────────────────────────────────────────────
-- 커뮤니티 소스(82cook/natepan/dcinside/ppomppu)의 게시글 제목 텍스트는
-- 현재 키워드 추출에만 쓰이고 '왜 회자되는가'의 감정 극성은 버려진다.
-- 본 테이블은 각 상품의 커뮤니티 언급을 극성으로 라벨링해 적재한다:
--   · positive: 추천/만족/입소문    → 우선 소싱
--   · negative: 불만/하자/환불/AS   → 위탁 위험 게이트로 차단
--   · neutral : 정보/질문
--
-- 노출 정책: RLS enable + 정책 정의 X = service-role 만 접근 (기존 패턴 동일).
-- 관련 스크립트: scripts/classify-trends-llm.mjs (sentiment pass)
-- 관련 보드: /admin/trend-radar/sentiment
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_sentiment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  polarity text NOT NULL,            -- 'positive' | 'negative' | 'neutral'
  defect_terms text[] NOT NULL DEFAULT '{}',  -- 하자 키워드 (고장·반품·터짐·환불·AS 등)
  evidence_snippet text,             -- 근거 스니펫 (LLM 이 인용한 커뮤니티 텍스트)
  source text,                       -- 'natepan_ranking' | '82cook_talk' | ... (대표 소스)

  mention_count int NOT NULL DEFAULT 0,        -- 라벨링에 사용된 커뮤니티 언급 수
  classified_by text,                          -- 'claude-code-cli' 등

  computed_at timestamptz NOT NULL DEFAULT now()
);

-- UI 는 (product_id, MAX(computed_at)) 으로 최신 극성 조회.
CREATE INDEX IF NOT EXISTS jimscanner_trends_sentiment_product_at
  ON jimscanner_trends_sentiment(product_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_sentiment_polarity_at
  ON jimscanner_trends_sentiment(polarity, computed_at DESC);

ALTER TABLE jimscanner_trends_sentiment ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.
