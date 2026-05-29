-- ─────────────────────────────────────────────────────────────
-- 등록 준비도 게이트 — 인증·필수속성·콘텐츠 자산 진입장벽 보드 (2026-05-30)
-- ─────────────────────────────────────────────────────────────
-- 발굴 candidate 가 "팔릴까/마진날까"를 넘어 "솔로 셀러가 실제 등록 가능한가"를
-- 점수화한다. 쿠팡 카테고리 메타(필수속성·인증요구) + ggsan 콘텐츠 자산 + 규제 인증
-- 여부를 합쳐 readiness_score 를 산출.
--
-- 노출 정책: 기존 jimscanner_trends_* 와 동일 — RLS enable + 정책 미정의 =
--   service-role 만 접근. UI 는 어드민(createAdminClient)에서 read-only.
-- ─────────────────────────────────────────────────────────────


-- 1) 쿠팡 카테고리 메타 캐시
--    coupang-category-meta.mjs 가 조회하던 displayCategoryCode 별 필수속성/인증요구
--    정보를 캐시. refresh-coupang-category-meta cron 이 주기 갱신.
CREATE TABLE IF NOT EXISTS jimscanner_trends_category_meta (
  display_category_code int PRIMARY KEY,
  name text,

  is_allow_single_item boolean,
  notice_mandatory_count int NOT NULL DEFAULT 0,      -- MANDATORY 고시정보 필드 수
  attr_mandatory_count int NOT NULL DEFAULT 0,        -- MANDATORY 옵션 속성 수
  cert_required boolean NOT NULL DEFAULT false,       -- MANDATORY 인증서류 존재
  cert_names text[] NOT NULL DEFAULT '{}',            -- 요구 인증 이름들

  raw jsonb NOT NULL DEFAULT '{}'::jsonb,             -- 원천 메타 (재파싱용)
  refreshed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE jimscanner_trends_category_meta ENABLE ROW LEVEL SECURITY;


-- 2) 등록 준비도 (시계열 — 매 재계산 시 새 row, UI 는 product_id 별 latest)
CREATE TABLE IF NOT EXISTS jimscanner_trends_listing_readiness (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  category_top text,
  category_mid text,
  matched_category_code int,                          -- 매핑된 쿠팡 카테고리 코드 (있으면)

  mandatory_attr_count int NOT NULL DEFAULT 0,        -- 고시정보+옵션속성 합산
  cert_required boolean NOT NULL DEFAULT false,
  cert_type text,                                     -- '건강기능식품' | '화장품' | 'KC전파' | '식품' | NULL

  content_asset_score numeric NOT NULL DEFAULT 0 CHECK (content_asset_score >= 0 AND content_asset_score <= 100),
  readiness_score numeric NOT NULL DEFAULT 0 CHECK (readiness_score >= 0 AND readiness_score <= 100),

  -- 산출 근거 (디버깅·UI breakdown)
  breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,

  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_listing_readiness_product_at
  ON jimscanner_trends_listing_readiness(product_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_listing_readiness_score_recent
  ON jimscanner_trends_listing_readiness(readiness_score DESC, computed_at DESC);

ALTER TABLE jimscanner_trends_listing_readiness ENABLE ROW LEVEL SECURITY;
