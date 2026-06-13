# ggsan ↔ 쿠팡 송장 동기화 — 구현 계획서 (승인용)

> 6개 설계안 + 적대적 검토를 통합한 단일 캐논(canon). 코드 사실은 `update/route.ts`·`local-cron-orders-sync.mjs`·`coupang-stock-sync/route.ts`·`order-server.mjs`를 직접 읽어 검증함. **승인 후 착수.**

---

## ① 목표 · 현황 요약

**목표**: 발주완료된 주문을 매입처(ggsan)와 자동 동기화한다.
- 발주 시 ggsan 주문번호를 저장해 매칭
- 매시간 ggsan에서 해당 주문의 상태/송장 확인 → 송장 발급 시 매입상태 `매입처발송`으로 전이
- 쿠팡에 송장 자동등록(반자동→자동 토글) → `발송완료(RECEIVED)`
- 기존 발송완료 3건 소급 보정 + 엣지케이스(취소·미결제·품절·반품·매입가 자동기록) 보강

**현황(검증)**:
- 주문 4건(RECEIVED 3 / ORDERED 1). RECEIVED 3건은 사용자가 송장 수동입력 + Wing 수동등록 완료분.
- `update/route.ts`는 송장 입력 시 내부 기록만 함(쿠팡 API 미호출). **쿠팡 자동등록은 100% 신규 기능 — 충돌 코드 없음.**
- orders-sync upsert는 `purchase_status`/`invoice_number`/`shipped_at`을 **건드리지 않음**(화이트리스트 방식). 현재는 안전하나 회귀 함정(→ ⑨ F-1).
- ggsan 로그인/쿠키 패턴은 `coupang-stock-sync/route.ts`에 완성형 존재. HMAC `sign`/`api`는 `local-cron-orders-sync.mjs`에 존재. **재사용 가능.**
- DDL은 사용자가 Supabase SQL 에디터에서 실행(psql 없음). scripts는 git 미추적 → 신규 스크립트는 **반드시 커밋**.

---

## ② 매입 상태머신 (캐논 확정)

설계안들이 상태값을 4~7개로 제각각 제안했다. **단일 캐논으로 확정**한다(적대적 검토 A-1 권고 채택):

- `purchase_status`에는 **`SHIPPED` 1개만 추가** (`RECEIVED` 재사용 금지 — 기존 3건 의미오염 + 돈 리스크 가시성 상실, 검토 A-2).
- 쿠팡 등록 결과는 `purchase_status`에 섞지 않고 **직교 컬럼 `coupang_invoice_status`(단일 text)** 로 분리. bool 컬럼 금지(상태 부족).
- 미결제·품절·반품·매칭실패는 enum을 늘리지 않고 **`needs_attention`(bool) + `attention_reason`(text)** 으로 가시화(상태 폭발 방지).

### 상태값

| `purchase_status` | 라벨 | 의미 |
|---|---|---|
| `PENDING` | 미발주 | 쿠팡 수집 직후 (기존) |
| `ORDERED` | 발주완료 | ggsan 발주(결제)·주문번호 확보 (기존) |
| **`SHIPPED`** (신규) | 매입처발송 | ggsan 송장 발급 감지. 쿠팡 등록 대기/진행 |
| `RECEIVED` | 발송완료 | **쿠팡 송장 등록 성공** (의미 명확화) |
| `CANCELLED` | 취소 | 취소/반품 (기존) |

| `coupang_invoice_status` (직교) | 의미 |
|---|---|
| `none` | 아직 송장 없음 (기본값) |
| `pending` | ggsan 송장 확보, 쿠팡 등록 대기 |
| `acknowledged` | 상품준비중(acknowledgement) 완료 |
| `uploaded` | invoices API 성공 → `RECEIVED` 전이 |
| `duplicate` | 6개월내 동일송장(이미 등록됨) — 약한 needs_attention |
| `manual_done` | Wing 수동등록 완료(소급분) — 자동등록 안 함 |
| `failed` | 실패(재시도 대상) |

### 전이 다이어그램

```
PENDING ──(ggsan 발주·주문번호 저장)──▶ ORDERED
                                          │ (ggsan cron: invoiceNo 감지)
                                          ▼
                                       SHIPPED ──(쿠팡 invoices 성공)──▶ RECEIVED
                                       (coupang_invoice_status:               (uploaded/duplicate)
                                        pending→acknowledged→uploaded)
   any ──(취소/반품 수동 or ggsan 취소 감지)──▶ CANCELLED
```

### 전이 표

| from → to | 트리거 | 자동/수동 | 스탬프 | 가드 |
|---|---|---|---|---|
| PENDING→ORDERED | `ggsan_order_no` 저장 or 수동 | 둘다 | `purchase_ordered_at` | — |
| ORDERED→SHIPPED | cron이 order_view에서 invoiceNo 감지 | 자동 | `ggsan_invoice_number/carrier/shipped_at`, `coupang_invoice_status='pending'` | 수령인 일치(→⑨) |
| SHIPPED→RECEIVED | 쿠팡 invoices 200 성공 | 자동 | `coupang_invoice_status='uploaded'`, `coupang_invoice_uploaded_at`, `invoice_number`/`delivery_company`(쿠팡 미러), `shipped_at`, `purchase_received_at` | **status='uploaded'/'duplicate'면 재호출 금지** |
| SHIPPED 유지(에러) | ack/invoices 실패 | 자동 | `coupang_invoice_status='failed'`, `coupang_invoice_error`, attempts++ | attempts<5 재시도 |
| any→CANCELLED | 수동, 또는 ggsan='취소' 감지 | 수동(자동취소 금지) | — | ggsan 자동취소 절대 금지 |

**crash-safe 순서(검토 C-3)**: ①DB를 `SHIPPED`로만 커밋(RECEIVED 아님) → ②쿠팡 ack → ③invoices 성공 시 `RECEIVED`. 실패 시 SHIPPED + status='failed'로 남아 다음 cron이 `coupang_invoice_status IN ('pending','acknowledged','failed')`로 재시도.

---

## ③ DB 스키마 변경 — `supabase/coupang_ggsan_sync.sql` (idempotent)

> 사용자가 Supabase SQL 에디터에서 실행. **컬럼 추가 + 소급 백필 UPDATE + runs 테이블을 한 번에 실행**(검토 E-1/E-2: 따로 실행하면 그 사이 cron 1회가 돌아 사고).

### 추가 컬럼표

