-- 쿠팡 카테고리별 판매수수료 — 마진 계산의 근거표
-- 적재: scripts/coupang-build-commission-table.mjs (쿠팡 카테고리 트리 API 크롤 → 규칙 적용)
-- 사용: jimscanner_purchase_catalog 뷰가 display_category_code 로 조인
--
-- 규칙 (사용자 확정 2026-09-18, 사용자 제공 수수료표 2026-07 기준)
--   식품 > 건강식품 > 건강식품 > *   → 7.6%  (영양제·비타민/미네랄 계열: 유산균·루테인·쏘팔메토·마카·아연 등)
--   그 외 식품 하위                 → 10.6% (전통건강식품·환/분말·가루/조미료·다이어트식품·신선식품·차류)
-- 트리 밖(오예측) 카테고리는 이 표에 없고, 뷰에서 기본값 10.6% 로 처리한다.

create table if not exists public.jimscanner_coupang_category_commission (
  display_category_code integer primary key,
  name                  text not null,
  path                  text not null,          -- '식품 > 건강식품 > 건강식품 > 기타건강식품 > 루테인'
  branch                text,                   -- 경로 3단계까지 ('식품 > 건강식품 > 건강식품')
  rate                  numeric(5,4) not null,  -- 0.0760 / 0.1060
  rate_source           text not null default 'rule:2026-09-18',
  updated_at            timestamptz not null default now()
);

create index if not exists jimscanner_coupang_category_commission_branch_idx
  on public.jimscanner_coupang_category_commission (branch);

alter table public.jimscanner_coupang_category_commission enable row level security;
revoke all on public.jimscanner_coupang_category_commission from anon, authenticated;
