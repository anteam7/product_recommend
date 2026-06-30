-- 도매매 DB(신규/인기/기획전) → 쿠팡 마진 흑자 후보 (2026-07-01)
-- 적재: scripts/domemedb-coupang-margin.mjs --save --target=N. 소비: /admin/domemedb-picks.
create table if not exists jimscanner_domemedb_margin_candidates (
  supplier text not null default 'domeme',
  supplier_goods_no text not null,
  title text,
  supply_price int,                 -- 도매매 위탁 공급가
  coupang_price int,                -- 쿠팡 동일상품 판매가
  reviews int,                      -- 쿠팡 후기수(판매검증)
  est_margin_krw int,               -- 순이익(쿠팡−공급−수수료−물류)
  est_margin_rate numeric,          -- 순마진율(%)
  page_source text,                 -- new|popular|event
  moq int,
  detail_url text,
  image_url text,
  adopted boolean default false,
  first_found_at timestamptz default now(),
  last_checked_at timestamptz default now(),
  primary key (supplier, supplier_goods_no)
);
create index if not exists idx_domemedb_margin_rate on jimscanner_domemedb_margin_candidates (est_margin_rate desc);
create index if not exists idx_domemedb_margin_recent on jimscanner_domemedb_margin_candidates (last_checked_at desc);

-- 큰 런 진행상태(버튼 트리거/진행 표시)
create table if not exists jimscanner_domemedb_run_state (
  id int primary key default 1,
  status text default 'idle',       -- idle|running
  found int default 0,
  screened int default 0,
  target int default 30,
  message text,
  started_at timestamptz,
  updated_at timestamptz default now()
);
insert into jimscanner_domemedb_run_state (id) values (1) on conflict (id) do nothing;