| 컬럼 | 타입 | 기본 | 의미 |
|---|---|---|---|
| `ggsan_order_no` | text | null | ggsan 16자리 주문번호(매칭 린치핀). **non-unique**(1주문:N라인 묶음발주, 검토 A-3) |
| `ggsan_match_method` | text | null | `manual`/`order-server`/`auto-recent`/`backfill` |
| `ggsan_order_status` | text | null | godomall 노출상태(입금대기/배송중/구매확정/취소/반품/교환) |
| `ggsan_actual_paid` | int | null | ggsan 실결제액(매입가 자동기록 소스, ⑧) |
| `ggsan_invoice_number` | text | null | 매입처 송장(원천) |
| `ggsan_carrier_name` | text | null | ggsan 택배사명(예 CJ대한통운) |
| `ggsan_shipped_at` | timestamptz | null | 매입처 발송 감지 시각 |
| `ggsan_last_checked_at` | timestamptz | null | cron 마지막 확인 시각 |
| `coupang_invoice_status` | text | `'none'` | ②의 7값 |
| `coupang_acknowledged_at` | timestamptz | null | 상품준비중 처리 시각 |
| `coupang_invoice_uploaded_at` | timestamptz | null | invoices 성공 시각 |
| `coupang_invoice_company_code` | text | null | 등록한 deliveryCompanyCode |
| `coupang_invoice_attempts` | int | `0` | 재시도 상한 가드 |
| `coupang_invoice_error` | text | null | 마지막 실패 사유 |
| `needs_attention` | boolean | `false` | 사람 확인 필요 플래그 |
| `attention_reason` | text | null | 사유(미결제/매칭실패/등록실패/반품/품절/택배사미매핑) |

기존 컬럼 `invoice_number`/`delivery_company`/`shipped_at` = **쿠팡 등록 송장의 미러**(자동등록 성공 시 ggsan_*에서 복사). 기존 수동 InvoiceCell 경로와 호환.

```sql
-- supabase/coupang_ggsan_sync.sql  (psql 없음 → SQL 에디터에서 통째로 실행)
-- 0) purchase_status 타입 확인(실행 전): enum이면 CHECK 대신 ALTER TYPE 필요.
--    select udt_name from information_schema.columns
--      where table_name='jimscanner_coupang_orders' and column_name='purchase_status';
--    (코드는 text 비교만 함 → text 컬럼일 확률 높음. enum이면 아래 (C) 블록 교체.)

-- A) 컬럼 추가
alter table public.jimscanner_coupang_orders
  add column if not exists ggsan_order_no               text,
  add column if not exists ggsan_match_method           text,
  add column if not exists ggsan_order_status           text,
  add column if not exists ggsan_actual_paid            integer,
  add column if not exists ggsan_invoice_number         text,
  add column if not exists ggsan_carrier_name           text,
  add column if not exists ggsan_shipped_at             timestamptz,
  add column if not exists ggsan_last_checked_at        timestamptz,
  add column if not exists coupang_invoice_status        text default 'none',
  add column if not exists coupang_acknowledged_at       timestamptz,
  add column if not exists coupang_invoice_uploaded_at   timestamptz,
  add column if not exists coupang_invoice_company_code  text,
  add column if not exists coupang_invoice_attempts      int default 0,
  add column if not exists coupang_invoice_error         text,
  add column if not exists needs_attention               boolean not null default false,
  add column if not exists attention_reason              text;

update public.jimscanner_coupang_orders set coupang_invoice_status='none' where coupang_invoice_status is null;
update public.jimscanner_coupang_orders set coupang_invoice_attempts=0   where coupang_invoice_attempts is null;

-- B) 인덱스
create index if not exists idx_coupang_orders_ggsan_order_no
  on public.jimscanner_coupang_orders (ggsan_order_no) where ggsan_order_no is not null;   -- non-unique!
create index if not exists idx_coupang_orders_invoice_pending
  on public.jimscanner_coupang_orders (purchase_status, coupang_invoice_status);

-- C) purchase_status에 'SHIPPED' 허용 (text + CHECK 가정. enum이면 alter type ... add value 'SHIPPED')
do $$
begin
  if exists (select 1 from information_schema.constraint_column_usage
             where table_name='jimscanner_coupang_orders' and column_name='purchase_status'
               and constraint_name='jimscanner_coupang_orders_purchase_status_check') then
    alter table public.jimscanner_coupang_orders
      drop constraint jimscanner_coupang_orders_purchase_status_check;
  end if;
  -- CHECK 제약이 원래 없었다면(앱 레이어 검증만) 이 줄로 새로 추가해도 무방.
  alter table public.jimscanner_coupang_orders
    add constraint jimscanner_coupang_orders_purchase_status_check
    check (purchase_status in ('PENDING','ORDERED','SHIPPED','RECEIVED','CANCELLED'));
exception when others then
  -- 제약 추가가 기존 데이터와 충돌하거나 enum이면 무시(사용자가 수동 처리)
  raise notice 'purchase_status 제약 처리 스킵: %', sqlerrm;
end $$;

-- D) 소급 보정: 기존 RECEIVED + invoice_number 있는 건 = Wing 수동등록 완료 → 재등록 금지(검토 E-1)
update public.jimscanner_coupang_orders
set coupang_invoice_status='manual_done',
    coupang_invoice_uploaded_at=coalesce(shipped_at, updated_at),
    ggsan_invoice_number=coalesce(ggsan_invoice_number, invoice_number),
    ggsan_carrier_name=coalesce(ggsan_carrier_name, delivery_company),
    ggsan_shipped_at=coalesce(ggsan_shipped_at, shipped_at)
where purchase_status='RECEIVED' and invoice_number is not null;
```

### runs 테이블 — `supabase/coupang_ggsan_sync_runs.sql`

```sql
create table if not exists public.jimscanner_coupang_ggsan_sync_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',         -- running|success|error
  triggered_by text,
  tracked_count int default 0,    -- ggsan 조회한 대상 수
  shipped_count int default 0,    -- 신규 SHIPPED 전이
  invoice_ok_count int default 0, -- 쿠팡 등록 성공
  duplicate_count int default 0,  -- 중복(기등록)
  invoice_err_count int default 0,
  attention_count int default 0,  -- needs_attention 신규
  error_count int default 0,
  duration_ms int,
  error_message text
);
create index if not exists idx_coupang_ggsan_sync_runs_started
  on public.jimscanner_coupang_ggsan_sync_runs (started_at desc);
```

---

## ④ ggsan 발송 동기화 크론

**신규**: `scripts/local-cron-ggsan-sync.mjs` (+ `.cmd` 래퍼 + Windows 작업 `Coupang-Ggsan-Sync`). orders-sync와 **별도**(실패 격리: ggsan HTML 파싱이 깨져도 쿠팡 주문수집은 계속). orders-sync 후 +30분 오프셋, 매시간.

구조 = `local-cron-orders-sync.mjs` 헤더(env/`sb`/`sign`/`api`) + `coupang-stock-sync/route.ts`의 ggsan 로그인/쿠키 포팅.

