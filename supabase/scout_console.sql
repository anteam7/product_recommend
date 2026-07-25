-- 쿠팡 소싱 스카우트 (2026-07-22) — 크롬 확장(손) ↔ 로컬 Claude 두뇌(scripts/scout-agent.mjs) 릴레이.
-- 확장은 Vercel /api/ext/scout/* (Bearer SCOUT_EXT_TOKEN) 경유, 두뇌는 service_role 직접 폴링.
-- RLS 없음 = service_role 전용 접근 컨벤션 (work_instruction_console.sql 동형).
-- 프로토콜 문서: docs/scout-protocol.md

-- 채팅 세션 (스레드 1개 = Claude 세션 1개)
create table if not exists jimscanner_scout_sessions (
  id uuid primary key default gen_random_uuid(),
  title text,
  status text not null default 'active',    -- active|closed
  claude_session_id text,                   -- scout-agent 가 --resume 에 사용
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_scout_sessions_recent on jimscanner_scout_sessions (status, updated_at desc);

-- 채팅/로그 스레드
create table if not exists jimscanner_scout_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references jimscanner_scout_sessions(id) on delete cascade,
  role text not null,                       -- user|brain|system
  type text not null default 'chat',        -- chat|status|result|report
  content text,
  brain_seen_at timestamptz,                -- 두뇌 처리 커서 (role=user 만 의미)
  created_at timestamptz default now()
);
create index if not exists idx_scout_msg_thread on jimscanner_scout_messages (session_id, created_at);
create index if not exists idx_scout_msg_unseen on jimscanner_scout_messages (role, created_at) where brain_seen_at is null;

-- 명령 큐 (두뇌 → 확장)
create table if not exists jimscanner_scout_commands (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references jimscanner_scout_sessions(id) on delete cascade,
  command_type text not null,               -- docs/scout-protocol.md §명령 카탈로그
  payload jsonb not null default '{}',
  status text not null default 'queued',    -- queued|sent|running|paused|done|failed|cancelled
  progress jsonb,                           -- 최신 진행 이벤트 통째로
  result_summary jsonb,                     -- 건수·요약 (원본 데이터는 products/reviews)
  error text,
  brain_notified_at timestamptz,            -- 두뇌가 결과를 Claude에 보고한 시각
  created_at timestamptz default now(),
  sent_at timestamptz,
  ended_at timestamptz,
  updated_at timestamptz default now()
);
create index if not exists idx_scout_cmd_queue on jimscanner_scout_commands (status, created_at);
create index if not exists idx_scout_cmd_session on jimscanner_scout_commands (session_id, created_at desc);
create index if not exists idx_scout_cmd_notify on jimscanner_scout_commands (status, brain_notified_at) where brain_notified_at is null;

-- 수집 상품 (목록 수집 필드 + 상세 수집 필드를 한 테이블에)
create table if not exists jimscanner_scout_products (
  id uuid primary key default gen_random_uuid(),
  session_id uuid,
  command_id uuid not null,
  product_id text not null,                 -- 쿠팡 /vp/products/<id>
  url text,
  name text,
  price int,
  original_price int,
  discount_rate int,
  rating numeric,
  review_count int,
  brand text,
  seller text,
  competing_sellers int,                    -- collect_detail: 같은 상품 경쟁 판매자 수(적을수록 저경쟁). null=미수집
  delivery_badge text,                      -- rocket|rocket_fresh|rocket_global|rocket_growth|seller|normal
  image_url text,
  keyword text,                             -- 수집 당시 검색어/카테고리 라벨
  page_no int,
  rank_in_page int,
  -- collect_detail 채움:
  options jsonb,
  manufacturer text,
  origin text,
  detail_images text[],
  delivery_info jsonb,
  seller_info jsonb,
  qna jsonb,
  category_path text[],
  raw jsonb,
  collected_at timestamptz default now(),
  detail_collected_at timestamptz,
  unique (command_id, product_id)           -- 청크 재전송 멱등
);
create index if not exists idx_scout_prod_pid on jimscanner_scout_products (product_id);
create index if not exists idx_scout_prod_session on jimscanner_scout_products (session_id, collected_at desc);

-- 수집 리뷰
create table if not exists jimscanner_scout_reviews (
  id uuid primary key default gen_random_uuid(),
  product_id text not null,
  command_id uuid not null,
  review_date date,
  rating int,
  content text,
  images text[],
  option_text text,
  helpful_count int,
  content_hash text not null,               -- 날짜+내용 해시 (중복 방지)
  collected_at timestamptz default now(),
  unique (product_id, content_hash)
);
create index if not exists idx_scout_rev_pid on jimscanner_scout_reviews (product_id, review_date desc);

-- RLS 활성화 (정책 없음 = anon/authenticated 차단, service_role 만 접근 — 라이브 컨벤션 동형)
alter table jimscanner_scout_sessions enable row level security;
alter table jimscanner_scout_messages enable row level security;
alter table jimscanner_scout_commands enable row level security;
alter table jimscanner_scout_products enable row level security;
alter table jimscanner_scout_reviews enable row level security;

-- 소싱 매입 후보 스냅샷 (2026-07-25) — /admin/sourcing 비교 페이지. scripts/scout-sourcing-publish.mjs 발행.
create table if not exists jimscanner_scout_sourcing (
  id uuid primary key default gen_random_uuid(),
  product_id text, name text,
  coupang_url text, coupang_image text,
  dome_no text, dome_url text, dome_title text, dome_image text,
  sell int, unit int, inbound int, landed int, margin int, rate int,
  moq int, inventory int, send_avg text, has_option boolean default false,
  tax text, sim int, review_count int, rank int, batch text,
  created_at timestamptz default now()
);
create index if not exists idx_scout_sourcing_rank on jimscanner_scout_sourcing (batch, margin desc);
alter table jimscanner_scout_sourcing enable row level security;
