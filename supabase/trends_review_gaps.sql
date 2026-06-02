-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 — 경쟁 리스팅 리뷰 불만 갭 (review gap, 2026-06-02)
-- ─────────────────────────────────────────────────────────────
-- 아이디어: 후보 상품의 쿠팡 SERP 상위 리스팅 별점 낮은 리뷰에서
--   반복되는 불만을 LLM 으로 추출·군집(사이즈/내구성/냄새/소음/누수/포장 등)하여
--   '시장 1위가 못 고친 불만 Top3 → 이를 해결한 변형을 ggsan 에서 찾아라' 로 노출.
-- 위탁 1인셀러의 유일한 차별화 레버 = '같은 상품을 더 잘 고른 변형'.
--
-- 적재: 로컬 scripts/coupang-review-gap.mjs (service-role) → 이 테이블.
-- 노출: 어드민 read-only (/admin/trend-radar/review-gaps).
-- RLS enable + 정책 정의 X = service-role 만 접근 (기존 jimscanner_trends_* 패턴 동일).
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_review_gaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 후보 상품 연결 (canonical product 와 매핑되면 채움, 자유 검색이면 NULL)
  product_id uuid REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  -- SERP 검색 컨텍스트 (어떤 키워드로 수집했는지)
  search_keyword text NOT NULL,       -- 쿠팡 SERP 검색어 (예: '무선청소기')
  source_product_name text,           -- 리뷰를 수집한 상위 리스팅 상품명 (대표 1개)

  -- 불만 군집
  complaint_tag text NOT NULL,        -- 정규화 태그: 'size' | 'durability' | 'smell' | 'noise' | 'leak' | 'packaging' | ...
  complaint_label text,               -- 한국어 라벨 (예: '소음이 큼')
  freq numeric NOT NULL DEFAULT 0,    -- 동 키워드 내 불만 비중 0.0~1.0 (evidence_count / 전체 부정리뷰 수)
  severity int NOT NULL DEFAULT 1 CHECK (severity BETWEEN 1 AND 5),  -- LLM 심각도 1(경미)~5(반품유발)
  evidence_count int NOT NULL DEFAULT 0,   -- 이 태그에 매칭된 리뷰 수
  sample_quotes jsonb NOT NULL DEFAULT '[]'::jsonb,  -- 대표 인용 ["..물이 샌다..", ...] (최대 3)

  -- 차별화 → 발굴 큐 연결
  sourcing_query text,                -- 자동 생성 소싱 검색어 (예: '대용량 무선청소기', '저소음 가습기')

  computed_at timestamptz NOT NULL DEFAULT now(),

  -- 같은 (키워드, 태그) 는 최신 row 로 upsert
  UNIQUE (search_keyword, complaint_tag)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_review_gaps_product
  ON jimscanner_trends_review_gaps(product_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_review_gaps_keyword
  ON jimscanner_trends_review_gaps(search_keyword, severity DESC, freq DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_review_gaps_recent
  ON jimscanner_trends_review_gaps(computed_at DESC);

ALTER TABLE jimscanner_trends_review_gaps ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만. 정책 정의 안 함 = anon/auth 접근 차단.
