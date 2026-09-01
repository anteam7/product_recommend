# 쿠팡(Coupang) Open API 연동 — 처음 하는 사람을 위한 원샷 가이드

> 이 문서 하나로 "상품 등록 → 주문 수집 → 배송(송장) 연동"까지 구현할 수 있도록 작성했다.
> **이 문서를 받은 AI는 아래 0장의 질문을 먼저 사용자에게 물어보고, 답을 받은 뒤 1장부터 구현을 시작한다.**
> 특정 레포/DB에 종속되지 않은 범용 가이드다 (Node.js 기준 코드, 필요시 다른 언어로 이식).

---

## 0. 시작 전에 반드시 물어봐야 할 것들 (체크리스트)

아래 항목이 하나라도 없으면 그 항목이 필요한 단계에서 반드시 멈추고 사용자에게 물어볼 것. 추측으로 채우지 말 것.

### 0-1. 자격 요건
- [ ] 쿠팡 **Wing(셀러센터)** 계정이 있는가? (사업자 판매자만 Open API 사용 가능. 개인/체험판은 불가할 수 있음)
- [ ] Wing에서 **오픈API 관리** 메뉴로 API 키를 발급받았는가?
  - 없다면: Wing 로그인 → 우측 상단 계정 메뉴 → "오픈API 관리" → 키 발급 절차를 사용자에게 안내
- [ ] 다음 4개 값을 확보했는가?
  - `ACCESS_KEY`
  - `SECRET_KEY`
  - `VENDOR_ID` (예: `A00123456` 형태, 업체코드)
  - API 호출을 실행할 서버의 **공인 IP** (Wing 오픈API 관리 페이지에 IP를 등록해야 호출 가능. 등록 안 하면 403)

### 0-2. 배송/반품 설정 (Wing에서 미리 등록되어 있어야 코드가 발급됨)
- [ ] **출고지**가 Wing에 등록되어 있는가? → `outboundShippingPlaceCode` 확보 (Wing: 판매자정보 > 출고지/반품지 관리)
- [ ] **반품지**가 Wing에 등록되어 있는가? → `returnCenterCode` 확보
- [ ] 반품 배송비, 반품지 우편번호/주소, 고객센터 연락처 확보
- [ ] 실제로 계약된 **택배사**가 어디인가? → `deliveryCompanyCode` (검증된 값: CJ대한통운 = `CJGLS`. 다른 택배사는 Wing 화면 또는 쿠팡 Open API 공식 문서의 택배사 코드표에서 확인 필요 — 추측 금지)

### 0-3. 판매 상품 정보
- [ ] 판매할 상품의 **카테고리**가 무엇인가? (식품/건강기능식품/의류/전자 등 — 카테고리마다 필수 입력 속성이 완전히 다름)
- [ ] 상품명, 가격, 이미지, 배송비 정책(무료/유료), 옵션 유무
- [ ] 원가/매입가 대비 목표 마진율 (가격 하한선을 어떻게 잡을지)

### 0-4. 운영 환경
- [ ] 이 코드를 실행할 서버가 **상시 실행**되는가, 아니면 크론/배치로 주기 실행되는가?
- [ ] 등록/주문 데이터를 저장할 **DB**가 있는가, 없다면 무엇을 새로 만들 것인가?
- [ ] Node.js 환경인가? (아래 코드는 Node 18+ 기준, `fetch` 내장 전제. 다른 스택이면 HMAC 서명 로직만 이식하면 됨)

---

## 1. 인증 구현 (모든 API 호출의 기반)

방식: **HMAC-SHA256**, 커스텀 `CEA` 스킴. OAuth가 아니다.

```js
// coupang-client.js
import crypto from 'node:crypto'

const HOST = process.env.COUPANG_API_HOST || 'https://api-gateway.coupang.com'
const ACCESS_KEY = process.env.COUPANG_ACCESS_KEY
const SECRET_KEY = process.env.COUPANG_SECRET_KEY
export const VENDOR_ID = process.env.COUPANG_VENDOR_ID

function sign(method, urlPath, query = '') {
  // 쿠팡 규정 시각 포맷: YYMMDDTHHMMSSZ (UTC)
  const datetime = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  const message = datetime + method + urlPath + (query || '')
  const signature = crypto.createHmac('sha256', SECRET_KEY).update(message).digest('hex')
  return { datetime, signature }
}

export async function coupangApi(method, urlPath, body = null, query = '') {
  const { datetime, signature } = sign(method, urlPath, query)
  const authorization = `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`
  const url = `${HOST}${urlPath}${query ? '?' + query : ''}`
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json;charset=UTF-8',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, ok: res.ok, body: parsed }
}
```

