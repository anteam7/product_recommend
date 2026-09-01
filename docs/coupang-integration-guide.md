# 쿠팡(Coupang) 연동 가이드

> **대상 독자:** 이 레포를 처음 보는 AI/개발자. 쿠팡 Open API 연동을 새로 만들거나,
> 기존 등록·재고·주문 파이프라인을 수정·확장할 때 참고한다.
> 방향 문서는 `platform_direction.md` 4장이 요지, 이 문서는 **구현 상세 + 함정** 중심.

---

## 1. 이 레포에서 쿠팡이 하는 일

```
① 발굴/소싱(ggsan·도매꾹·유픽) → ② 쿠팡 상품 등록(Open API) → ③ 승인요청
                                                                    ↓
④ 주문 수집(ordersheets) ← ⑤ 재고 동기화(품절→판매중지) ← 판매중(SELLING)
   ↓
⑥ 매입처 발주 매칭(ggsan/유픽) → ⑦ 발주확인+송장등록(Open API)
```

- 코드/스크립트 기반 운영. Wing(쿠팡 셀러센터) 수작업은 최소화하되, **카테고리 API 제약**(§6) 때문에
  일부는 여전히 Wing 수동 처리를 전제로 설계돼 있다.
- 현재 쿠팡 단일 마켓. 멀티마켓 확장 시 분리 지점은 `platform_direction.md` §5 참조.

---

## 2. 인증

- 방식: HMAC-SHA256, 커스텀 `CEA` 스킴 (OAuth 아님)
- 환경변수 (`.env.local`, 커밋 금지):
  ```
  COUPANG_ACCESS_KEY
  COUPANG_SECRET_KEY
  COUPANG_VENDOR_ID          # A00xxxxxx 형태
  COUPANG_API_HOST           # https://api-gateway.coupang.com
  ```
- **정본 구현**: `src/lib/coupang/price.ts` (`sign()`, `coupangApi()`) — Next.js 라우트/크론에서 이걸 import.
  `scripts/*.mjs`는 TS를 import 못 하므로 **각 스크립트가 동일 로직을 복붙**해서 갖고 있다 (아래 참고 구현).

```js
// 서명 생성 — 모든 coupang-*.mjs 스크립트에서 반복되는 패턴
function sign(method, urlPath, query = '') {
  const datetime = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  const message = datetime + method + urlPath + (query || '')
  const signature = crypto.createHmac('sha256', SECRET_KEY).update(message).digest('hex')
  return { datetime, signature }
}

async function api(method, urlPath, body = null, query = '') {
  const { datetime, signature } = sign(method, urlPath, query)
  const authorization = `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`
  const res = await fetch(`${HOST}${urlPath}${query ? '?' + query : ''}`, {
    method,
    headers: { Authorization: authorization, 'Content-Type': 'application/json;charset=UTF-8' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: (() => { try { return JSON.parse(text) } catch { return text } })() }
}
```

⚠️ **쿼리스트링이 있으면 서명 메시지에도 반드시 포함**해야 한다 (`datetime + method + urlPath + query`). 빠뜨리면 서명 불일치로 401.

⚠️ **IP 허용목록**: Open API는 Wing에 등록된 공인 IP에서만 호출 가능. 재택/카페 등에서 공인 IP가 바뀌면
갑자기 403(`OpenApiException`)이 뜬다. 증상: 주문/재고 수집이 조용히 0건으로 멈춤(에러 없이 정지처럼 보임).
→ Wing > 오픈API 관리에서 허용 IP 갱신. `scripts/_coupang-ip-diag.mjs`로 진단.

---

## 3. Open API 엔드포인트 레퍼런스

Base host: `COUPANG_API_HOST` (기본 `https://api-gateway.coupang.com`)