```
1. runs insert(running); settings.auto_upload 읽기(⑤)
2. ggsanLogin()  (성공판정: parent.location 마커 OR /mypage/order_list.php 보호페이지 접근 가능)
3. 대상 = orders where
     coupang_invoice_status in ('none','pending','acknowledged','failed')
     and purchase_status in ('ORDERED','SHIPPED')
     and ggsan_order_no is not null
     (+ ggsan_order_no IS NULL AND ORDERED → auto-recent 매칭 후보, 확정은 사람)
4. for row of 대상.slice(0,100):  (deadline 5분 가드)
     state = GET /mypage/order_view.php?orderNo=<ggsan_order_no> 파싱
       → ggsan_order_status, invoiceNo, carrier, 실결제액, 수령인명
     항상 ggsan_order_status / ggsan_last_checked_at 갱신
     ── 분기 ──
     '취소/반품/교환' → needs_attention + attention_reason, 쿠팡등록 skip (자동취소 금지)
     '입금대기' & ordered_at+Nh 경과 → needs_attention='미결제 지연'
     실결제액 있고 purchase_total_cost 비었으면 → ggsan_actual_paid + 자동기록(⑧)
     송장 없음 → 다음 건
     송장 있음(신규):
        ① DB: SHIPPED + ggsan_invoice_number/carrier/shipped_at + coupang_invoice_status='pending'
        ② 쿠팡 송장등록(⑤) — auto_upload면 즉시, 아니면 pending 유지(반자동)
     sleep(300ms)
5. runs update(success, 집계)
```

택배사 매핑: `scripts/lib/coupang-carrier-map.mjs`(git 커밋). ggsan 직배송 관측치 `CJ대한통운→CJGLS`. **미매핑 시 자동등록 금지 + needs_attention='택배사 미매핑'**(추측 등록 절대 금지, 검토 C-6).

---

## ⑤ 쿠팡 송장 자동등록 (+ 반자동 토글)

**단일 진실 소스**: 업로드 코어를 **API 라우트 `POST /api/admin/coupang-orders/register-invoice`** 에 둔다(어드민 세션 **또는** `Bearer CRON_SECRET` 허용, stock-sync 패턴). 크론(.mjs)은 자동모드일 때 이 라우트를 호출 → 로직 단일화(.mjs/route 중복 구현 방지, 검토 권고).

**2단계 호출**:
1. `PUT .../vendors/{vendorId}/ordersheets/acknowledgement` (상품준비중) body `{vendorId, shipmentBoxIds:[shipment_box_id]}` → `coupang_acknowledged_at`. 이미 처리된 박스 에러는 **응답으로 구분해** 멱등 무시(검토 C-1: 무지성 무시 금지).
2. `POST .../vendors/{vendorId}/orders/invoices` body `{vendorId, orderSheetInvoiceApplyDtos:[{shipmentBoxId, orderId, vendorItemId, deliveryCompanyCode, invoiceNumber, splitShipping:false, preSplitShipped:false, estimatedShippingDate:''}]}`. HMAC 서명 = `dt+method+urlPath`(query 없음).

**업로드 직전 hard gate 3개(돈 안전, 통과 못 하면 abort + needs_attention)**:
- 쿠팡 현재 status가 취소/반품이면 abort(검토 D-1) — invoices 직전 ordersheet 단건 재조회
- ggsan 수령인명 ≠ orders.`receiver_name`이면 abort(검토 B-3 오매칭 차단)
- deliveryCompanyCode 매핑 실패면 abort(검토 C-6)

**응답 처리**:
- 200 성공 → `coupang_invoice_status='uploaded'`, `purchase_status='RECEIVED'`, 미러 컬럼 복사
- "6개월내 중복/이미 등록" → `duplicate`(성공 간주하되 **약한 needs_attention** — 오매칭 은폐 방지, 검토 C-4). 정규식 대신 가능하면 에러코드 기반
- 그 외 실패 → `failed` + error + attempts++. attempts≥5면 자동재시도 중단 + needs_attention
- `estimatedShippingDate:''` 거부 시 → `ggsan_shipped_at`의 KST yyyy-MM-dd 폴백(검토 C-5, 첫 실거래 응답으로 확인)

**토글**: `jimscanner_coupang_invoice_settings(id=1, auto_upload bool default false)` 단일행 테이블. **초기 반자동**(크론은 발송감지·검증·`pending`까지만, 사람이 UI에서 [확인·등록]). 첫 수십 건 무오류 후 `auto_upload=true` 전환. `POST /api/admin/coupang-orders/invoice-settings`.

---

## ⑥ 관리자 UI / 플로우 변경

- **`page.tsx`**: `PurchaseStatus`에 `SHIPPED` 추가; `PURCHASE_STATUS_LABELS`에 `SHIPPED:{label:'매입처발송', cls:'bg-sky-100 text-sky-700'}`. `OrderRow`에 신규 컬럼 필드(`select('*')`라 SELECT 변경 불필요). 신규 "매입처(ggsan)" 컬럼 + 상단 `needs_attention` 카운트 배너. 하단 안내문구 "송장은 Wing에서 직접" → "송장 등장 시 매시간 자동 등록"으로 수정.
- **`PurchaseStatusCell.tsx`**: `SHIPPED` 옵션/색 추가. ORDERED/SHIPPED일 때 **ggsan 주문번호 16자리 입력란** 조건부 노출(blur 저장). 번호 없이도 ORDERED 가능하되 "주문번호 입력 시 자동 추적" 회색 안내.
- **신규 `GgsanTrackingCell.tsx`**(읽기+버튼): ggsan 발송상태 배지 + 매입처 송장(택배사·번호) + `coupang_invoice_status` 배지(✓쿠팡등록/🟡등록대기[확인·등록]/🔴실패[재시도]/⚪중복/회색 manual_done) + order_view 링크. 반자동 [확인·등록] = `register-invoice` 호출.
- **`update/route.ts`**: `PURCHASE_STATUSES`에 `'SHIPPED'` 추가; `SHIPPED` 전이 스탬프; **L111 가드에 `&& !== 'SHIPPED'` 추가**(검토 C-2); `ggsan_order_no` 필드 수용(`/^\d{16}$/` 검증, source='manual'); 수동 송장 입력 시 `coupang_invoice_status='pending'`으로 세팅해 cron이 등록하게(또는 `manual_done` 선택지).
- **`coupang-publish/page.tsx`**: 기존 stock/orders runs 위젯 패턴으로 `jimscanner_coupang_ggsan_sync_runs` 카드 추가(미생성 시 `?? null` 폴백).

---

## ⑦ 기존 주문 소급 수집

- **RECEIVED 3건**: ③-D UPDATE로 `coupang_invoice_status='manual_done'` 마킹 → cron 대상에서 자동 제외(재등록=6개월 중복 에러 + 배송비 방지). **이 UPDATE는 컬럼 추가 SQL과 같은 실행에 포함**(E-1).
- **ggsan_order_no 백필(선택)**: 추적 일관성 위해 `scripts/ggsan-backfill-order-no.mjs`(1회성)로 order_list 스캔 + 수령인+상품+발주일 휴리스틱. **자동확정 금지 — `_tmp_*.json` 덤프 → 검수 → `--apply`**, 모호 건은 needs_attention. manual_done 건의 쿠팡 재업로드는 절대 안 함.
- **ORDERED 1건**: 파일럿. ggsan_order_no 수동/자동 연결 후 신규 플로우 첫 검증 대상.

