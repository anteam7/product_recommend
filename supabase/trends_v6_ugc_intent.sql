-- ────────────────────────────────────────────────────────────
-- v6: UGC Latent Purchase Intent 마이닝 (2026-05-26)
-- ────────────────────────────────────────────────────────────
-- jimscanner_market_raw (naver_blog/naver_news/quasarzone_sale) 본문에서
-- LLM 으로 *구매의향(intent)* 발화를 추출해 4-tuple 로 정규화 적재.
--
-- 한 raw 문서당 0~N 개의 intent row 가 생성됨.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.jimscanner_ugc_intent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_id uuid NOT NULL,                          -- jimscanner_market_raw.id (FK 느슨하게)
  source text NOT NULL,                          -- 'naver_blog' | 'naver_news' | 'quasarzone_sale'
  source_url text,                               -- raw 원문 URL (조회 편의용 비정규화)

  -- 4-tuple (정규화된 의향 발화)
  keyword text NOT NULL,                         -- 의향 대상 키워드 (예: '무선이어폰', '오메가3')
  intent_type text NOT NULL,                     -- 'where_to_buy' | 'recommend_request' | 'want_to_buy' | 'alternative'
  price_band text,                               -- '저가' | '중가' | '고가' | null (가격대 언급)
  user_context text,                             -- 사용자 상황 5-15자 (예: '대학생 자취', '선물용')

  -- 원문 발화 인용 (1-3문장)
  quote text NOT NULL,                           -- 실제 발화 인용 (UI 신뢰도용)
  confidence numeric NOT NULL DEFAULT 0.7,       -- 0~1

  -- LLM 메타
  llm_model text,
  classified_at timestamptz NOT NULL DEFAULT now(),
  captured_at timestamptz NOT NULL DEFAULT now() -- raw 의 captured_at 복사 (시계열 분석 편의)
);

CREATE INDEX IF NOT EXISTS idx_ugc_intent_keyword_captured
  ON public.jimscanner_ugc_intent (keyword, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_ugc_intent_type_captured
  ON public.jimscanner_ugc_intent (intent_type, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_ugc_intent_source_captured
  ON public.jimscanner_ugc_intent (source, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_ugc_intent_raw_id
  ON public.jimscanner_ugc_intent (raw_id);

-- raw row 가 LLM 마이닝 완료됐는지 플래그
-- market_raw 의 processed 컬럼과 별개 (processed 는 market_signals 추출용)
ALTER TABLE public.jimscanner_market_raw
  ADD COLUMN IF NOT EXISTS ugc_intent_mined_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_market_raw_intent_unmined
  ON public.jimscanner_market_raw (captured_at DESC)
  WHERE ugc_intent_mined_at IS NULL
    AND source IN ('naver_blog', 'naver_news', 'quasarzone_sale');

-- RLS: service_role 만.
ALTER TABLE public.jimscanner_ugc_intent ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────────────────
-- 집계 view: 키워드별 Intent Density / Conversion Lag
-- Intent Density   = 의향발화수 / 해당 키워드 총 멘션수
-- Conversion Lag   = 의향발화 captured_at 후 N일 내 naver_search_trend
--                    상승률 (별도 RPC 로 산출 — 뷰에선 raw 카운트만)
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.jimscanner_ugc_intent_density AS
WITH intents AS (
  SELECT
    keyword,
    COUNT(*) AS intent_count,
    COUNT(*) FILTER (WHERE intent_type = 'where_to_buy') AS where_to_buy_count,
    COUNT(*) FILTER (WHERE intent_type = 'recommend_request') AS recommend_count,
    COUNT(*) FILTER (WHERE intent_type = 'want_to_buy') AS want_count,
    COUNT(*) FILTER (WHERE intent_type = 'alternative') AS alternative_count,
    MIN(captured_at) AS first_intent_at,
    MAX(captured_at) AS last_intent_at,
    array_agg(DISTINCT source) AS sources
  FROM public.jimscanner_ugc_intent
  WHERE captured_at > now() - interval '60 days'
  GROUP BY keyword
),
mentions AS (
  -- 키워드별 raw 본문 멘션 추정: title ILIKE 매칭 (저렴한 근사)
  SELECT
    i.keyword,
    COUNT(DISTINCT r.id) AS mention_count
  FROM intents i
  LEFT JOIN public.jimscanner_market_raw r
    ON r.source IN ('naver_blog', 'naver_news', 'quasarzone_sale')
   AND r.captured_at > now() - interval '60 days'
   AND (r.title ILIKE '%' || i.keyword || '%'
        OR (r.metadata ->> 'description') ILIKE '%' || i.keyword || '%')
  GROUP BY i.keyword
)
SELECT
  i.keyword,
  i.intent_count,
  COALESCE(m.mention_count, 0) AS mention_count,
  CASE
    WHEN COALESCE(m.mention_count, 0) = 0 THEN NULL
    ELSE round((i.intent_count::numeric / m.mention_count::numeric) * 100, 2)
  END AS intent_density_pct,
  i.where_to_buy_count,
  i.recommend_count,
  i.want_count,
  i.alternative_count,
  i.first_intent_at,
  i.last_intent_at,
  i.sources
FROM intents i
LEFT JOIN mentions m ON m.keyword = i.keyword;
