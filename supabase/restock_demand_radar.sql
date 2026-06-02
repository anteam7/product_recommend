-- ─────────────────────────────────────────────────────────────
-- 재입고 대란 레이더 — 미충족 공급(supply gap) 시그널 (2026-06-02)
-- ─────────────────────────────────────────────────────────────
-- 커뮤니티/뉴스 raw(jimscanner_market_raw.title) + 트렌드 키워드에서
-- '품절/재입고 언제/오픈런/대란/구할 데 없음/배송 2주' 같은
-- 공급실패 렉시콘을 룰 스캐너(scripts/scan-supply-gap.mjs)로 추출해
-- 발화 단위로 적재한다. canonical product 와 매칭되면 product_id 연결.
--
-- 점수 정책:
--   · supply_gap = Σ(렉시콘 가중치)  — 발화 1건당 강도
--   · 집계 뷰(jimscanner_supply_gap_ranking)에서 키워드/상품 단위로 합산
--   · 매칭된 product 는 jimscanner_trends_scores.score_components.supply_gap
--     (jsonb) 에 recompute 시 반영 가능 (스캐너가 upsert)
--
-- RLS: 기존 trends_* 패턴 동일 — enable + 정책 X = service-role 전용.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_supply_gap_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 원천 발화
  raw_id uuid REFERENCES jimscanner_market_raw(id) ON DELETE CASCADE,
  source text NOT NULL,                  -- '82cook' | 'natepan' | 'ppomppu' | 'dcinside' | 'daum' | 'naver_news' | 'trends_keyword' 등
  source_url text,
  snippet text NOT NULL,                 -- 발화 원문 (title)

  -- 룰 추출 결과
  matched_terms text[] NOT NULL DEFAULT '{}',   -- 적중한 공급실패 렉시콘들
  supply_gap numeric NOT NULL DEFAULT 0,        -- Σ 가중치 (발화 강도)

  -- 상품 매칭 (선택)
  product_id uuid REFERENCES jimscanner_trends_products(id) ON DELETE SET NULL,
  keyword text,                          -- 그룹핑용 후보 키워드 (매칭 시 canonical_name)

  captured_at timestamptz NOT NULL DEFAULT now(),  -- 원천 발화 시각
  created_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (raw_id)                        -- raw 1건당 1 시그널 (재스캔 upsert)
);

CREATE INDEX IF NOT EXISTS jimscanner_supply_gap_signals_gap
  ON jimscanner_supply_gap_signals(supply_gap DESC, captured_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_supply_gap_signals_keyword
  ON jimscanner_supply_gap_signals(keyword, captured_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_supply_gap_signals_product
  ON jimscanner_supply_gap_signals(product_id, captured_at DESC)
  WHERE product_id IS NOT NULL;

ALTER TABLE jimscanner_supply_gap_signals ENABLE ROW LEVEL SECURITY;

-- 집계 뷰: 키워드(미매칭 시 '(미매칭)') 단위로 강도 합산 + 발화 인용.
-- '수요는 끓는데 기존 셀러가 못 대주는' 상품을 랭킹 노출.
CREATE OR REPLACE VIEW jimscanner_supply_gap_ranking AS
SELECT
  COALESCE(s.keyword, '(미매칭)')          AS keyword,
  s.product_id,
  count(*)                                 AS mention_count,
  round(sum(s.supply_gap)::numeric, 2)     AS supply_gap_score,
  round(avg(s.supply_gap)::numeric, 2)     AS avg_gap,
  max(s.captured_at)                       AS last_mentioned_at,
  array_agg(DISTINCT s.source)             AS sources,
  -- 대표 발화 스니펫 5건 (최신순)
  (array_agg(jsonb_build_object(
      'snippet', s.snippet,
      'url', s.source_url,
      'source', s.source,
      'terms', s.matched_terms,
      'gap', s.supply_gap,
      'at', s.captured_at
   ) ORDER BY s.captured_at DESC))[1:5]    AS samples
FROM jimscanner_supply_gap_signals s
WHERE s.captured_at >= now() - interval '30 days'
GROUP BY COALESCE(s.keyword, '(미매칭)'), s.product_id;
