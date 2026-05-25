-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — Aspect-Based Negative Review 결함 마이닝
-- (Improvement-Scout #aspect-mining, 2026-05-26)
-- ─────────────────────────────────────────────────────────────
-- 목표: 카테고리별 상위 SERP 상품의 별 1~3 리뷰를 LLM 으로 aspect 추출 →
--       '뚜껑 약함 / 냄새 / 충전 불량 / 내구성 / 구성품 누락' 같은
--       정규화 결함 태그로 클러스터링. 같은 도매 SKU 를 더 잘 묶거나
--       고지함으로써 이길 수 있는 1차 증거를 제공.
--
-- D5: 운영자 전용 (어드민 한정)
-- D7: 수집은 로컬 cron (scripts/mine-review-aspects.mjs), 적재는 service-role,
--     UI 는 Vercel 어드민 read-only 히트맵 + ggsan SKU 매칭 사이드패널
-- 노출 정책: RLS enable + 정책 정의 X = service-role 만 접근.
-- ─────────────────────────────────────────────────────────────


-- 1) 정규화 결함 aspect 집계 (카테고리 × aspect_tag 단위)
CREATE TABLE IF NOT EXISTS jimscanner_trends_review_aspects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  category_top text NOT NULL,           -- 'health' | 'living' | 'digital' | 'other'
  category_mid text,                    -- 'oil_drum' / 'humidifier' 등 (자유)
  aspect_tag text NOT NULL,             -- '뚜껑_약함' / '냄새' / '충전_불량' / '내구성' / '구성품_누락' 등 정규화 키
  aspect_label text,                    -- 사람-읽기 라벨 ('뚜껑이 잘 떨어짐')

  severity_score numeric NOT NULL DEFAULT 0,   -- 0~1, 평균 별점·언급 빈도·키워드 강도로 합산
  mention_count int NOT NULL DEFAULT 0,        -- 이 aspect 로 분류된 리뷰 누적 수
  product_count int NOT NULL DEFAULT 0,        -- 이 aspect 가 한 번 이상 나온 SERP 상품 수
  source_product_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
                                        -- 쿠팡 productId 또는 네이버 nvMid 배열 (max 50)
  sample_quotes jsonb NOT NULL DEFAULT '[]'::jsonb,
                                        -- [{quote, source, rating}] 최대 5건 보존

  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (category_top, aspect_tag)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_review_aspects_cat_severity
  ON jimscanner_trends_review_aspects(category_top, severity_score DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_review_aspects_seen
  ON jimscanner_trends_review_aspects(last_seen_at DESC);

ALTER TABLE jimscanner_trends_review_aspects ENABLE ROW LEVEL SECURITY;

-- updated_at 트리거 (기존 패턴 재사용)
CREATE OR REPLACE FUNCTION jimscanner_trends_review_aspects_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_trends_review_aspects_updated_at
  ON jimscanner_trends_review_aspects;
CREATE TRIGGER jimscanner_trends_review_aspects_updated_at
  BEFORE UPDATE ON jimscanner_trends_review_aspects
  FOR EACH ROW EXECUTE FUNCTION jimscanner_trends_review_aspects_set_updated_at();


-- 2) 원천 리뷰 적재 (cron 실행 단위 감사 + 재처리용)
CREATE TABLE IF NOT EXISTS jimscanner_trends_review_raw (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,                 -- 'coupang' / 'naver_shopping'
  source_product_id text NOT NULL,      -- 외부 mall product id
  category_top text,
  rating int,                           -- 1~5 (수집한 부정 리뷰는 보통 1~3)
  review_text text NOT NULL,
  review_meta jsonb,                    -- {reviewer_id, helpful_count, written_at, ...}
  collected_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  extracted_aspects jsonb               -- LLM 추출 결과 (aspect_tag 배열)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_review_raw_unprocessed
  ON jimscanner_trends_review_raw(collected_at DESC)
  WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS jimscanner_trends_review_raw_source_prod
  ON jimscanner_trends_review_raw(source, source_product_id);

ALTER TABLE jimscanner_trends_review_raw ENABLE ROW LEVEL SECURITY;


-- 3) cron 감사 로그 (기존 jimscanner_trends_runs 패턴 재사용)
--    별도 테이블이 아니라 동일 테이블에 source='mine_review_aspects' 로 기록.
--    (jimscanner_trends_runs 가 이미 free-form source 컬럼이라 추가 마이그 불필요)


-- 4) jimscanner_trends_pins 에 differentiation_aspects 컬럼 추가
--    핀 후보를 '결함 해소 차별화 포지셔닝' 으로 등록.
ALTER TABLE jimscanner_trends_pins
  ADD COLUMN IF NOT EXISTS differentiation_aspects jsonb;
  -- 예: [{"aspect_tag":"뚜껑_약함","action":"리유저블 캡 동봉"}, ...]