| 기능 | Method | Path | 비고 / 사용처 |
|---|---|---|---|
| 카테고리 자동예측 | POST | `/v2/providers/openapi/apis/api/v1/categorization/predict` | body `{ productName }`. `scripts/coupang-category-batch.mjs` |
| 카테고리 메타(필수속성·고시·옵션) | GET | `/v2/providers/seller_api/apis/api/v1/marketplace/meta/category-related-metas/display-category-codes/{code}` | 등록 전 필수 조회. 대부분의 `coupang-*.mjs`가 캐시(`metaDir/{code}_raw.json`) 후 재사용 |
| 상품 등록 | POST | `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products` | `scripts/coupang-register-batch-v2.mjs` (§5) |
| 상품 상세 조회 | GET | `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/{sellerProductId}` | vendorItemId 목록 획득 (`getVendorItemIds`) |
| 승인요청 | PUT | `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/{sellerProductId}/approvals` | TEMPORARY_SAVE → PENDING_APPROVAL. `scripts/coupang-request-approval-2.mjs` |
| 판매가 변경 | PUT | `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/{vendorItemId}/prices/{price}?forceSalePriceAddUp=true` | `forceSalePriceAddUp`는 정가<판매가 될 때 정가 자동 인상 |
| 재고 수량 변경 | PUT | `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/{vendorItemId}/quantities/{qty}` | 재승인 불필요, 즉시 반영 |
| 재고 조회 | GET | `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/{vendorItemId}/inventories` | |
| 판매 중지 | PUT | `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/{vendorItemId}/sales/stop` | 품절 시 |
| 판매 재개 | PUT | `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/{vendorItemId}/sales/resume` | 재입고 시 |
| 반품지 목록 | GET | `/v2/providers/openapi/apis/api/v4/vendors/{vendorId}/returnShippingCenters` | 등록 payload의 `returnCenterCode` 확보용 |
| 주문 목록 조회 | GET | `/v2/providers/openapi/apis/api/v4/vendors/{vendorId}/ordersheets` | 쿼리로 기간·상태 필터. `scripts/lib/coupang-orders-sync.mjs` |
| 주문 상세 조회 | GET | `/v2/providers/openapi/apis/api/v4/vendors/{vendorId}/ordersheets/{shipmentBoxId}` | |
| 발주확인(ack) | PUT | `/v2/providers/openapi/apis/api/v4/vendors/{vendorId}/ordersheets/acknowledgement` | body `{ vendorId, shipmentBoxIds: [...] }`. 송장등록 전 선행 필수 |
| 송장(운송장) 등록 | POST | `/v2/providers/openapi/apis/api/v4/vendors/{vendorId}/orders/invoices` | `scripts/lib/coupang-invoice.mjs` |

전체 등록 페이로드 예시·필수속성 파싱 로직은 `scripts/coupang-register-batch-v2.mjs`가 가장 완성도 높은 참고 구현이다.

---

## 4. 등록 상태 머신

```
DRAFT → TEMPORARY_SAVE → PENDING_APPROVAL → APPROVED → SELLING ⇄ STOPPED
                                          ↘ REJECTED
                                          ↘ FAILED / SKIPPED
```

- DRAFT→TEMPORARY_SAVE: `POST seller-products` 성공
- TEMPORARY_SAVE→PENDING_APPROVAL: `PUT .../approvals` (승인요청, **사용자 승인 게이트 필수** — `.claude/skills/coupang-register-pipeline/SKILL.md`)
- PENDING_APPROVAL→APPROVED→SELLING: 쿠팡 심사(자동, 수 분~수 시간)
- SELLING⇄STOPPED: 재고 0 → STOPPED(자동/수동), 재입고 → resume

상태·가격·노출·거절사유는 `jimscanner_coupang_listings`에 기록 (§7).

⚠️ **판매중(SELLING) 상품을 전체 PUT으로 수정하면 임시저장(TEMPORARY_SAVE)으로 강등**되고 오프라인 처리된다 → 재승인요청 필요.
가격만 바꿀 땐 반드시 vendor-item 가격 API(`PUT .../prices/{price}`)를 쓸 것, 상품 PUT을 쓰지 말 것.

---

