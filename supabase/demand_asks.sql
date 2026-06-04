-- ─────────────────────────────────────────────────────────────
-- 커뮤니티 '추천 좀' 요청 마이닝 → 군중추천 위너 발굴 (2026-06-04)
-- ─────────────────────────────────────────────────────────────
-- 목적: 82cook·natepan·ppomppu·clien·dcinside 등 토론형 커뮤니티의
--   '~추천해주세요/추천 좀/뭐가 좋아요/공구 어디서' 류 명시적 구매탐색 글에서
--   (1) 어떤 카테고리/상품에 추천요청이 반복되는지(=미해결 능동수요)
--   (2) 그 글 댓글에서 실제로 추천받는 상품명(군중이 검증한 위너)
--   을 동시에 추출해 적재한다.
--
-- 파이프라인:
--   collect-* 크론이 market_raw 에 ask 패턴 글 적재(metadata.is_demand_ask)
--   → extract-demand-asks 크론이 본문/댓글 fetch + Gemini 추출
--   → 아래 두 테이블에 누적
--   → /admin/trend-radar/demand-asks 에서 랭킹·리더보드 표시
--
-- 노출 정책: RLS enable + 정책 정의 X = service-role 만 접근.
--   (기존 jimscanner_trends_* / jimscanner_market_* 패턴과 동일)
-- ─────────────────────────────────────────────────────────────


-- 1) 반복되는 '추천요청' (정규화된 수요 단위)
--    같은 의도의 요청들이 ask_text(canonical) 로 묶임.
--    예: ask_text="차량용 무선 청소기 추천", category="디지털/가전"
CREATE TABLE IF NOT EXISTS public.jimscanner_trends_demand_asks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  ask_text text NOT NULL,                         -- LLM 정규화된 요청 의도 (canonical)
  category text,                                  -- '건강식품' | '생활/리빙' | '디지털/가전' | '뷰티' | '식품' | ...
  ask_count int NOT NULL DEFAULT 1,               -- 이 요청이 반복 등장한 횟수 (=능동수요 강도)
  source_mix jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {"clien_park": 3, "ppomppu": 2, ...} 수집원별 카운트
  raw_ids uuid[] NOT NULL DEFAULT '{}',           -- 근거가 된 market_raw.id 들

  example_title text,                             -- 대표 원문 제목 (UI 표시용)
  example_url text,                               -- 대표 원문 링크

  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (ask_text)
);

CREATE INDEX IF NOT EXISTS idx_demand_asks_count
  ON public.jimscanner_trends_demand_asks (ask_count DESC, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_demand_asks_category
  ON public.jimscanner_trends_demand_asks (category) WHERE category IS NOT NULL;

ALTER TABLE public.jimscanner_trends_demand_asks ENABLE ROW LEVEL SECURITY;


-- 2) 요청 글 댓글에서 추출된 추천 상품 (군중이 골라준 위너)
--    한 ask 에 여러 추천 상품 row.
CREATE TABLE IF NOT EXISTS public.jimscanner_ask_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ask_id uuid NOT NULL REFERENCES public.jimscanner_trends_demand_asks(id) ON DELETE CASCADE,

  asked_product text,                             -- 어떤 요청에 대한 답인지 (ask_text 사본 — 디버깅/조인 편의)
  recommended_name text NOT NULL,                 -- 댓글에서 추천된 상품/브랜드명 (정규화)
  mention_count int NOT NULL DEFAULT 1,           -- 댓글에서 언급된 횟수 (=군중 합의 강도)
  sentiment text,                                 -- 'positive' | 'neutral' | 'mixed' | 'negative'

  -- ggsan/도매 소싱 연결 (매칭 후 채워짐)
  matched_product_id uuid REFERENCES public.jimscanner_trends_products(id) ON DELETE SET NULL,
  matched_goods_no text,                          -- ggsan goods_no (매칭 시)

  raw_ids uuid[] NOT NULL DEFAULT '{}',
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (ask_id, recommended_name)
);

CREATE INDEX IF NOT EXISTS idx_ask_reco_ask
  ON public.jimscanner_ask_recommendations (ask_id, mention_count DESC);
CREATE INDEX IF NOT EXISTS idx_ask_reco_name
  ON public.jimscanner_ask_recommendations (recommended_name);

ALTER TABLE public.jimscanner_ask_recommendations ENABLE ROW LEVEL SECURITY;