---

## ⑧ 추가 보강 기능 / 엣지케이스 대응

| # | 케이스 | 처리 |
|---|---|---|
| 미결제(입금대기) | order-server는 결제 직전 정지 → 사람이 결제 안 하면 미발송 | ggsan='입금대기' 감지 + ordered_at+Nh → needs_attention='미결제 지연' |
| 쿠팡 취소↔ggsan 발송 경합 | 최대 돈 리스크 | invoices **직전 ordersheet 재조회 hard gate**, ggsan='취소' 감지 시 CANCELLED 자동 + 알림. ggsan 자동취소 금지 |
| 반품/교환 | RECEIVED인데 RETURNS → 실수익 과대 | shipping_status='RETURNS' or ggsan='반품/교환' → needs_attention, 실수익 제외 정책(결정 필요) |
| ggsan 품절(발송불가) | 결제 후 품절통보 | 진행 정지 + `checkStock` 재사용 → needs_attention='발송불가 가능성' |
| 송장 재발급 | 반송 후 재배송 | ggsan_invoice_number 변경 감지 → 재등록 + purchase_note append(6개월 중복 주의) |
| 다상품 묶음발주(1:N) | 한 ggsan 주문=쿠팡 라인 N개 | ggsan_order_no non-unique, 라인별 vendorItemId 개별 invoices 호출 |
| vendor_item_id null 과거행 | 등록 불가 | skip + needs_attention='vendorItemId 없음' |
| **매입가 자동기록** | 매입원가 수동입력 중 | order_view 실결제액 파싱 → purchase_total_cost 비었을 때만 자동 채움(수동값 우선) |
| 배송완료 추적 | | 쿠팡 shipping_status는 orders-sync가 FINAL_DELIVERY까지 자동 전이(기존), ggsan '구매확정'도 기록 |

---

## ⑨ 리스크 · 안전장치 (특히 돈/배송)

- **F-1 회귀 함정(검증됨)**: orders-sync upsert가 현재 `purchase_status`/`invoice_number`/`shipped_at`/ggsan 컬럼을 안 건드려 안전. **`local-cron-orders-sync.mjs:95-117` upsert row에 주석 추가**: "ggsan_*/coupang_invoice_*/purchase_status/invoice_number/shipped_at 추가 금지(ggsan cron 소유)". 향후 누가 송장 미러를 추가하면 즉시 회귀.
- **돈 hard gate 3개**(⑤): 취소/반품 abort · 수령인 불일치 abort · 택배사 미매핑 abort. 모두 needs_attention.
- **중복 송장**: `coupang_invoice_status IN ('uploaded','duplicate','manual_done')`은 cron 대상에서 구조적 제외. 동일 ggsan_invoice_number 재감지 시 no-op. 쿠팡 중복에러는 `duplicate`로 흡수하되 약한 needs_attention(오매칭 은폐 방지).
- **crash-safe 순서**: SHIPPED 먼저 커밋 → 쿠팡 성공 시 RECEIVED. 재시도 누락 없음.
- **휴리스틱 자동확정 금지**: 매칭은 후보 제시(UI)만, 확정은 사람 1클릭. score≥80도 자동확정 안 함.
- **사각지대 가시화**: ggsan_order_no 없는 ORDERED(Nh 경과)·미결제·품절·반품을 needs_attention 배너로 강제 노출.
- **ggsan 세션 만료**: 로그인 실패 시 그 회차 전체 중단 + runs=error(쿠팡 호출 안 함, 데이터 무손상), 다음 회차 재시도.
- **scripts 유실**: 신규 .mjs/.cmd/매핑표 **git 커밋 필수**.

---

## ⑩ 구현 단계

**Phase 0 — 캐논 합의 게이트(승인)**: ②상태머신 + 컬럼명 단일화 확정. (이 문서 승인이 곧 Phase 0)

**Phase 1 — DB + 단일 진실 소스 + 검증(자동 OFF)**
1. `supabase/coupang_ggsan_sync.sql`(컬럼+소급 UPDATE+CHECK) + `coupang_ggsan_sync_runs.sql` → **사용자 SQL 에디터 실행**(컬럼+백필 동시). purchase_status 타입 먼저 확인.
2. `scripts/lib/coupang-carrier-map.mjs`.
3. `POST /api/admin/coupang-orders/register-invoice`(검증+ack+invoices+DB갱신, 어드민/CRON_SECRET, hard gate 3개).
4. `POST /api/admin/coupang-orders/invoice-settings`(auto_upload 토글, 기본 false).
5. `_tmp_ggsan_order_view.html` 1건 덤프 → 파싱 정규식 확정 + dry-run으로 ORDERED 1건 payload 검증.
산출물: SQL 2개, 매핑표, register-invoice/invoice-settings 라우트, 파싱 검증 결과.

**Phase 2 — 크론 + 발주번호 캡처 + UI**
6. `scripts/local-cron-ggsan-sync.mjs` + `.cmd` + Windows 작업 등록(orders-sync +30분).
7. `update/route.ts`(SHIPPED+ggsan_order_no+L111 가드) / `page.tsx` / `PurchaseStatusCell.tsx` / `GgsanTrackingCell.tsx` / `coupang-publish` 위젯.
8. `order-server.mjs` ggsan_order_no 캡처(검토 B-1: runFlow 내 폴링 불가 → 모듈 전역 Map + `/capture` 엔드포인트, 또는 결제 직후 order_list 최상단 추출). orders-sync upsert 회귀 방지 주석.
9. `scripts/ggsan-backfill-order-no.mjs`(dry-run→검수→--apply).
10. `npm run build` → **cron 레포이므로 커밋 전 사용자 확인** → 커밋.
산출물: 추적 크론, UI 일체, 캡처/백필 스크립트.

**Phase 3 — 자동 전환 + 보강**
11. 반자동으로 신규 송장 수 건 무오류 확인 → `auto_upload=true`.
12. 엣지케이스 보강(미결제/품절/반품 needs_attention, 매입가 자동기록), 알림 채널(⑪).

---

## ⑪ 사용자 승인 / 결정 필요 항목

