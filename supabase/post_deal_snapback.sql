-- ─────────────────────────────────────────────────────────────
-- 핫딜 종료 후 수요 스냅백 윈도우 (Post-Deal Snapback Pin)
-- 2026-05-26
-- ─────────────────────────────────────────────────────────────
-- 목적: quasarzone_sale raw 에서 '핫딜 시작→종료' 사이클을 추출하고
--   종료 시점 ±14일 윈도우에 동일 키워드의 네이버 검색량을 매칭해
--   '딜 종료 후 정상가 수요 스냅백 비율'을 산출한다.
-- D5: 운영자 전용 (어드민)
-- D7: 모든 테이블·뷰 RLS enable + 정책 미정의 = service-role 만 접근
-- ─────────────────────────────────────────────────────────────

-- 1) 핫딜 라이프사이클 view
--    같은 external_id (퀘이사존 글 ID) 가 여러 번 raw 에 적재되지는 않지만
--    (UNIQUE source+dedup_key 라서) 캐치업 cron 이 첫 발견을 first_seen,
--    동일 사이트 라벨 + 동일 cleaned title 의 동일 키워드 군집을
--    "딜 사이클"로 묶기 위해 metadata.clean_title 기반으로 정규화한다.
--
--    종료 판정: '같은 키워드의 새 핫딜이 최근 48h 사이 없음' = ended.
--    (정확한 글 삭제 시점 데이터가 없어 보수적으로 48h 무신호 기준)
CREATE OR REPLACE VIEW jimscanner_market_deal_cycles AS
WITH base AS (
  SELECT
    r.id                                                AS raw_id,
    r.external_id                                       AS quasar_id,
    r.title                                             AS raw_title,
    COALESCE(r.metadata->>'clean_title', r.title)       AS clean_title,
    r.metadata->>'site_label'                           AS site_label,
    r.source_url,
    r.captured_at
  FROM public.jimscanner_market_raw r
  WHERE r.source = 'quasarzone_sale'
),
-- 키워드 = clean_title 의 첫 brand/category 토큰 (간단 정규화).
-- 어드민 화면에서 사람이 더 좋은 키워드로 핀 시 jimscanner_trends_products 로 승격.
norm AS (
  SELECT
    b.*,
    lower(regexp_replace(
      split_part(b.clean_title, ' ', 1),
      '[^[:alnum:]가-힣]', '', 'g'
    )) AS first_token,
    lower(regexp_replace(
      array_to_string((string_to_array(b.clean_title, ' '))[1:2], ' '),
      '[^[:alnum:]가-힣 ]', '', 'g'
    )) AS short_key
  FROM base b
)
SELECT
  n.short_key                                            AS cycle_key,
  MIN(n.clean_title)                                     AS sample_title,
  MIN(n.site_label)                                      AS sample_site_label,
  COUNT(*)                                               AS deal_count,
  MIN(n.captured_at)                                     AS first_seen_at,
  MAX(n.captured_at)                                     AS last_seen_at,
  EXTRACT(EPOCH FROM (MAX(n.captured_at) - MIN(n.captured_at))) / 86400.0 AS span_days,
  (MAX(n.captured_at) < now() - INTERVAL '48 hours')     AS ended,
  array_agg(DISTINCT n.quasar_id)                        AS quasar_ids,
  array_agg(DISTINCT n.source_url)                       AS source_urls
FROM norm n
WHERE n.short_key <> ''
GROUP BY n.short_key
HAVING COUNT(*) >= 1;

COMMENT ON VIEW jimscanner_market_deal_cycles IS
  'quasarzone_sale raw 에서 핫딜 사이클(시작/종료)을 cycle_key 단위로 집계.';


-- 2) 스냅백 스코어 테이블
--    cron 이 ended=true 사이클을 검출해 채움.
--    재계산 시 동일 cycle_key 는 upsert.
CREATE TABLE IF NOT EXISTS public.jimscanner_deal_snapback_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  cycle_key text NOT NULL UNIQUE,
  sample_title text,
  sample_site_label text,

  -- 핫딜 라이프사이클
  deal_started_at timestamptz NOT NULL,
  deal_ended_at   timestamptz NOT NULL,
  deal_span_days  numeric NOT NULL DEFAULT 0,

  -- 트렌드 매칭 (네이버 검색량 0~100)
  matched_trend_keyword text,             -- jimscanner_trends_keywords.keyword
  trend_source text,                      -- 'naver_search_trend' | 'naver_shopping_insight'
  pre_deal_avg numeric,                   -- 딜 시작 전 7일 평균
  during_deal_peak numeric,               -- 딜 기간 중 최고치
  post_end_avg_7d numeric,                -- 종료 후 7일 평균
  post_end_avg_14d numeric,               -- 종료 후 14일 평균
  recovery_curve jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- recovery_curve 예: [{"d": -7, "v": 42}, {"d": 0, "v": 100}, {"d": 7, "v": 78}]

  -- 핵심 지표
  snapback_ratio numeric,                 -- post_end_avg_7d / during_deal_peak
  snapback_score numeric,                 -- 0~100 (정렬용 결합지표)

  -- 마진 추정 (옵션, 도매가/정상가 비교 — 추후 채움)
  wholesale_price_krw numeric,
  retail_price_krw numeric,
  margin_pct numeric,

  -- 진입 D-day 큐: 종료 후 며칠 차에 진입 권장
  recommended_entry_offset_days int,

  -- 운영자 액션
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','pinned','dismissed','promoted')),
  promoted_product_id uuid,               -- jimscanner_trends_products(id)
  notes text,

  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,

  computed_at timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_deal_snapback_scores_score_at
  ON public.jimscanner_deal_snapback_scores (snapback_score DESC NULLS LAST, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_deal_snapback_scores_status_at
  ON public.jimscanner_deal_snapback_scores (status, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_deal_snapback_scores_ended_at
  ON public.jimscanner_deal_snapback_scores (deal_ended_at DESC);

ALTER TABLE public.jimscanner_deal_snapback_scores ENABLE ROW LEVEL SECURITY;

-- updated_at 자동 갱신
CREATE OR REPLACE FUNCTION jimscanner_deal_snapback_scores_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_deal_snapback_scores_updated_at
  ON public.jimscanner_deal_snapback_scores;
CREATE TRIGGER jimscanner_deal_snapback_scores_updated_at
  BEFORE UPDATE ON public.jimscanner_deal_snapback_scores
  FOR EACH ROW EXECUTE FUNCTION jimscanner_deal_snapback_scores_set_updated_at();
