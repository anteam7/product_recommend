-- 비셀러 ↔ 네이버 스마트스토어 가격경쟁력 (2026-07-08)
-- 채우기: scripts/beseller-naver-compete.mjs (그룹 최저옵션 vs 네이버 최저가 → 등급)
-- 소비: /admin/trend-radar/beseller (경쟁력 뱃지 + compete 필터)
create table if not exists jimscanner_beseller_price_compare (
  group_key text primary key,
  rep_branduid text,                 -- 대표(최저 공급가 활성변형) 상품
  rep_title text,
  cate_label text,
  our_supply int,                    -- 그룹 최저옵션 공급가
  market_low int,                    -- 네이버 동일SKU 최저가
  market_mall text,
  market_count int,                  -- 동일SKU 비교 표본수
  margin_at_low int,                 -- 네이버 최저가에 팔 때 순이익(수수료 차감)
  margin_rate numeric,               -- 순마진율
  grade text,                        -- strong | ok | weak | none
  query text,                        -- 검색어
  low_confidence boolean default false, -- SKU매칭 약함/표본부족
  checked_at timestamptz default now()
);
create index if not exists idx_beseller_compare_grade on jimscanner_beseller_price_compare (grade, margin_rate desc);
alter table jimscanner_beseller_price_compare enable row level security;