1. **상태머신 캐논**: `SHIPPED` 1개 추가 + `coupang_invoice_status` 직교 분리(권고). RECEIVED 라벨은 '발송완료' 유지(='쿠팡 등록 완료'). **동의?**
2. **자동 vs 반자동**: 초기 **반자동(auto_upload=false)** 으로 시작 → 무오류 확인 후 자동 전환(권고). 동의?
3. **ggsan 주문번호 입력 방식**: (a) 수동입력(가장 안정) + (b) order-server `/capture` 자동캡처 + (c) auto-recent 휴리스틱(후보만, 사람 확정). 우선순위는 **a 표준 + b 보조 + c 폴백**(권고). 자동캡처를 Phase 2에 포함할지, 아니면 우선 수동입력만으로 출시할지?
4. **택배사 코드 검증**: 롯데/로젠/GS 등 레거시 코드는 쿠팡 `deliveries` 조회 API로 1회 확정 필요. ggsan 실관측은 CJ대한통운=CJGLS 단일. **CJGLS만으로 출시하고 나머지는 미매핑→needs_attention** 처리해도 되는지?
5. **ggsan 자동취소 금지** 정책 동의(권고: 금지, 사람 확인)?
6. **반품 시 실수익 제외** 정책: RETURNS를 실수익에서 뺄지(매출 과대 방지)?
7. **알림 채널**: needs_attention을 UI 배너만으로 충분한지, 아니면 Gmail 등 push까지(미발송/등록실패 같은 돈·배송 직결 건)?
8. **purchase_status 타입**: enum이면 `ALTER TYPE ADD VALUE` 필요 — SQL 실행 전 타입 확인 OK?

### 신규/수정 파일 (절대경로)

신규: `C:\Web\jimscanner-personal\supabase\coupang_ggsan_sync.sql`, `...\supabase\coupang_ggsan_sync_runs.sql`, `...\scripts\local-cron-ggsan-sync.mjs`(+`.cmd`), `...\scripts\lib\coupang-carrier-map.mjs`, `...\scripts\ggsan-backfill-order-no.mjs`, `...\src\app\api\admin\coupang-orders\register-invoice\route.ts`, `...\src\app\api\admin\coupang-orders\invoice-settings\route.ts`, `...\src\app\admin\(dashboard)\coupang-orders\GgsanTrackingCell.tsx`

수정: `...\src\app\api\admin\coupang-orders\update\route.ts`, `...\src\app\admin\(dashboard)\coupang-orders\page.tsx`, `...\PurchaseStatusCell.tsx`, `...\InvoiceCell.tsx`, `...\src\app\admin\(dashboard)\coupang-publish\page.tsx`, `...\scripts\order-server.mjs`, `...\scripts\local-cron-orders-sync.mjs`(회귀방지 주석)

재사용 패턴 출처: `...\src\app\api\cron\coupang-stock-sync\route.ts`(ggsanLogin/쿠키/coupangApi), `...\scripts\local-cron-orders-sync.mjs`(env/sign/api/runs로깅/onConflict='order_item_id'), `...\supabase\coupang_orders_sync_runs.sql`(runs DDL)

---

# [부록] 적대적 검토 원문

# 적대적 검토: ggsan↔쿠팡 송장 동기화 6개 facet 설계안

코드를 직접 읽고 검증했다. 각 지적은 **[근거] → [문제] → [권고]** 형식. 심각도 표기: 🔴치명(돈/배송 손실) / 🟠중대(데이터 정합·자동화 오작동) / 🟡경미.

---

## A. Facet 간 직접 모순 (먼저 해결해야 나머지가 성립)

**A-1 🔴 상태머신 자체가 facet마다 다르다 — 합의 없이는 구현 불가**
- [근거] `schema-statemachine`은 enum에 `SUPPLIER_SHIPPED` 추가(6값), 쿠팡 등록은 `coupang_invoice_status`로 분리. `ggsan-sync-cron`은 **enum 추가 반대**, `RECEIVED`를 "매입처 발송"으로 재사용. `ui-flow`는 `SHIPPED` 신규값 추가(별도 명칭). `edgecases-extras`는 `GGSAN_PAID_WAIT`/`GGSAN_SOLDOUT`/`RETURNED`까지 추가(7값). `backfill`/`coupang-invoice-auto`는 또 다른 컬럼명(`coupang_invoice_upload_status` vs `coupang_invoice_status` vs `coupang_invoice_uploaded`).
- [문제] 컬럼명·enum이 facet마다 충돌. 그대로 합치면 같은 개념에 3개 컬럼(`coupang_invoice_uploaded`(bool) + `coupang_invoice_status`(text) + `coupang_invoice_upload_status`(text))이 생겨 데이터가 갈라진다. "RECEIVED 재사용 vs SHIPPED 신규"는 양립 불가능한 근본 결정.
- [권고] **구현 착수 전 단일 캐논(canon) 확정 필수.** 권고 캐논: (1) `purchase_status`에 **`SHIPPED` 1개만 추가**(의미 명확, RECEIVED 재사용은 기존 3건 의미오염). (2) 쿠팡 등록은 **단일 text 컬럼 `coupang_invoice_status`**(`none|pending|acknowledged|uploaded|duplicate|failed|manual_done`)로 일원화, bool 컬럼 금지(상태 부족). (3) ggsan 컬럼 prefix는 `ggsan_*`로 통일. 이 캐논을 SQL/route/cron/UI 4곳에 동일 적용.

**A-2 🔴 "RECEIVED 재사용"안은 기존 자동전이 로직과 직접 충돌**
- [근거] `update/route.ts:111` — 송장 입력 시 `purchase_status !== 'RECEIVED'`일 때만 RECEIVED 승격. `ggsan-sync-cron`/`coupang-invoice-auto`는 ggsan 송장 감지 시 곧장 `purchase_status='RECEIVED'`로 직행.
- [문제] `SHIPPED`(매입처 발송, 쿠팡 미등록) 단계를 RECEIVED에 흡수하면, "매입처는 보냈지만 쿠팡 등록 실패" 상태를 purchase_status로 표현 못 한다. 사용자/UI는 RECEIVED=끝난 것으로 보는데 실제로는 쿠팡 미반영 → **미등록 배송비 셀러 부담**(브리프 명시 리스크)을 놓친다.
- [권고] `SHIPPED`(매입처발송) → 쿠팡 등록 성공 시에만 `RECEIVED`. 두 단계 분리가 돈 리스크 가시성의 핵심. `update/route.ts:111`의 가드에 `&& !== 'SHIPPED'` 추가 필요(아래 C-2).

**A-3 🟠 ggsan_order_no UNIQUE 인덱스 — facet 간 모순이자 데이터 모델 오류**
- [근거] `backfill`은 `create unique index ... ggsan_order_no`. 그러나 `edgecases-extras`(엣지13)와 `coupang-invoice-auto`는 "한 ggsan 주문 1개에 쿠팡 라인 N개"(다상품 묶음발주)를 명시. orders 고유키는 `order_item_id`(라인 단위, 검증됨 line 118).
- [문제] 한 ggsan 주문번호로 여러 쿠팡 라인을 한 번에 발주하면 `ggsan_order_no`가 여러 행에 중복 → **UNIQUE 제약이 백필/저장 시 violation**으로 터진다.
- [권고] `ggsan_order_no`는 **일반 인덱스**(non-unique). 1:N 허용. 멱등성은 `coupang_invoice_status`로 보장.