## 5. 상품 등록 흐름 상세 (`coupang-register-batch-v2.mjs` 기준)

1. **카테고리 예측** (`categorization/predict`) → `raw_payload.coupang_predicted_category`에 저장
2. **카테고리 안정성 검증**: 예측된 코드가 `STABLE_CATEGORY_CODES = {73137(기타건강식품), 58927}`에 없으면
   **73137로 강제 폴백**. 그 외 카테고리는 등록 자체가 거절되는 패턴이 실측 확인됨. 등록 후 필요하면
   Wing 또는 수정 API로 정확한 카테고리로 이동.
3. **카테고리 메타 조회** (`meta/category-related-metas/...`) → 필수속성(`attributes`)·고시정보(`notices`) 스키마 획득, 로컬 캐시
4. **가격 계산** (MSP 절대 하한, §6)
5. **이미지 구성**:
   - `images`: `REPRESENTATION`(대표, 1장) + `DETAIL`(최대 4장)
   - `contents`(상세설명): **에디터 긴 이미지**(`images_content`) 우선, 없으면 `images_detail` 폴백.
     짧은 제품사진만 넣으면 상세설명 부실 → 반려/전환율 저하. `coupang-fix-detail-contents.mjs`가 백필 스크립트.
6. **payload 조립** 후 `POST seller-products` → 응답의 `sellerProductId` 등을 `jimscanner_coupang_listings`에 UPSERT
7. (별도 실행, 사용자 승인 후) `PUT .../approvals`

### payload 필수 필드 체크리스트
- `vendorId`, `sellerProductName`, `displayCategoryCode`, `brand`, `saleStartedAt/saleEndedAt`
- 배송: `deliveryMethod`, `deliveryCompanyCode`, `deliveryChargeType`, `returnCenterCode`, `returnZipCode`, `returnAddress` 등 — 판매자 고정값 (반품지 등록은 Wing에서 먼저 해야 `returnCenterCode` 발급됨)
- `items[]`: `itemName`(카테고리 메타 호환 단위만 사용, 예: "60정 1박스"), `originalPrice ≥ salePrice`(역전 시 노출 제한), `externalVendorSku`(소싱처 상품번호 매핑용), `images`, `notices`, `attributes`, `contents`

### 이미지 스펙
- 최소 500×500, 최대 5000×5000, 10MB 이하
- 미달 이미지는 `sharp`로 패딩 → Supabase `site-assets` 버킷 업로드 → 이미지 URL 교체 (`coupang-fix-images.mjs` 패턴)

---

## 6. 가격/마진 (MSP 절대 하한)

- **정본 계산 모듈**: `src/lib/coupang/price.ts` — `computeMargin()`, `SHIP=3000`, `FEE_RATE=0.106`, `VAT_DIVISOR=11`
- `.mjs` 스크립트는 이 TS 모듈을 import할 수 없어 **동일 상수를 각자 복붙**하고 있음.
  **FEE_RATE·SHIP 값을 바꾸면 `coupang-register-*.mjs`, `coupang-reprice-ship3000.mjs`, `coupang-pricewatch.mjs` 등도 같이 수정할 것.**

```
실원가(realCost) = 도매가(dome) + 출고배송비(SHIP=3000)   // 위탁(dropship)은 배송 1회분만
등록가(listPrice) = max(MSP, 경쟁가(시세중앙값×0.95), realCost/0.65)  # 35% 마진 하한
listPrice = ceil(listPrice / 100) * 100   # 100원 단위 올림
수수료(fee) = round(listPrice × FEE_RATE)
부가세(vat) = round(listPrice / 11)
마진 = listPrice - realCost - fee - vat
```

🛑 **모든 가격 조정은 공급자 최저가(MSP, `msp_price_krw`/`min_sell_price_krw`) 아래로 절대 내려가면 안 된다.**
`msp=0`은 데이터 결함(백필 필요)이지 "제한 없음"이 아니다 — 하한 검증 전에 반드시 `msp > 0` 확인.
번들(묶음) 상품은 **수량별 절대준수가**(tiered MSP)가 있어 `raw_payload.tiered_msp`에 기록하고 `register-bundle`류 스크립트가 이를 검증한다.

