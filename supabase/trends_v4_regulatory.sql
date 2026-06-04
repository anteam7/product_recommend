-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 한국 인증·규제 게이트 (2026-06-04)
-- ─────────────────────────────────────────────────────────────
-- 발굴된 상품을 '위탁 셀러가 합법적으로 팔 수 있는가'로 사전 차단하는
-- 규제 적합성 게이트. classify_trends_llm 크론이 canonical_name·
-- category_top·description 으로 인증 레짐을 추정해 채운다.
--
-- 정책: jimscanner_trends_products 는 service-role 전용(RLS, 정책 X).
--       본 마이그레이션은 컬럼 2개만 추가하므로 RLS 변경 없음.
-- 관련: scripts/classify-trends-llm.mjs,
--       src/app/admin/(dashboard)/trend-radar/opportunity/page.tsx
-- ─────────────────────────────────────────────────────────────

-- 1) 규제 레짐 (LLM 추정, 단일 대표값)
--    전기KC: 전기용품 안전인증 (KC, 보유 도매처 필수)
--    생활용품KC: 생활용품 안전확인/공급자적합성
--    어린이안전: 어린이제품 안전 (만 13세 이하 대상)
--    화장품기능성: 화장품(특히 기능성) — 책임판매업 필요
--    건강기능식품: 건기식 — 영업신고+품목제조신고, 위탁 사실상 불가
--    의료기기: 의료기기 — 판매업 신고/허가, 위탁 사실상 불가
--    전안법섬유: 섬유·가죽제품 안전기준(KC/자가시험)
--    식품: 일반식품 — 영업신고
--    해당없음: 규제 부담 낮음 (잡화·소품 등)
ALTER TABLE jimscanner_trends_products
  ADD COLUMN IF NOT EXISTS regulatory_regime text;

-- 2) 위탁 판매 차단 강도
--    none    : 인증 부담 없음 — 위탁 즉시 판매 가능
--    low     : 경미 (도매처가 KC 보유 시 무난)
--    high    : 인증 보유 도매처 필수 — 일반 위탁은 어려움
--    blocker : 위탁 등록 사실상 불가 (의료기기·건기식 등 면허·신고 필요)
ALTER TABLE jimscanner_trends_products
  ADD COLUMN IF NOT EXISTS consignment_blocker text NOT NULL DEFAULT 'none';

-- 보드 정렬/필터용 인덱스 (blocker 하단 정렬, '즉시판매만' 필터)
CREATE INDEX IF NOT EXISTS jimscanner_trends_products_blocker
  ON jimscanner_trends_products(consignment_blocker);

COMMENT ON COLUMN jimscanner_trends_products.regulatory_regime IS
  '한국 인증 레짐 추정: 전기KC|생활용품KC|어린이안전|화장품기능성|건강기능식품|의료기기|전안법섬유|식품|해당없음';
COMMENT ON COLUMN jimscanner_trends_products.consignment_blocker IS
  '위탁 판매 차단 강도: none|low|high|blocker';