---

## B. 발주 시 ggsan 주문번호 캡처 — 린치핀이 가장 약함

**B-1 🔴 order-server 자동캡처 설계가 코드 현실과 불일치**
- [근거] `order-server.mjs`: `runFlow`는 수령인 입력 후 **`return`하고 종료**(line 79). 브라우저는 열어두지만 **함수는 이미 반환했고 page 핸들도 스코프를 벗어난다**. HTTP 응답도 이미 보냄(line 106). `ui-flow`/`backfill`이 제안한 `page.waitForURL(/order_complete/)`를 걸 주체가 없다 — runFlow가 끝나서 리스너를 유지할 컨텍스트가 사라졌다.
- [문제] "결제완료 URL 폴링" 설계는 현재 구조에서 동작 불가. browser/ctx 참조를 함수 밖에서 들고 있어야 하는데 그렇지 않다.
- [권고] 둘 중 하나: (a) `runFlow`가 browser/ctx/page를 **모듈 전역 Map<orderId, {ctx,page}>에 보관**하고 별도 `/capture?id=` 엔드포인트(edgecases-extras 제안)가 그 page에서 `ctx.pages()` 중 `order_complete.php`를 찾아 orderNo 추출. (b) 더 단순·견고: 캡처를 포기하고 **결제 직후 order_list 최상단 1건 추출**을 `/capture`가 수행. 어느 쪽이든 "runFlow 내 폴링"은 폐기.

**B-2 🟠 ggsan_order_no 없는 ORDERED는 자동화가 영원히 멈춘다 (사일런트)**
- [근거] 모든 추적 크론 대상 쿼리가 `ggsan_order_no IS NOT NULL` 또는 backfill 휴리스틱 의존. 자동캡처(B-1)는 불안정, 수동입력은 사람 의존.
- [문제] 캡처 실패 시 주문이 ORDERED에 무한정 고착 → 송장 감지·쿠팡 등록 모두 안 됨 → 사용자는 자동화를 믿고 방치 → **배송 지연/미발송 페널티**.
- [권고] `ggsan_order_no IS NULL AND purchase_status='ORDERED' AND purchase_ordered_at < now()-Nh` 를 `needs_attention`으로 올려 UI 배너 강제 노출. 자동화의 사각지대를 사람에게 떠넘기되 **반드시 가시화**.

**B-3 🟠 휴리스틱 매칭은 동일상품 동시발주에서 오매칭 → 엉뚱한 송장이 쿠팡에 등록**
- [근거] `backfill`/`edgecases-extras` 휴리스틱: 수령인+상품+날짜. 같은 고객이 같은 상품을 2건(다른 옵션/수량) 주문하거나, 다른 고객이 같은 날 같은 상품을 받으면 후보가 갈린다.
- [문제] 오매칭 → A주문의 송장이 B주문으로 쿠팡 등록 → **고객에게 잘못된 추적번호 발송, 배송 클레임, 6개월 중복송장 잠금까지 연쇄**.
- [권고] 휴리스틱 자동확정 절대 금지(score≥80도 위험). 휴리스틱은 **후보 제시(UI 모달)만**, 확정은 사람 1클릭. `edgecases-extras`의 "수령인 교차검증"(엣지16)을 **업로드 직전 hard gate**로: ggsan order_view 수령인명 ≠ orders.receiver_name이면 무조건 abort+needs_attention.

---

## C. 쿠팡 송장 등록 호출 — 순서·실패·중복

**C-1 🔴 acknowledgement body 형태가 facet마다 다르고 전부 미검증**
- [근거] `schema-statemachine`/`ggsan-sync-cron`: `{vendorId, shipmentBoxIds:[...]}`. 브리프 본문: path만 명시, body 미상. `coupang-invoice-auto`도 "첫 호출로 확정 필요"라고 자인.
- [문제] body 키(`shipmentBoxIds` 단/복수)가 틀리면 ack 400 → 일부 facet은 "ack 실패해도 invoices 진행"인데, ack 미완 상태(ACCEPT/INSTRUCT)면 invoices도 거부될 수 있어 **연쇄 실패**.
- [권고] 구현 전 쿠팡 문서/실호출 1회로 body 확정(dry-run 모드 필수). ack는 **멱등 처리**: 이미 처리된 박스의 에러 코드를 식별해 무시하되, "미처리라서 난 에러"와 "이미 처리됨"을 응답으로 구분. 무지성 무시 금지.

**C-2 🔴 송장 입력 자동전이가 신규 SHIPPED 상태를 모른다**
- [근거] `update/route.ts:111`: `order.purchase_status !== 'CANCELLED' && !== 'RECEIVED'` → RECEIVED 승격. SHIPPED 추가 시 이 가드 미수정.
- [문제] cron이 `SHIPPED`로 만든 행에 사용자가 수동 송장 입력(폴백)하면, route가 곧장 RECEIVED 승격 → 쿠팡 등록 안 됐는데 RECEIVED. 그리고 **수동 입력 송장은 쿠팡 자동등록 대상에서 빠질 수 있다**(상태가 RECEIVED라 cron 쿼리 제외).
- [권고] 수동 송장 입력 시에도 `coupang_invoice_status`를 `pending`으로 세팅해 cron이 등록하게 하거나, 명시적으로 `manual_done`(Wing 직접) 선택지를 UI에 제공. route의 RECEIVED 승격 조건을 캐논(A-1)에 맞춰 재작성.

**C-3 🔴 "DB 먼저 RECEIVED 커밋 후 쿠팡 호출" 순서의 함정 (crash-safe 주장 반박)**
- [근거] `ggsan-sync-cron` §3: ①DB를 RECEIVED로 먼저 쓰고 ②③쿠팡 호출.
- [문제] ①에서 RECEIVED로 올렸는데 ②③ 실패 → 행이 RECEIVED + `coupang_invoice_uploaded=false`. 다음 회차 대상 쿼리가 "RECEIVED 제외"면 **재시도 누락**, "uploaded=false 포함"이면 OK지만 facet마다 쿼리가 다르다(A-1 미해결의 2차 피해).
- [권고] crash-safe하려면 ①은 `SHIPPED`로만 커밋(RECEIVED 아님). RECEIVED는 쿠팡 성공 후. 재시도 대상 쿼리는 반드시 `coupang_invoice_status IN ('pending','acknowledged','failed')` 기준(상태 컬럼 단일화가 전제).

**C-4 🟠 중복송장 에러 → "성공 간주" 휴리스틱이 위험할 수 있다**
- [근거] 여러 facet: 응답에 `/이미.*등록|중복|already|duplicate/i` 매칭 시 `duplicate`=성공 처리.
- [문제] (1) 쿠팡 에러 메시지 문구는 변할 수 있어 정규식 깨짐. (2) "다른 주문의 송장과 6개월 내 중복"일 수도 있는데(B-3 오매칭 결과) 이를 성공 처리하면 **오매칭을 영구 은폐**. (3) 메시지 한글/영문 혼재.
- [권고] 중복 에러는 성공이 아니라 **`duplicate` 별도 상태 + needs_attention 약한 플래그**로. "이 송장이 정말 이 주문 것인지" 1회 사람 확인 경로 유지. 정규식 대신 가능하면 쿠팡 에러 코드 기반 판정.

