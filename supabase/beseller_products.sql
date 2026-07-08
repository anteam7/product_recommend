-- 비셀러(beseller.net, Makeshop 도매몰) 상품 카탈로그 (2026-07-08)
-- 수집: scripts/beseller-collect.mjs (로그인→갤러리 xcode=006 8개 카테고리→더보기 루프→상세)
-- 품절 갱신: scripts/beseller-stock-refresh.mjs (목록 스캔 + 미노출분 상세 확인)
-- 변형 그룹핑: group_key = 상품명에서 수량(*N)·무게/수량 토큰 제거 정규화
create table if not exists jimscanner_beseller_products (
  branduid text primary key,            -- Makeshop 상품 ID (shopdetail.html?branduid=)
  product_code text,                    -- 상품코드 (예: PL0012552)
  title text,                           -- 상품명
  group_key text,                       -- 변형 그룹 키 (수량/무게 제거 정규화명)
  variant_label text,                   -- 변형 라벨 (예: 250g*3)
  cate_mcode text,                      -- 카테고리 코드 001~008
  cate_label text,                      -- 카테고리명 (가공식품 등)
  supply_price int,                     -- 공급가격(원)
  tax_note text,                        -- 면세/과세 표기
  min_sell_price int,                   -- 최저판매가(원, 있을 때)
  composition text,                     -- 구성
  order_deadline text,                  -- 발주마감시간
  shipping_note text,                   -- 배송안내(배송비)
  extra_ship_fee text,                  -- 추가배송비
  blocked_channels text,                -- 판매불가채널
  carrier text,                         -- 택배사
  expiry_text text,                     -- 소비기한
  origin text,                          -- 원산지
  jeju_islands text,                    -- 제주/도서배송 여부
  ship_from text,                       -- 출고지
  return_to text,                       -- 반품지
  supplier_nick text,                   -- 공급사 닉네임
  member_grade text,                    -- 구매등급 (플러스회원 등)
  thumb_url text,                       -- 썸네일
  detail_images jsonb,                  -- 상세설명 이미지 URL 배열
  detail_url text,                      -- 상품 URL
  status text not null default 'active',-- active | soldout | gone(목록 제거)
  raw_info jsonb,                       -- infos--row 라벨:값 전체 (컬럼 매핑 밖 필드 보존)
  content_hash text,                    -- 변동 감지 (가격/구성/상태)
  first_seen_at timestamptz default now(),
  last_seen_at timestamptz default now(),
  last_changed_at timestamptz default now(),
  soldout_checked_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_beseller_group on jimscanner_beseller_products (group_key);
create index if not exists idx_beseller_status on jimscanner_beseller_products (status, cate_mcode);
alter table jimscanner_beseller_products enable row level security;
