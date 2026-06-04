-- ────────────────────────────────────────────────────────────
-- 쿠팡 카테고리별 판매수수료 매핑 (2026-06-04)
-- ────────────────────────────────────────────────────────────
-- 목적: 발굴 보드에서 후보별 '순마진 ₩'을 산출하려면 카테고리별 쿠팡 수수료율이 필요.
--       coupang-recompute-margins.mjs 의 FEE_RATE=0.106(기타영양제 73137)을
--       카테고리 단위로 일반화해 DB 단일 출처로 둔다.
-- 사용처: /admin/trend-radar/recommend, /admin/trend-radar/products/[id]
--         src/lib/coupang/margin-waterfall.ts 의 폴백 맵을 DB로 끌어올린 형태.
-- category_code: 매핑 키. ggsan cate_cd(001~) 또는 쿠팡 displayCategoryCode 둘 다 수용.
-- fee_rate: 부가세 제외 판매수수료율 (예: 0.106 = 10.6%)
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_coupang_category_fee (
  category_code text PRIMARY KEY,
  label         text,
  fee_rate      numeric(5,4) NOT NULL DEFAULT 0.1060,
  note          text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE jimscanner_coupang_category_fee IS '쿠팡 카테고리별 판매수수료율(부가세 별도). 발굴 보드 순마진 워터폴 입력.';

-- ggsan cate_cd 기준 시드 (건기식 위주 — 기타영양제 10.6% 기준선, 나머지는 보수적 동일값)
INSERT INTO jimscanner_coupang_category_fee (category_code, label, fee_rate, note) VALUES
  ('001', '장건강',       0.1080, '유산균 카테고리 표준'),
  ('002', '눈건강',       0.1080, NULL),
  ('003', '간건강',       0.1080, NULL),
  ('005', '혈행건강',     0.1080, NULL),
  ('006', '관절건강',     0.1080, NULL),
  ('007', '면역건강',     0.1080, NULL),
  ('008', '체지방',       0.1080, NULL),
  ('009', '건기식기타',   0.1060, '기타영양제(73137) 기준'),
  ('010', '전통건강식품', 0.1080, NULL),
  ('011', '전립선',       0.1080, NULL),
  ('012', '식품분말',     0.1060, '가공식품류'),
  ('013', '가공식품기타', 0.1060, NULL),
  ('014', '신선식품',     0.1060, NULL),
  ('020', '임박특가',     0.1060, '카테고리 아님 — 폴백')
ON CONFLICT (category_code) DO UPDATE
  SET label = EXCLUDED.label, fee_rate = EXCLUDED.fee_rate, note = EXCLUDED.note, updated_at = now();

ALTER TABLE jimscanner_coupang_category_fee ENABLE ROW LEVEL SECURITY;
-- service-role 만 접근 (어드민 전용). 별도 정책 없으면 RLS 로 anon 차단.
