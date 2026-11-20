-- 2026-11-20 도매아토즈 사람 입력 규격(관리자 /admin/domeatoz-spec). 정의는 domeatoz_products.sql 끝과 같다.
alter table public.jimscanner_domeatoz_products add column if not exists manual_spec jsonb;
alter table public.jimscanner_domeatoz_products add column if not exists manual_spec_by text;
alter table public.jimscanner_domeatoz_products add column if not exists manual_spec_at timestamptz;
