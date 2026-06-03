-- ─────────────────────────────────────────────────────────────
-- 수요측 지불의사(WTP) 가격천장 — price-fit 게이트 (2026-06-04)
-- ─────────────────────────────────────────────────────────────
-- 발굴된 canonical 상품마다 '소비자가 낼 의향이 있는 가격대'를 수요측
-- 언어(키워드/alias '1만원대/가성비/저렴한/프리미엄/최저가' + 'N원' 명시가)와
-- naver_tvtime 방송 판매가 앵커에서 역추출해 WTP 밴드(low/mid/high)를 적재.
--
-- price-fit 페이지에서 WTP 천장(wtp_high) 대비 ggsan 도매원가 + 쿠팡 공식
-- (SHIP 3000 · FEE 0.106) 필수 바닥가를 겹쳐 '가격 헤드룸' 을 시각화.
--   헤드룸 = wtp_high − 필수바닥가  (음수 = 마진불가 조기 킬)
--
-- 노출 정책: RLS enable + 정책 미정의 = service-role 만 접근 (기존 패턴 동일).
-- 적재: scripts/trends-extract-wtp.mjs (recompute 크론 스텝).
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_wtp (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  wtp_low  numeric,                  -- 가성비/최저가 화자가 기대하는 하단 (원)
  wtp_mid  numeric,                  -- 중앙 추정 (밴드 중심값)
  wtp_high numeric,                  -- 프리미엄/명품 화자 + 방송가가 받쳐주는 상단 = '가격 천장'

  -- 근거: 추출에 쓰인 가격수식어·명시가·방송앵커 모음.
  --   { "modifiers": [{"alias":"...","tier":"value|mid|premium","weight":1.0}],
  --     "explicit_prices": [{"text":"1만원대","amount_low":10000,"amount_high":19999,"source":"keyword"}],
  --     "tv_anchors": [{"title":"...","price":29900,"source":"naver_tvtime"}],
  --     "method": "regex_v1" | "llm_haiku" }
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,

  sample_count int NOT NULL DEFAULT 0,        -- 추출에 쓰인 발화/앵커 수 (신뢰도)
  confidence numeric NOT NULL DEFAULT 0.0,    -- 0.0~1.0 (sample_count·앵커 유무 기반)

  computed_at timestamptz NOT NULL DEFAULT now()
);

-- UI 는 (product_id, MAX(computed_at)) 으로 최신만 조회 (scores 패턴 동일).
CREATE INDEX IF NOT EXISTS jimscanner_trends_wtp_product_at
  ON jimscanner_trends_wtp(product_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_wtp_recent
  ON jimscanner_trends_wtp(computed_at DESC);

ALTER TABLE jimscanner_trends_wtp ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.