**C-5 🟠 estimatedShippingDate:"" 거부 가능성**
- [근거] 브리프 body 그대로 `""`. `edgecases-extras`(엣지18)만 지적.
- [문제] 쿠팡이 빈 문자열 거부 시 전 건 invoices 실패.
- [권고] 첫 실거래 응답으로 확인. 거부 시 `ggsan_shipped_at`(KST yyyy-MM-dd) 폴백. 미확인 채 자동화 활성 금지.

**C-6 🟠 택배사 코드 매핑이 facet마다 불일치 — 오등록=배송비 부담**
- [근거] 롯데: `schema-statemachine`=`LOTTE`, `coupang-invoice-auto`/`ggsan-sync-cron`=`HYUNDAI`, `backfill`=`LOTTE`. 로젠: `KGB` vs `KGB`(코드설명 불일치) vs `LOGEN`. GS: `GSMNTON` vs `CVSNET`.
- [문제] 매핑 충돌 = 추측. 틀리면 쿠팡 400(운 좋으면) 또는 **잘못된 택배사로 등록되어 추적 불가→배송 클레임**(운 나쁘면 통과).
- [권고] **쿠팡 택배사 코드 조회 API**(`GET .../deliveries` 또는 공식 코드표)로 1회 확정 후 상수 고정. ggsan 실관측은 CJ대한통운=CJGLS 단일이므로 **매핑 미스 시 자동등록 금지(needs_attention)**, 추측 등록 절대 금지. 매핑표는 git 커밋(scripts 미추적 유실 위험).

---

## D. 취소 / 환불 / 반품 / 미결제 (브리프 명시 점검 항목)

**D-1 🔴 쿠팡 취소 ↔ ggsan 발송 경합 — 가장 큰 돈 리스크인데 대부분 facet이 약함**
- [근거] orders-sync는 31일 윈도우로 status 갱신하지만, **취소는 ordersheets에서 주문이 빠지거나 별도 취소 API라 현재 코드로는 취소 감지 자체가 불확실**(orders-sync는 5개 status만 순회, 취소 status 없음 line 64).
- [문제] 쿠팡에서 고객이 취소 → 우리 DB는 여전히 ORDERED/SHIPPED → cron이 ggsan 송장 감지 → 쿠팡에 송장 등록 시도(이미 취소된 주문). 더 나쁘게는 **ggsan에 이미 발주·발송됨 → 셀러가 반품비/상품비 떠안음**.
- [권고] (1) 취소 감지 경로 추가: orders-sync에 쿠팡 취소/반품 status 조회 보강 또는 invoices 호출 직전 ordersheet 단건 재조회로 현재 status 확인. (2) **업로드 직전 hard gate**: 해당 order의 현재 쿠팡 shipping_status가 취소/반품이면 abort. (3) ggsan 자동취소는 금지(돌이킬 수 없음), needs_attention만.

**D-2 🟠 미결제(입금대기) — 자동주문이 결제까지 안 하는데 ORDERED로 표시되는 실제 흔한 누락**
- [근거] `order-server`는 결제 직전 정지(사람이 결제). `edgecases-extras`(엣지8)만 `GGSAN_PAID_WAIT` 제안.
- [문제] 사용자가 "결제진행"만 누르고 실결제를 안 하면 ggsan은 입금대기. 그런데 캡처가 ORDERED로 만들면 → 발송 안 됨 → 추적 크론은 송장 영원히 못 봄 → **고객 미발송**.
- [권고] ggsan order_view status='입금대기'를 명시 감지 → `GGSAN_PAID_WAIT`(또는 needs_attention) + 주문 후 N시간 경과 시 발송지연 경고. 캐논에 이 상태 포함 검토(최소 needs_attention).

**D-3 🟠 반품/교환 — 송장 등록 후 반품되면 매입상태 정합 깨짐**
- [근거] page.tsx에 `RETURNS` 라벨 존재(shipping_status). 매입상태는 RECEIVED로 고정.
- [문제] 쿠팡 RETURNS인데 매입 RECEIVED → 실수익 계산(fetchSummary)은 RETURNS를 취소로 안 빼므로 **매출에 계속 잡혀 실수익 과대**. ggsan 반품/교환 status도 미반영.
- [권고] shipping_status='RETURNS' 또는 ggsan status='반품/교환' 감지 시 needs_attention + 실수익에서 제외 정책 결정. 최소한 알림.

**D-4 🟠 ggsan 품절로 발송불가 (결제 후 품절통보)**
- [근거] `edgecases-extras`(엣지9)만 다룸. stock-sync가 품절 시 listing `status='STOPPED'`(line 228)로 신규주문은 막지만, **이미 발주된 건**은 별개.
- [문제] 결제했는데 ggsan이 품절통보/환불 → 우리 DB는 ORDERED 고착, 송장 영원히 안 나옴.
- [권고] 추적 크론이 ggsan status가 N시간째 진행 없음 + goods 품절(stock-sync `checkStock` 재사용) → `needs_attention='발송불가 가능성'`.

---

## E. 소급(backfill) / 멱등성 — 기존 3건 재등록 시 돈 손실

**E-1 🔴 기존 RECEIVED 3건 재등록 = 6개월 중복송장 락 + 배송비**
- [근거] 기존 3건은 Wing 수동등록 완료, `invoice_number` 있음, 신규 `coupang_invoice_*` 컬럼은 기본값(false/none).
- [문제] 마이그레이션 후 신규 cron이 이 3건을 "미등록"으로 보고 **재등록 시도 → 쿠팡 6개월 중복 에러 + 미등록 간주 시 배송비 부담**.
- [권고] **DDL과 동시에** backfill UPDATE 실행 필수(facet 다수가 제안). `where purchase_status='RECEIVED' and invoice_number is not null → coupang_invoice_status='manual_done'`. 단 **DDL 따로/백필 따로 실행하면 그 사이 cron 1회가 돌아 사고**날 수 있으므로(로컬 cron 매시간), 캐논: **컬럼 추가 SQL의 default를 `manual_done`이 아니라 안전하게 두되, 백필 UPDATE를 같은 SQL 트랜잭션/같은 에디터 실행에 포함**하고 그 전까지 신규 cron 비활성(작업 등록 보류).