**주의사항**
- 쿼리스트링이 붙는 요청은 서명 메시지에도 반드시 그 쿼리를 포함해야 한다 (`sign(method, urlPath, query)`). 빠뜨리면 401.
- `datetime`은 매 요청 새로 생성 (재사용 금지, 시간 오차 크면 서명 거부됨 — 서버 시간 동기화 확인).
- 401/403이 뜨면 순서대로 의심: ① 키 오타 ② 서명 메시지 조합 오류(쿼리 누락) ③ **공인 IP 미등록**(가장 흔함).

---

## 2. 전체 흐름 개관

```
[상품 등록]
카테고리 예측 → 카테고리 메타(필수속성) 조회 → 등록 payload 조립 → 등록(임시저장) → 승인요청 → (쿠팡 심사) → 승인/거절

[주문·배송 연동]
주문 목록 조회(주기적) → 발주확인 → (매입/포장/발송 처리) → 송장번호 등록 → 배송 상태는 쿠팡이 자동 추적
```

상태 흐름:
```
DRAFT → TEMPORARY_SAVE(임시저장) → PENDING_APPROVAL(승인요청) → APPROVED → SELLING ⇄ STOPPED
                                                              ↘ REJECTED
```

---

## 3. 상품 등록

### 3-1. 카테고리 예측
```js
const r = await coupangApi('POST', '/v2/providers/openapi/apis/api/v1/categorization/predict', {
  productName: '상품명 예시 (구체적일수록 정확)',
})
// r.body.data.predictedCategoryId, predictedCategoryName
```
⚠️ 예측이 애매한 카테고리(정확도 낮음)로 나오면 등록 시 거절되는 경우가 실무에서 확인됨. 예측 결과를 그대로 믿지 말고, 카테고리 메타 조회(3-2)가 성공하는지로 한 번 더 검증한다.

### 3-2. 카테고리 메타 조회 (필수속성/고시정보/옵션 스키마)
```js
const meta = await coupangApi('GET',
  `/v2/providers/seller_api/apis/api/v1/marketplace/meta/category-related-metas/display-category-codes/${categoryCode}`)
// meta.body.data.attributes   → 이 카테고리에서 요구하는 상품 속성 목록(정/포/캡슐 등 단위, 필수여부)
// meta.body.data.noticeCategories → 전자상거래법 고시정보 항목(카테고리별로 다름: 식품이면 유통기한/원산지 등)
```
**이 응답이 곧 "이 카테고리에 무엇을 채워야 하는지"의 정답지다.** 상품 등록 실패의 8할은 이 메타를 안 보고 짐작으로 payload를 채워서 생긴다.

### 3-3. 등록 payload 조립 + 등록
```js
const payload = {
  vendorId: VENDOR_ID,
  sellerProductName: '상품명',
  displayCategoryCode: categoryCode,
  displayProductName: '상품명',
  brand: '브랜드명',
  generalProductName: '상품명',
  productGroup: '상품명 앞 2~3단어',
  manufacture: '제조사 또는 상세설명 참조',
  saleStartedAt: new Date().toISOString().slice(0, 19),
  saleEndedAt: '2099-12-31T00:00:00',
  deliveryMethod: 'SEQUENCIAL',
  deliveryCompanyCode: 'CJGLS',       // 0-2에서 확보한 값
  deliveryChargeType: 'FREE',          // FREE | NOT_FREE 등
  deliveryCharge: 0,
  freeShipOverAmount: 0,
  deliveryChargeOnReturn: 3000,
  remoteAreaDeliverable: 'N',
  unionDeliveryType: 'NOT_UNION_DELIVERY',
  returnCenterCode: '...',             // 0-2에서 확보
  returnChargeName: '반품지명',
  companyContactNumber: '고객센터 번호',
  returnZipCode: '...',
  returnAddress: '...',
  returnAddressDetail: '...',
  returnCharge: 5000,
  outboundShippingPlaceCode: 0,        // 0-2에서 확보
  requested: false,                    // true면 등록과 동시에 승인요청까지 진행됨(비추천 — 임시저장 후 검수하고 별도 승인요청 권장)
  items: [{
    itemName: '옵션명(카테고리 메타의 usableUnits와 호환되는 단위 사용)',
    originalPrice: 30000,              // salePrice보다 반드시 커야 함 (역전 시 노출 제한)
    salePrice: 25000,
    maximumBuyCount: 0,
    maximumBuyForPerson: 0,
    maximumBuyForPersonPeriod: 1,
    outboundShippingTimeDay: 2,
    unitCount: 1,
    adultOnly: 'EVERYONE',
    taxType: 'TAX',
    parallelImported: 'NOT_PARALLEL_IMPORTED',
    overseasPurchased: 'NOT_OVERSEAS_PURCHASED',
    pccNeeded: false,
    externalVendorSku: '내부 관리용 SKU',
    images: [
      { imageOrder: 0, imageType: 'REPRESENTATION', vendorPath: '대표이미지 URL' },
      { imageOrder: 1, imageType: 'DETAIL', vendorPath: '상세이미지1 URL' },
    ],
    notices: [ /* 3-2에서 받은 noticeCategories 스키마에 맞춰 값 채움 */ ],
    attributes: [ /* 3-2에서 받은 attributes 스키마에 맞춰 값 채움 */ ],
    contents: [
      { contentsType: 'IMAGE_NO_SPACE', contentDetails: [{ content: '상세설명 긴 이미지 URL', detailType: 'IMAGE' }] },
    ],
    offerCondition: 'NEW',
  }],
  notices: [],
  requiredDocuments: [],
}

const res = await coupangApi('POST', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', payload)
// 성공 시 res.body.data 에 sellerProductId 포함 → 상태는 TEMPORARY_SAVE
```