---

## 7. 데이터 모델 (Supabase, 본업과 공유 프로젝트)

Project ref `obxvucyhzlakensopalf` — 연결은 **Pooler(6543)만 가능**(직접 5432는 IPv6 전용이라 불가). 상세: `docs/database.md`.

### `jimscanner_coupang_listings` — 등록 상품
| 컬럼 | 타입 | 비고 |
|---|---|---|
| id | uuid PK | |
| seller_product_id, product_id | bigint | 쿠팡 발급 ID |
| vendor_id | text | |
| source, source_goods_no, source_detail_url | text | 소싱처(ggsan/domeggook/upick) 및 원본 상품 링크 |
| registered_title | text | |
| display_category_code, display_category_name | | §5의 폴백 로직 결과가 여기 반영됨 |
| brand | text | |
| dome_price_krw, source_shipping_fee_krw, outbound_shipping_fee_krw, msp_price_krw, list_price_krw | integer | §6 가격 산식의 각 항 |
| estimated_fee_krw, estimated_margin_krw, estimated_margin_pct | | |
| status | text | §4 상태 머신 값 |
| displayable | boolean | |
| approval_status_name, rejection_reason | text | 쿠팡 심사 결과 |
| sold_count, view_count | integer | |
| request_payload, last_response | jsonb | 등록 시 보낸 payload / 쿠팡 응답 원문 (디버깅용) |
| registered_at, approved_at, last_synced_at | timestamptz | |
| stock_status, last_stock_check, stock_sold_out_at, coupang_sale_stopped_at, auto_paused | | 재고 동기화 크론이 갱신 |

### `jimscanner_coupang_orders` — 주문
| 컬럼 | 비고 |
|---|---|
| order_id, order_item_id, shipment_box_id, vendor_item_id | 쿠팡 주문 식별자 |
| listing_id | `jimscanner_coupang_listings.id` FK 성격 |
| product_name, option_name, shipping_count, sale_price, order_price, discount_amount, delivery_charge | 주문 내역 |
| purchase_status, purchase_ordered_at, purchase_received_at, purchase_unit_cost, purchase_total_cost, purchase_note | **매입처(ggsan 등) 발주 매칭 결과** |
| shipping_status, invoice_number, delivery_company, shipped_at, delivered_at | 배송 |
| receiver_name/phone/address/zip_code | 수령인 정보 |
| ggsan_order_no, ggsan_match_method, ggsan_order_status, ggsan_actual_paid, ggsan_invoice_number, ggsan_carrier_name, ggsan_shipped_at, ggsan_last_checked_at | ggsan↔쿠팡 송장 자동 동기화 파이프라인 전용 (`docs/plan-ggsan-coupang-invoice-sync.md`) |
| coupang_invoice_status, coupang_acknowledged_at, coupang_invoice_uploaded_at, coupang_invoice_company_code, coupang_invoice_attempts, coupang_invoice_error | §3의 ack/invoices 호출 상태 |
| needs_attention, attention_reason | 수동 개입 필요 플래그 |
| supplier_source, supplier_goods_no | 주문별 매입처 오버라이드(기본 매칭과 다른 소싱처로 강제 지정) |
| raw_payload | jsonb, ordersheets 응답 원문 |

### `jimscanner_coupang_stock_sync_runs` — 재고 동기화 크론 로그
`started_at/finished_at/total_checked/sold_out_count/resumed_count/error_count/duration_ms/status/error_message/triggered_by`

---

## 8. 자동화 / 크론

