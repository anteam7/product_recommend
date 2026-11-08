-- 쿠팡 반품·취소 요청(출고중지요청 포함) (2026-11-08) — 주문 수집과 같은 회차에 갱신
-- 수집: scripts/lib/coupang-orders-sync.mjs syncReturnRequests
--       (매시 크론 local-cron-orders-sync.mjs + 관리자 [지금 수집] 버튼 → order-server 둘 다)
-- 쿠팡 API: GET /v2/providers/openapi/apis/api/v6/vendors/{vendorId}/returnRequests
--   상태 없이 부르면 400 → status=RU(출고중지요청)·UC(반품접수)·PR(쿠팡확인요청)·CC(반품완료) + cancelType=CANCEL(출고 전 취소) 따로 조회.
--   검색 기간 최대 31일. 창 밖으로 밀린 미처리 접수는 orderId + 접수일 기준 31일로 다시 조회.
-- 개인정보(requester* 이름·전화·주소, reasonPhotoUrls)는 저장하지 않는다.
-- 화면: /admin/orders 쿠팡 행의 마켓 상태 칸 배지 + "처리 대기" 배너(출고중지요청·반품접수 건수).
create table if not exists public.jimscanner_coupang_return_requests (
  receipt_id             bigint primary key,          -- 쿠팡 접수번호(receiptId)
  order_id               bigint not null,             -- jimscanner_coupang_orders.order_id 와 조인
  receipt_type           text,                        -- RETURN(반품·출고중지) | CANCEL(출고 전 취소)
  receipt_status         text,                        -- RELEASE_STOP_UNCHECKED 출고중지요청 | RETURNS_UNCHECKED 반품접수
                                                      -- | VENDOR_WAREHOUSE_CONFIRM 입고완료 | REQUEST_COUPANG_CHECK 쿠팡확인요청 | RETURNS_COMPLETED 완료
  release_stop_status    text,                        -- 미처리 | 처리(출고중지) | 처리(이미출고) | 비대상 …
  reason_category1       text,                        -- 고객변심 · 오류 · 상품불량 …
  reason_category2       text,
  reason                 text,
  cancel_count           int,                         -- cancelCountSum
  fault_by_type          text,                        -- CUSTOMER | VENDOR | COUPANG | WMS | GENERAL
  return_shipping_charge int,
  items                  jsonb,                       -- returnItems: vendorItemId·shipmentBoxId·cancelCount·purchaseCount·releaseStatus(Y출고·N미출고·S출고중지·A이미출고)·상품명
  return_delivery        jsonb,                       -- 회수 송장 returnDeliveryDtos
  requested_at           timestamptz,                 -- createdAt
  modified_at            timestamptz,
  completed_at           timestamptz,                 -- completeConfirmDate
  raw_payload            jsonb,                       -- 개인정보 뺀 원문(변경 감지용)
  first_seen_at          timestamptz not null default now(),
  last_synced_at         timestamptz not null default now()
);
create index if not exists idx_coupang_returns_order on public.jimscanner_coupang_return_requests (order_id);
create index if not exists idx_coupang_returns_status on public.jimscanner_coupang_return_requests (receipt_status);

-- RLS: anon 접근 차단. 모든 접근은 service_role(크론·어드민 서버 컴포넌트) 경유.
alter table public.jimscanner_coupang_return_requests enable row level security;
