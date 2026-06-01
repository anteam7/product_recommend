-- ────────────────────────────────────────────────────────────
-- PR-4.7: 구매의도 발화 추출 — 능동수요(bottom-of-funnel) 신호 (2026-06-02)
-- ────────────────────────────────────────────────────────────
-- 커뮤니티 raw 원문(natepan·ppomppu·dcinside·82cook·musinsa)에서
-- 단순 화제량이 아니라 '실제 사고 싶다' 발화를 추출한다.
--   · "어디서 사요" · "추천 좀" · "링크 좀" · "품번 뭐예요" · "대체템 뭐 있어요"
-- classify-trends-llm 가 alias 원문을 보고 구매의도 발화 수·대표 인용문·
-- 밀도(언급 대비 구매문의 비율)를 채운다.
--
-- 교차 해석 (trend-radar/intent 보드):
--   · 고화제(final_score↑) · 저구매의도(intent_density↓) = 거품 후보
--   · 저화제 · 고구매의도 = 숨은 보석 (검증된 능동수요)
-- ────────────────────────────────────────────────────────────

ALTER TABLE jimscanner_trends_products
  ADD COLUMN IF NOT EXISTS purchase_intent_count int NOT NULL DEFAULT 0,
  -- intent_density: 0.0~1.0, 분류 시점에 본 alias 표본 대비 구매의도 발화 비율
  ADD COLUMN IF NOT EXISTS intent_density numeric NOT NULL DEFAULT 0,
  -- intent_quotes: [{"quote": "원문 스니펫", "source": "natepan", "type": "where_to_buy"}, ...]
  ADD COLUMN IF NOT EXISTS intent_quotes jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS intent_classified_at timestamptz;

-- intent_density DESC 정렬 보드용 (값이 있는 행만 — 능동수요 후보)
CREATE INDEX IF NOT EXISTS jimscanner_trends_products_intent_density
  ON jimscanner_trends_products(intent_density DESC, purchase_intent_count DESC)
  WHERE purchase_intent_count > 0;