**E-2 🟠 cron 등록 타이밍 — DDL 전에 cron이 돌면 컬럼 없어 전부 에러**
- [근거] 로컬 Task Scheduler 매시간. DDL은 사용자 수동 실행.
- [문제] cron `.cmd` 먼저 등록 + DDL 늦게 → 쿼리가 없는 컬럼 참조해 실패 누적. 반대로 DDL만 하고 백필 누락(E-1).
- [권고] 구현 순서 hard rule: ①DDL+백필 UPDATE(같이) → ②dry-run 1건 검증 → ③`.cmd`+작업 등록. facet들의 "구현 순서" 섹션을 이 게이트로 통일.

---

## F. 동시성 / 데이터 정합 / 회귀

**F-1 🟠 orders-sync upsert가 cron이 쓴 ggsan/송장 컬럼을 덮을 위험 — facet 간 사실 충돌**
- [근거] **검증됨**: `local-cron-orders-sync.mjs:95-117` upsert row는 `shipping_status, receiver_*, raw_payload, last_synced_at`만 포함. `purchase_status`/`invoice_number`/`shipped_at`/신규 ggsan 컬럼 **모두 미포함** → upsert는 이들을 null로 덮지 않음(`edgecases-extras` 엣지14가 맞음). `backfill`/`coupang-invoice-auto`의 "충돌 없음" 주장도 맞음.
- [문제] 그러나 이는 **현재 row 객체에 우연히 없어서** 안전한 것. 향후 누가 orders-sync에 `invoice_number`/`shipped_at`(쿠팡 송장 미러)를 추가하면 **즉시 회귀**. `edgecases-extras`만 이 함정을 경고.
- [권고] orders-sync upsert에 **명시적 주석**: "ggsan_*/coupang_invoice_*/purchase_*/invoice_number/shipped_at 는 절대 추가 금지(별도 cron 소유)". 또는 upsert를 `ignoreDuplicates` 아닌 **명시 컬럼 화이트리스트**로 제한.

**F-2 🟠 두 cron 동시 실행 시 같은 행 경합**
- [근거] orders-sync(매시간)와 신규 supplier-sync(매시간, 30분 오프셋 제안). 그러나 작업 지연/재시도로 겹칠 수 있음.
- [문제] orders-sync가 raw_payload/shipping_status 갱신 + supplier-sync가 purchase_status/invoice 갱신을 같은 행에 동시 → last write wins, 일부 필드 유실 가능.
- [권고] 컬럼 소유권이 완전 분리(F-1)되면 실해는 적지만, 오프셋(30분) + supplier-sync 1회 처리량 캡 유지. 안전하게 `last_synced_at` 대신 컬럼별 갱신 시각 분리.

**F-3 🟡 다상품 묶음발주 시 라인별 vendorItemId 개별 invoices 호출**
- [근거] `edgecases-extras`/`coupang-invoice-auto`만 명시. invoices DTO는 라인(vendorItemId) 단위.
- [문제] 한 ggsan 주문=쿠팡 라인 N개일 때 각 라인 개별 등록 필요. vendor_item_id null인 과거행(line 93 package 0케이스) 등록 불가.
- [권고] order_item_id별 등록, vendor_item_id null이면 skip+needs_attention.

---

## G. 인프라 / 운영 / 누락 기능

**G-1 🟠 scripts/ git 미추적 = 신규 cron·매핑표 유실 위험**
- [근거] 브리프 명시 "scripts는 git 미추적 로컬 전용, 유실 위험". `coupang-invoice-auto`/`backfill`만 "반드시 커밋" 경고.
- [권고] 신규 `.mjs`/`.cmd`/매핑표를 git 추적으로 전환하거나 최소 백업 경로 확보. 매핑표(C-6)·캐논 상태값은 특히.

**G-2 🟡 ggsan order_view HTML 파싱 정규식 전부 미검증 (추측)**
- [근거] 모든 파싱 facet이 "실제 HTML 1건 덤프로 확정 필요"라고 자인. godomall 마크업 불안정.
- [권고] 구현 전 `_tmp_ggsan_order_view.html` 덤프로 셀렉터 확정. 송장/택배사 추출 실패 시 자동등록 말고 needs_attention(파싱실패).

**G-3 🟡 알림 채널 미정 — needs_attention이 UI 배너뿐이면 사장님이 화면 안 보면 무의미**
- [근거] `edgecases-extras`(엣지12)만 다룸, MVP는 UI 배너.
- [권고] 미발송/미결제/등록실패 같은 돈·배송 직결 건은 최소 1채널 push(Gmail 등) 검토. cron runs 테이블 error_count 급증 알림도.

**G-4 🟡 매입가 자동기록(ggsan 실결제액) — 좋은 추가 기능이나 1곳만 제안**
- [근거] `edgecases-extras`(엣지10). 현재 매입원가 수동(costMissing 경고 page.tsx:270). order_view에 실결제액 노출.
- [권고] 추적 크론이 order_view 실결제액 파싱→`purchase_total_cost` 비었을 때만 자동 채움(수동값 우선). 실수익 정확도 직결이라 채택 권고.

---

## H. 종합 권고 (구현 게이트)

1. **A-1 캐논 확정**(상태값·컬럼명 단일화)이 모든 것의 선행. 권고: `SHIPPED` 1개 추가 + `coupang_invoice_status` 단일 text + `ggsan_*` prefix + ggsan_order_no non-unique.
2. **돈 hard gate 3개**(업로드 직전): ①쿠팡 현재 status가 취소/반품이면 abort(D-1) ②수령인명 불일치면 abort(B-3) ③택배사 매핑 실패면 abort(C-6). 셋 다 needs_attention.
3. **순서 게이트**: DDL+백필 동시 실행(E-1/E-2) → dry-run 1건(C-1/C-5/G-2) → cron 등록. 그 전 자동등록 OFF(반자동, `coupang-invoice-auto`의 settings 토글 채택 권고).
4. **crash-safe**: ①SHIPPED 커밋 → ②③쿠팡 → 성공 시 RECEIVED(C-3). 재시도 쿼리는 `coupang_invoice_status` 기준.
5. **사각지대 가시화**: ggsan_order_no 없는 ORDERED(B-2), 미결제(D-2), 품절(D-4), 반품(D-3)을 needs_attention으로 강제 노출 + 가능하면 push(G-3).

가장 위험한 단일 항목: **B-3 오매칭 → C-4 중복=성공 은폐 → 잘못된 송장 영구 고착** 연쇄. 휴리스틱 자동확정 금지 + 수령인 hard gate가 이 연쇄의 차단점이다.

(검토 근거 파일 절대경로: `C:\Web\jimscanner-personal\src\app\api\admin\coupang-orders\update\route.ts`, `C:\Web\jimscanner-personal\scripts\local-cron-orders-sync.mjs`, `C:\Web\jimscanner-personal\src\app\api\cron\coupang-stock-sync\route.ts`, `C:\Web\jimscanner-personal\scripts\order-server.mjs`, `C:\Web\jimscanner-personal\src\app\admin\(dashboard)\coupang-orders\InvoiceCell.tsx`, `C:\Web\jimscanner-personal\src\app\admin\(dashboard)\coupang-orders\page.tsx`)