**이미지 스펙**: 최소 500×500, 최대 5000×5000px, 파일당 10MB 이하. 미달하면 등록 자체가 거절된다.

### 3-4. 승인요청 (검수 → 판매 시작)
```js
const approval = await coupangApi('PUT',
  `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}/approvals`)
// 성공 시 상태 TEMPORARY_SAVE → PENDING_APPROVAL. 이후 쿠팡 자동 심사(수 분~수 시간) → APPROVED → SELLING
```
🛑 **사람이 확인하기 전에 자동으로 승인요청까지 넘기지 말 것.** 임시저장 상태에서 등록 내용을 한 번 검토한 뒤 승인요청하는 게 안전하다 (오탈자·가격오류가 그대로 판매 시작되는 사고 방지).

### 3-5. 판매 중 상품 수정 시 주의
- **판매중(SELLING) 상품을 다시 전체 등록 API(POST/PUT seller-products)로 고치면 임시저장으로 강등**되어 판매가 내려간다(재승인 필요).
- 가격만 바꾸고 싶으면 4장의 가격 변경 API만 쓸 것. 상품 전체 정보를 고치는 경우에만 등록 API를 다시 쓴다.

---

## 4. 가격/재고 제어

```js
// 판매가 변경 (정가보다 높아지면 정가 자동 인상하려면 forceSalePriceAddUp=true)
await coupangApi('PUT',
  `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vendorItemId}/prices/${newPrice}`,
  null, 'forceSalePriceAddUp=true')

// 재고 수량 변경 (재승인 불필요, 즉시 반영)
await coupangApi('PUT',
  `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vendorItemId}/quantities/${qty}`)

// 재고 조회
await coupangApi('GET',
  `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vendorItemId}/inventories`)

// 품절 시 판매중지 / 재입고 시 재개
await coupangApi('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vendorItemId}/sales/stop`)
await coupangApi('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vendorItemId}/sales/resume`)
```

`vendorItemId`는 등록 시 응답에 없다면, 상품 상세 조회로 얻는다:
```js
const detail = await coupangApi('GET',
  `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}`)
const vendorItemIds = detail.body.data.items.map(i => i.vendorItemId)
```

**가격 정책 원칙**: 판매가를 원가(매입가+배송비) 이하로, 또는 공급자가 정한 최저판매가(있다면) 아래로 절대 내리지 말 것. 등록가 산식 예시:
```
실원가 = 매입가 + 출고배송비
등록가 = max(최저판매가 있으면 그 값, 실원가 / (1 - 목표마진율 - 예상수수료율))
```
쿠팡 판매수수료는 카테고리별로 다르다 (예: 건강기능식품 계열 약 10.6% 실측 확인). 정확한 수수료율은 Wing 정산 메뉴 또는 카테고리 수수료 안내에서 확인.

---

## 5. 주문 수집

```js
const from = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
const to = new Date().toISOString()
const query = `createdAtFrom=${from.slice(0,10)}&createdAtTo=${to.slice(0,10)}&status=ACCEPT`
const orders = await coupangApi('GET',
  `/v2/providers/openapi/apis/api/v4/vendors/${VENDOR_ID}/ordersheets`, null, query)
// orders.body.data: 주문 목록 (shipmentBoxId, orderId, orderItems[], receiver 정보 등)
```
- 상태값(`status`) 예: `ACCEPT`(결제완료, 발주확인 대기) / `INSTRUCT`(발송지시) / `DEPARTURE`(출고) / `DELIVERING` / `FINAL_DELIVERY` 등. 정확한 전체 목록은 Open API 공식 문서 확인.
- **주기 실행 시 조회 구간을 겹치게(예: 최근 2~24시간) 잡아라.** 서버가 잠깐 꺼진 사이 주문이 영구 누락되는 사고를 막기 위함. 매번 "직전 조회 이후"만 딱 맞춰 조회하면 그 틈에 발생한 주문을 놓친다.

---

## 6. 배송(송장) 연동 — 발주확인 → 송장등록

이 순서를 반드시 지킬 것: **발주확인(acknowledgement) 없이 송장을 등록하면 실패한다.**

```js
// 1) 발주확인 — 결제완료 주문을 "확인함" 상태로 전환
await coupangApi('PUT',
  `/v2/providers/openapi/apis/api/v4/vendors/${VENDOR_ID}/ordersheets/acknowledgement`,
  { vendorId: VENDOR_ID, shipmentBoxIds: [shipmentBoxId] })

// 2) (실제 상품 포장/매입처 발송 처리는 별도 — 이 문서 범위 밖)

// 3) 송장(운송장)번호 등록 — 이게 완료되면 쿠팡 앱/사이트에 "배송 시작"으로 표시됨
await coupangApi('POST',
  `/v2/providers/openapi/apis/api/v4/vendors/${VENDOR_ID}/orders/invoices`,
  {
    vendorId: VENDOR_ID,
    orderSheetInvoiceApplyDtos: [{
      shipmentBoxId,
      orderId,
      vendorItemId,
      deliveryCompanyCode: 'CJGLS',   // 실제 발송에 쓴 택배사 코드
      invoiceNumber: '123456789012',  // 실제 운송장 번호
      splitShipping: false,
      preSplitShipped: false,
      estimatedShippingDate: '',
    }],
  })
```
- 이후 배송 상태(배송중/배송완료)는 쿠팡이 택배사 API 연동으로 자동 추적한다. 별도 상태 업데이트 API를 호출할 필요는 없다.
- 실패 시 흔한 원인: ① 발주확인을 안 하고 바로 invoices 호출 ② `deliveryCompanyCode`가 Wing에 등록된 코드와 불일치 ③ 이미 송장이 등록된 주문에 중복 등록 시도.

---

## 7. 자주 나는 에러 체크리스트

| 증상 | 원인 후보 |
|---|---|
| 모든 호출이 401 | 서명 메시지 조합 오류(쿼리 누락), 시계 오차, 키 오타 |
| 모든 호출이 403, 특히 갑자기 시작됨 | 서버 공인 IP가 바뀌었는데 Wing에 갱신 안 함 |
| 상품 등록이 계속 거절됨 | 카테고리 예측이 부정확 / 카테고리 메타의 필수 attributes·notices를 안 채움 / 이미지 스펙 미달 |
| 등록은 됐는데 노출이 안 됨 | `originalPrice < salePrice` 역전, 또는 승인요청을 안 함(TEMPORARY_SAVE 상태에 머물러 있음) |
| 판매중 상품 수정 후 갑자기 판매중지됨 | 전체 등록 API로 수정해서 임시저장으로 강등됨 — 재승인요청 필요 |
| 송장등록이 계속 실패 | 발주확인(acknowledgement)을 먼저 안 함 / 택배사 코드 불일치 |
| 재고 동기화가 조용히 멈춤 | IP 허용목록 만료 (403인데 로그에 에러가 안 남는 구조면 특히 의심) |

---

## 8. 구현 순서 요약 (그대로 따라가면 됨)

1. 0장 체크리스트 값을 전부 확보 (없으면 사용자에게 질문)
2. 1장 인증 모듈 작성 → `coupang-api-test`격으로 아무 GET 하나(예: 반품지 목록 `GET /v2/providers/openapi/apis/api/v4/vendors/{vendorId}/returnShippingCenters`) 호출해 200 뜨는지 확인
3. 등록할 상품 1개로 3장 흐름(예측→메타→조립→임시저장) 시험 → 사람이 임시저장 내용 검토 → 승인요청
4. 승인 완료되면 4장 가격/재고 API로 운영 자동화 붙이기
5. 5장으로 주문 수집 붙이고, 6장으로 발주확인+송장등록까지 연결
6. 7장 체크리스트로 장애 발생 시 원인 좁히기
