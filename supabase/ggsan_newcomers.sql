-- ────────────────────────────────────────────────────────────
-- ggsan 신규 입고 정찰병 — 도매 신상 SKU 24h 선점 게이트
-- (Newcomer market scout, 2026-05-25)
-- ────────────────────────────────────────────────────────────
-- 목적:
--   ggsan 도매몰이 "처음 푼" SKU (price_history 1건만 존재) 를
--   24h 내 시장가·포화도·마진 헤드룸으로 점수화해 위탁 선점 결정 지원.
--
-- 식별 키:
--   jimscanner_ggsan_price_history 에 row 가 1건만 있는 goods_no = 신규
--   (cron 이 매일 KST 02:00 ggsan 동기화 직후 큐 채움)
-- ────────────────────────────────────────────────────────────

-- 1) 신규 입고 시장 probe 점수 (1 row per goods_no)
CREATE TABLE IF NOT EXISTS jimscanner_ggsan_newcomer_scores (
  goods_no text PRIMARY KEY REFERENCES jimscanner_ggsan_products(goods_no) ON DELETE CASCADE,

  -- 시장 probe 결과
  market_min_krw integer,           -- 네이버 쇼핑 / 다나와 SERP 최저가
  market_median_krw integer,        -- 시장 중앙값
  market_seller_count integer,      -- 판매처 수 (포화도)
  market_review_count integer,      -- 누적 리뷰 수 (수요 시그널)
  market_query text,                -- 실제 사용한 검색 쿼리
  probe_status text NOT NULL DEFAULT 'pending', -- 'pending' | 'probed' | 'no_match' | 'error'
  probe_error text,
  probed_at timestamptz,

  -- 파생 지표
  margin_pct numeric,               -- (market_min - wholesale) / wholesale * 100
  saturation_score numeric,         -- 0~1 (낮을수록 블루오션). seller_count 기반
  category_zscore numeric,          -- 동일 cate_cd 기존 SKU 가격 분포 대비 z-score
  newcomer_score numeric,           -- 종합 0~100

  -- 워크플로
  queued_at timestamptz NOT NULL DEFAULT now(),
  pinned boolean NOT NULL DEFAULT false,
  dismissed boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_ggsan_newcomer_scores_status
  ON jimscanner_ggsan_newcomer_scores(probe_status, queued_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_ggsan_newcomer_scores_score
  ON jimscanner_ggsan_newcomer_scores(newcomer_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS jimscanner_ggsan_newcomer_scores_active
  ON jimscanner_ggsan_newcomer_scores(queued_at DESC) WHERE NOT dismissed;

ALTER TABLE jimscanner_ggsan_newcomer_scores ENABLE ROW LEVEL SECURITY;

-- updated_at 트리거
CREATE OR REPLACE FUNCTION jimscanner_ggsan_newcomer_scores_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_ggsan_newcomer_scores_updated_at ON jimscanner_ggsan_newcomer_scores;
CREATE TRIGGER jimscanner_ggsan_newcomer_scores_updated_at
  BEFORE UPDATE ON jimscanner_ggsan_newcomer_scores
  FOR EACH ROW EXECUTE FUNCTION jimscanner_ggsan_newcomer_scores_set_updated_at();


-- 2) 신규 입고 자동 큐잉 함수
--    ggsan 동기화 직후 cron 이 호출. price_history 1건만 가진 신규 row 를
--    newcomer_scores 에 INSERT (이미 있으면 무시).
CREATE OR REPLACE FUNCTION jimscanner_enqueue_ggsan_newcomers()
RETURNS integer AS $$
DECLARE
  inserted_cnt integer;
BEGIN
  WITH newcomers AS (
    SELECT p.goods_no
    FROM jimscanner_ggsan_products p
    WHERE EXISTS (
      SELECT 1 FROM jimscanner_ggsan_price_history h
      WHERE h.goods_no = p.goods_no
    )
    AND (
      SELECT COUNT(*) FROM jimscanner_ggsan_price_history h
      WHERE h.goods_no = p.goods_no
    ) = 1
    AND p.first_seen_at >= now() - interval '72 hours'
  )
  INSERT INTO jimscanner_ggsan_newcomer_scores (goods_no)
  SELECT goods_no FROM newcomers
  ON CONFLICT (goods_no) DO NOTHING;

  GET DIAGNOSTICS inserted_cnt = ROW_COUNT;
  RETURN inserted_cnt;
END;
$$ LANGUAGE plpgsql;
