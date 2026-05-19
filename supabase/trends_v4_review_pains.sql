-- ────────────────────────────────────────────────────────────
-- PR-REVIEW-PAINS: 리뷰 페인포인트 마이닝 (2026-05-20)
-- ────────────────────────────────────────────────────────────
-- 검색량 상위 키워드의 경쟁 상품 한국어 리뷰(네이버/쿠팡/올리브영)를
-- 수집·LLM 클러스터링으로 부정 토픽(품질/사이즈/내구성/포장/사용감 등)
-- 빈도를 잡아 "차별화 진입 기회" 보드에 노출한다.
--
-- 데이터 흐름:
--   scripts/mine-review-pains.mjs (로컬 cron)
--     → 상위 키워드 N개 리뷰 페이지 스크레이프
--     → claude CLI 로 토픽 추출
--     → jimscanner_review_pains UPSERT
--   /admin/trend-radar/review-pains
--     → keyword × pain_topic 매트릭스 + 대표 인용문
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_review_pains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword text NOT NULL,                     -- 검색량 있는 키워드 (예: "오메가3")
  product_ref text,                          -- 상품 식별자 (스토어 URL / SKU / 제목 일부)
  product_title text,                        -- 사람-읽기용 상품명
  source text NOT NULL,                      -- 'naver_smartstore' | 'coupang' | 'oliveyoung'
  pain_topic text NOT NULL,                  -- 'quality' | 'size' | 'durability' | 'packaging' | 'usability' | 'smell' | 'taste' | 'price' | 'shipping' | 'effect' | 'etc'
  pain_label text,                           -- 한국어 라벨 (예: "캡슐이 너무 큼")
  frequency integer NOT NULL DEFAULT 1,      -- 같은 (keyword,product_ref,topic) 내 발견 횟수
  repr_quote text,                           -- 대표 인용문 (1-2문장)
  confidence numeric(3, 2) NOT NULL DEFAULT 0.5, -- 0.00 ~ 1.00
  ggsan_match_goods_no text,                 -- ggsan 변형 SKU 매칭 (가능 시)
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS jimscanner_review_pains_unique
  ON jimscanner_review_pains(keyword, COALESCE(product_ref, ''), source, pain_topic);

CREATE INDEX IF NOT EXISTS jimscanner_review_pains_keyword
  ON jimscanner_review_pains(keyword, observed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_review_pains_topic
  ON jimscanner_review_pains(pain_topic, frequency DESC);

CREATE INDEX IF NOT EXISTS jimscanner_review_pains_ggsan
  ON jimscanner_review_pains(ggsan_match_goods_no)
  WHERE ggsan_match_goods_no IS NOT NULL;

ALTER TABLE jimscanner_review_pains ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role) 만.

-- updated_at 트리거
CREATE OR REPLACE FUNCTION jimscanner_review_pains_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_review_pains_updated_at ON jimscanner_review_pains;
CREATE TRIGGER jimscanner_review_pains_updated_at
  BEFORE UPDATE ON jimscanner_review_pains
  FOR EACH ROW EXECUTE FUNCTION jimscanner_review_pains_set_updated_at();


-- 시계열 빈도 추이 (셀 클릭 시 노출용)
CREATE TABLE IF NOT EXISTS jimscanner_review_pains_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword text NOT NULL,
  pain_topic text NOT NULL,
  frequency integer NOT NULL,
  observed_on date NOT NULL DEFAULT current_date,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS jimscanner_review_pains_history_day
  ON jimscanner_review_pains_history(keyword, pain_topic, observed_on);

ALTER TABLE jimscanner_review_pains_history ENABLE ROW LEVEL SECURITY;