| 작업 | 주기 | 실행 방식 | 역할 |
|---|---|---|---|
| 재고 동기화 | 매시간 | 로컬 Windows 작업(`scripts/local-cron-stock-sync.mjs`) | ggsan 품절 감지 → vendor-item `sales/stop`, 재입고 → `sales/resume` + 수량 5로 리셋 |
| 주문 수집 | 매시간 | 로컬 Windows 작업(`scripts/local-cron-orders-sync.mjs`, 공용 모듈 `scripts/lib/coupang-orders-sync.mjs`) | `ordersheets` 최근 24h 조회 → `jimscanner_coupang_orders` UPSERT |
| 발주확인·송장등록 | 로컬 폴러 | `scripts/lib/coupang-invoice.mjs` (order-server, purchase_jobs 큐 경유) | ack → 매입처 송장 감지 시 `orders/invoices` 자동 등록 |

⚠️ Vercel Hobby 플랜 cron 한도 때문에 **위 크론들은 Vercel에서 실행되지 않고 로컬 PC 상시 실행**으로 우회 중
(`scripts/run-crons.mjs`가 트렌드 수집 등 다른 크론까지 총괄). PC가 꺼져있던 시간대의 주문/재고는 놓칠 수 있음 —
`--backfill` 류 옵션으로 수동 복구.

관련 API 라우트(Next.js): `src/app/api/cron/coupang-stock-sync`, `src/app/api/cron/coupang-orders-sync`,
`src/app/api/admin/coupang-orders/register-invoice`, `src/app/api/admin/coupang-publish/update` 등.

---

## 9. 알려진 함정 (반드시 읽을 것)

