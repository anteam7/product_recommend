-- 쿠팡 고객문의(상품 문의 + 콜센터 이관 문의) 건수·답변 상태 (2026-11-08) — 주문 수집과 같은 회차에 갱신
-- 수집: scripts/lib/coupang-orders-sync.mjs syncInquiries (매시 크론 + 관리자 [지금 수집])
-- 쿠팡 API(검색 기간 최대 7일):
--   상품 문의  GET /v2/providers/openapi/apis/api/v5/vendors/{vendorId}/onlineInquiries?answeredType=ALL — 답변 = commentDtoList 있음
--   콜센터 문의 GET …/callCenterInquiries?partnerCounselingStatus=NONE(전체) — 판매자 답변 필요 = NO_ANSWER·TRANSFER 조회에 든 건
-- 문의 본문·구매자 정보(buyerEmail·buyerPhone)는 저장하지 않는다 — 건수·답변 여부만(답변은 Wing에서).
-- 화면: /admin/orders 상단 기간 카드 "문의 N (미답변 M)".
create table if not exists public.jimscanner_coupang_inquiries (
  kind              text   not null,               -- online(상품 문의) | callcenter(콜센터 이관)
  inquiry_id        bigint not null,
  order_id          bigint,                        -- 콜센터 orderId / 상품 문의 orderIds[0]
  seller_product_id bigint,
  vendor_item_id    bigint,
  item_name         text,                          -- 콜센터 itemName(상품명)
  status            text,                          -- online: answered|unanswered · callcenter: csPartnerCounselingStatus
  needs_answer      boolean not null default false,
  inquired_at       timestamptz,
  answered_at       timestamptz,
  first_seen_at     timestamptz not null default now(),
  last_synced_at    timestamptz not null default now(),
  primary key (kind, inquiry_id)
);
create index if not exists idx_coupang_inquiries_at on public.jimscanner_coupang_inquiries (inquired_at desc);
create index if not exists idx_coupang_inquiries_open on public.jimscanner_coupang_inquiries (needs_answer) where needs_answer;

alter table public.jimscanner_coupang_inquiries enable row level security;
