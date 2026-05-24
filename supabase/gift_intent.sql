-- Gift Modifier Margin Window Board — 2026-05-25
-- 선물·기념일 인텐트 분석: 키워드별 occasion modifier 비중을 산출해 마진 프리미엄 추천에 활용.
--
-- Source:
--   * jimscanner_market_raw (naver_blog / naver_news / google_suggest)
--   * jimscanner_trends_products.canonical_name (alias 텍스트)
-- Vocabulary buckets:
--   선물, 기념일, 집들이, 졸업, 입학, 어버이날, 발렌타인, 화이트데이,
--   빼빼로데이, 생일, 돌잔치, 웨딩
--
-- scripts/compute-gift-intent.mjs 가 주기적으로 채운다.
CREATE TABLE IF NOT EXISTS public.jimscanner_gift_intent_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword text NOT NULL,
  gift_share numeric NOT NULL DEFAULT 0,           -- 0.0 ~ 1.0 (occasion 매칭률)
  occasion_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { "선물": 0.42, "발렌타인": 0.18, ... }
  sample_count int NOT NULL DEFAULT 0,             -- 점수 산출에 사용된 문서 수
  computed_at timestamptz NOT NULL DEFAULT now()
);

-- 키워드별 최신 스냅샷 빠른 조회
CREATE INDEX IF NOT EXISTS idx_gift_intent_keyword_at
  ON public.jimscanner_gift_intent_scores (keyword, computed_at DESC);

-- 보드 정렬용 (gift_share desc)
CREATE INDEX IF NOT EXISTS idx_gift_intent_share_at
  ON public.jimscanner_gift_intent_scores (gift_share DESC, computed_at DESC);

ALTER TABLE public.jimscanner_gift_intent_scores ENABLE ROW LEVEL SECURITY;
-- service_role 전용 — 공개 SELECT 정책 없음.
