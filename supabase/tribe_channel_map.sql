-- Tribe → Ad Channel 매칭 (커뮤니티별 광고 매체 추천)
-- raw market_raw 데이터로부터 커뮤니티별 키워드 점유율 → 트라이브 핑거프린트 → 채널 매핑

-- 1) 커뮤니티별 키워드 점유율 (cron 또는 view 로 채워짐)
create table if not exists public.jimscanner_tribe_keyword_share (
  id uuid primary key default gen_random_uuid(),
  community_id text not null,          -- 'clien_park' | 'quasarzone_sale' | 'naver_blog' | '82cook' | 'natepan' | 'ppomppu' | 'dcinside'
  keyword text not null,               -- 정규화된 키워드 (소문자, 트림)
  share_pct numeric(6,3) not null default 0,   -- 해당 커뮤니티 내 점유율 0~100
  dominance_idx numeric(6,3) not null default 0,  -- (해당 커뮤니티 점유율) / (전체 평균 점유율) — 1보다 크면 이 커뮤니티에 편중
  window_days int not null default 30,
  sample_count int not null default 0,
  computed_at timestamptz not null default now(),
  constraint uq_tribe_keyword_share unique (community_id, keyword, window_days)
);

create index if not exists idx_tribe_keyword_share_keyword
  on public.jimscanner_tribe_keyword_share (keyword, dominance_idx desc);
create index if not exists idx_tribe_keyword_share_community
  on public.jimscanner_tribe_keyword_share (community_id, share_pct desc);

alter table public.jimscanner_tribe_keyword_share enable row level security;

-- 2) 트라이브(커뮤니티) → 광고 채널 매핑 (휴리스틱, 수동 큐레이션)
create table if not exists public.jimscanner_tribe_channel_map (
  id uuid primary key default gen_random_uuid(),
  community_id text not null,
  tribe_label text not null,                  -- '주부 (Family-CPG)', 'IT 매니아 (Power-User)' 등
  channel text not null,                      -- 'naver_cafe_ad' | 'naver_powerlink' | 'kakao_moment' | 'instagram_feed' | 'youtube_shorts' | 'naver_brand_search' | 'meta_reels'
  channel_label text not null,                -- 사람용 라벨
  priority int not null default 0,            -- 1=Top
  expected_ctr_low numeric(5,2),              -- CTR 밴드 하한 (%)
  expected_ctr_high numeric(5,2),             -- CTR 밴드 상한 (%)
  copy_tone text,                             -- '신뢰·가족 안심형', '벤치마크 스펙 비교형' 등
  note text,
  created_at timestamptz not null default now(),
  constraint uq_tribe_channel_map unique (community_id, channel)
);

create index if not exists idx_tribe_channel_map_community
  on public.jimscanner_tribe_channel_map (community_id, priority);

alter table public.jimscanner_tribe_channel_map enable row level security;

-- 3) 초기 시드 — 휴리스틱 매핑 (한국 마케팅 업계 통념 기반, 추후 ROAS 데이터로 보정)
insert into public.jimscanner_tribe_channel_map
  (community_id, tribe_label, channel, channel_label, priority, expected_ctr_low, expected_ctr_high, copy_tone, note)
values
  -- 82cook = 주부 / Family-CPG
  ('82cook', '주부 (Family-CPG)', 'naver_cafe_ad', '네이버 카페광고', 1, 0.80, 1.80, '신뢰·가족 안심형', '맘카페 침투력 최고'),
  ('82cook', '주부 (Family-CPG)', 'kakao_moment', '카카오모먼트', 2, 0.50, 1.20, '실용·할인 직설형', '카톡 친구탭 노출'),
  ('82cook', '주부 (Family-CPG)', 'instagram_feed', '인스타그램 피드', 3, 0.40, 0.90, '비주얼·라이프스타일형', '30~40대 여성 도달'),

  -- ppomppu = 가성비러 / Deal-Hunter
  ('ppomppu', '가성비러 (Deal-Hunter)', 'naver_powerlink', '네이버 파워링크', 1, 1.20, 2.50, '최저가·즉시할인 강조형', '검색 의도 명확'),
  ('ppomppu', '가성비러 (Deal-Hunter)', 'kakao_moment', '카카오모먼트', 2, 0.70, 1.40, '쿠폰·핫딜 직설형', '딜 알림 친화'),
  ('ppomppu', '가성비러 (Deal-Hunter)', 'naver_brand_search', '네이버 브랜드검색', 3, 0.60, 1.10, '재고 한정·타임딜형', '브랜드 인지 + 전환'),

  -- dcinside = 오타쿠/남성 / Otaku-Male
  ('dcinside', '오타쿠/남성 (Otaku-Male)', 'youtube_shorts', '유튜브 쇼츠', 1, 0.90, 2.00, '서브컬쳐·밈·과몰입형', '갤러리 문화 친화'),
  ('dcinside', '오타쿠/남성 (Otaku-Male)', 'twitter_x_ad', 'X(트위터) 광고', 2, 0.50, 1.10, '오덕 인사이더형', '서브컬쳐 도달'),
  ('dcinside', '오타쿠/남성 (Otaku-Male)', 'instagram_feed', '인스타그램 피드', 3, 0.30, 0.70, '컬렉터블·굿즈형', '한정판 비주얼'),

  -- natepan = 청년여성 / GenZ-Female
  ('natepan', '청년여성 (GenZ-Female)', 'instagram_feed', '인스타그램 피드', 1, 0.90, 2.00, '감성·스토리형', '20대 여성 핵심'),
  ('natepan', '청년여성 (GenZ-Female)', 'meta_reels', '메타 릴스', 2, 0.80, 1.80, '바이럴·후기형', '쇼츠 포맷'),
  ('natepan', '청년여성 (GenZ-Female)', 'tiktok_ad', '틱톡 광고', 3, 0.70, 1.50, '바이브·챌린지형', 'GenZ 도달'),

  -- clien (clien_park) = IT 매니아 / Power-User
  ('clien_park', 'IT 매니아 (Power-User)', 'naver_brand_search', '네이버 브랜드검색', 1, 0.80, 1.60, '스펙·벤치마크형', '구체 사양 비교 검색'),
  ('clien_park', 'IT 매니아 (Power-User)', 'youtube_shorts', '유튜브 쇼츠', 2, 0.70, 1.40, '리뷰·언박싱형', 'IT 유튜브 채널 연계'),
  ('clien_park', 'IT 매니아 (Power-User)', 'naver_powerlink', '네이버 파워링크', 3, 0.60, 1.20, '얼리어답터·신제품형', '검색 진입'),

  -- quasarzone (quasarzone_sale) = 하드웨어 매니아 / Hardware-Geek
  ('quasarzone_sale', '하드웨어 매니아 (Hardware-Geek)', 'naver_brand_search', '네이버 브랜드검색', 1, 0.90, 1.80, '벤치마크·수치 비교형', '제품명 검색 의도'),
  ('quasarzone_sale', '하드웨어 매니아 (Hardware-Geek)', 'naver_powerlink', '네이버 파워링크', 2, 0.70, 1.40, '재고·가격 즉시형', '핫딜성 검색'),
  ('quasarzone_sale', '하드웨어 매니아 (Hardware-Geek)', 'youtube_shorts', '유튜브 쇼츠', 3, 0.50, 1.10, '오버클럭·튜닝 가이드형', 'PC 리뷰 채널')
on conflict (community_id, channel) do nothing;