0. 🛑 **[2026-09-01] 쿠팡 "필수 구매옵션 입력 의무화" 정책(2026-02-02 시행)으로 기존 등록 파이프라인 전체가 막혀있을 가능성**.
   `coupang-register-batch-v2.mjs`(ggsan)의 마지막 실제 APPROVED 성공 기록이 **2026-07-02**이고 그 이후 성공 사례가 없음.
   재확인 결과 ggsan이 안정 폴백으로 쓰던 73137/58927 카테고리조차 현재 메타에서 `isAllowSingleItem: false`
   (단일 SKU 등록 불가, 실제 옵션/변형 구성 필요)로 바뀌어 있음 — 즉 "수량만 EXPOSED, 나머지는 NONE + 더미값"이라는
   기존 방식이 더 이상 통하지 않는 카테고리가 늘어난 것으로 보임.
   - 메타 응답 최상위 `isAllowSingleItem` 필드로 카테고리별 확인 가능 (`getCategoryMeta(code).isAllowSingleItem`).
   - `true`인 카테고리도 "필수 구매 옵션 (미입력시 등록/노출 제한) 존재하지 않습니다" / "유효하지 않은 구매 옵션 값 혹은
     단위가 존재합니다" 오류가 재현됨(2026-09-01, `scripts/bio77-register.mjs` 개발 중 21건 전량 실패) — 정확한 통과
     조건(예: 수량+개당단위 그룹 중 하나를 동시에 EXPOSED로 보내되 값/단위 포맷이 무엇이어야 하는지)은 **아직 미해결**.
   - 참고 공지: [필수 구매옵션 입력 의무화 및 API 변경 안내(쿠팡 개발자센터)](https://developers.coupangcorp.com/hc/ko/articles/54700630775577)
   - 새로 이 파이프라인을 만지는 AI는 등록 전에 반드시 대상 카테고리로 **1건 dry-run 없는 실제 POST 테스트**부터 해서
     현재도 막혀있는지 재확인할 것. 뚫렸다면 이 항목은 지우고 정확한 통과 조건으로 교체.

1. **판매중 상품 전체 PUT 수정 → 임시저장 강등**. 가격만 바꿀 땐 vendor-item 가격 API만 사용 (§4).
2. **IP 허용목록**: 공인 IP 변경 시 조용히 403 → 수집이 "0건"으로 멈춘 것처럼 보임. 증상 발견 즉시 Wing IP 갱신 확인 (§2).
3. **카테고리 불안정**: 73137/58927 외 카테고리는 등록 거절 위험. 폴백 후 사후 정정 전제로 설계됨 (§5).
4. **MSP=0은 데이터 결함**이지 하한 없음이 아니다. 등록/리프라이스 전 반드시 백필·검증 (§6).
5. **상세설명(에디터 이미지) 누락 버그**: prep 단계가 `images_content`를 못 찾으면 짧은 제품사진만 상세로 들어감. 등록 전 `images_content` 존재 여부 확인.
6. **originalPrice < salePrice(정가-판매가 역전)** 는 노출 제한 사유. 등록 시 `originalPrice = max(list_price_krw, listPrice*1.2)`로 강제 보정.
7. **가격 상수 이중관리**: `src/lib/coupang/price.ts`(TS, 앱/크론용)와 각 `.mjs`(스크립트용)에 `FEE_RATE`/`SHIP`가 각각 하드코딩. 하나 고치면 나머지도 확인.
8. **번들 상품 tiered MSP**: 수량별 절대준수가를 무시하고 균일가로 등록하면 위반. `raw_payload.tiered_msp` 확인.

---

## 10. 파일 레퍼런스 맵

| 목적 | 파일 |
|---|---|
| 인증/가격 정본(TS) | `src/lib/coupang/price.ts` |
| ggsan→쿠팡 배치 등록(가장 완성도 높은 참고 구현) | `scripts/coupang-register-batch-v2.mjs` |
| 승인요청 | `scripts/coupang-request-approval-2.mjs` |
| 도매꾹→쿠팡 단건 등록 | `scripts/domeggook-register-one.mjs` |
| 유픽→쿠팡 등록 | `scripts/upickb2b-register.mjs` |
| 카테고리 예측 배치 | `scripts/coupang-category-batch.mjs` |
| 카테고리 메타/필수속성 진단 | `scripts/coupang-diagnose-mandatory.mjs`, `coupang-category-meta.mjs` |
| 재고 동기화(품절↔재개) | `scripts/local-cron-stock-sync.mjs`, `scripts/coupang-restock-soldout.mjs` |
| 리프라이스(가격 일괄 변경) | `scripts/coupang-reprice-ship3000.mjs`, `scripts/coupang-pricewatch.mjs` |
| 주문 수집 공용 모듈 | `scripts/lib/coupang-orders-sync.mjs` |
| 발주확인+송장등록 공용 모듈 | `scripts/lib/coupang-invoice.mjs` |
| 상세설명(에디터 이미지) 백필 | `scripts/coupang-fix-detail-contents.mjs` |
| 이미지 스펙 보정 | `scripts/coupang-fix-images.mjs` |
| API 연결 진단 | `scripts/coupang-api-test.mjs`, `scripts/_coupang-ip-diag.mjs` |
| 상품↔주문 매칭 상태 진단 | `scripts/coupang-diagnose-status.mjs`, `coupang-ggsan-diff-diagnose.mjs` |
| 상품명 광고성/소구력 감사 | `scripts/coupang-name-audit.mjs` |
| Next.js API 라우트 | `src/app/api/cron/coupang-*`, `src/app/api/admin/coupang-orders/*`, `src/app/api/admin/coupang-publish/*` |
| 운영 스킬(다음 작업 진입점) | `.claude/skills/coupang-register-pipeline/SKILL.md` |

---

## 11. 새로 작업을 시작할 때

1. 이 문서 §1~§4로 상태 머신·엔드포인트 파악
2. 등록 작업이면 `.claude/skills/coupang-register-pipeline/SKILL.md` 순서(prep→dry-run→임시저장→**사용자 승인**→승인요청) 그대로 따를 것
3. 가격을 만지는 작업이면 §6의 MSP 하한 규칙을 절대 어기지 말 것
4. 새 엔드포인트를 쓰게 되면 이 표(§3)에 추가하고, 상수를 바꾸면 §9-7의 이중관리 목록도 갱신
5. 코드 수정 후 `npm run build`, 그리고 **커밋 전 사용자 확인** (implementer cron이 도는 레포 — `CLAUDE.md` 참조)
