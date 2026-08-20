# 토스쇼핑 연동 검토 및 계획 (2026-08-19)

> 상태(2026-08-19 저녁): **P0/P1 완료** — `scripts/lib/toss-api.mjs` + `scripts/toss-register.mjs`로 12건 등록, 11건 자동검수 COMPLETE(인삼의힘 1건 "여백" 반려 보류). 파트너스 표시는 "판매 대기". hide API는 SUCCESS 반환하나 노출상태 변화 없음. **P2(주문 폴링·발주확인·송장) 미착수.** 썸네일 검수 실측 규칙은 §3.6 참조.
> 공식 문서: https://shopping-docs.toss.im/dev (각 페이지 URL 뒤 `.md` 붙이면 마크다운, 인덱스 `llms.txt`)
> 키: `.env.local` `TOSS_SHOPPING_ACCESS_KEY` / `TOSS_SHOPPING_SECRET_KEY` (업체명 더모어커머스, 허용 IP 등록제)

---

## 0. 결론 요약

- **연동 경로는 REST API 하나뿐.** 문서의 "MCP"는 GitBook 문서 검색 MCP(`https://shopping-docs.toss.im/~gitbook/mcp`, 인증 불필요)로 **API를 호출하는 기능이 아님**. 개발 중 문서 질의용으로만 쓸 수 있음. Webhook도 없어 주문은 폴링.
- 인증은 쿠팡 HMAC보다 단순: OAuth2 client_credentials → Bearer 토큰(실측 **만료 3599초**; 문서 예시 31535999는 틀림) → `https://shopping-fep.toss.im/api/v3/shopping-fep/...`. 실측: 토큰 200, 카테고리 조회 200.
- 상점에는 이미 **수동 등록 상품 1건**(탱글 콜라겐 타트체리 젤리 스틱, EXPOSURE/COMPLETE) 있음, 최근 30일 주문 0건. 교환반품지(id 1516561)·묶음그룹(id 1516529) 어드민에서 이미 세팅됨 → 상품 등록 API 호출 전제조건 충족.
- **우리 파이프라인에 가장 싸게 붙는 방법:** `jimscanner_coupang_listings.request_payload`(쿠팡 등록 페이로드: 이미지·상세·고시·가격) → 토스 페이로드 변환. 네이버 등록(`naver-register.mjs`)과 동일 패턴.
- 수수료: 판매수수료 기본 **8%** + 결제수수료 **3%**(VAT 별도) ≈ 쿠팡(10.6%)과 비슷. 정산 구매확정 D+2 영업일.
- 핵심 리스크: **발송기한 페널티**(영업일 기준 `preparationDays`, 미준수 1점/건·14일 10점, 30일 10점=이용정지) — 드롭십(ggsan/유픽) 지연이 곧 페널티. 쿠팡보다 엄격. 그리고 토스도 **IP 허용목록**이라 여행·IP변경 시 쿠팡·네이버와 같은 차단 문제가 생김(고정IP VPS 필요성 ↑).

---

## 1. 실측 결과 (2026-08-19)

| 항목 | 결과 |
|---|---|
| 토큰 `POST https://oauth2.cert.toss.im/token` | 200, `expires_in 3599`, scope `toss-shopping-fep:write` |
| `GET /products/categories/children` | 200, 1차 16개 (식품 = `50995`) |
| 건강식품 leaf | `50995 식품 > 59787 건강식품 > ... > L5 leaf 127개` — 유산균 `59849`, 오메가3,6,9 `59847`, 루테인 `59817`, 밀크시슬 `59823`, 콜라겐/히알루론산 `59863`, 글루코사민 `59805`, 쏘팔메토 `59837`, 커큐민 `59859`, 코큐텐 `59861`, 기타영양제 `59807` 등 |
| 제약 템플릿 `GET /category/{id}/constraint-templates` | 건강식품 leaf 공통: 판매옵션 `수량`(필수) + **(택1)** `개당 캡슐/정` 또는 `개당 수량` (단위 개/정/mg · 개/포/스틱). 허용 고시타입에 `PROCESSED_FOOD`·`HEALTH_FUNCTIONAL_FOOD` 둘 다 포함 |
| 고시 항목 `GET /notices?categoryCode=PROCESSED_FOOD` | id 319(표시사항), 321 제품명, 323 식품의 유형, 325 생산자·소재지, 327 소비기한, 329 용량·수량, 331 원재료명·원산지, 333 영양성분, 335 GMO, 337 주의사항, 339 수입식품 문구, 341 소비자상담 전화 |
| `HEALTH_FUNCTIONAL_FOOD` | id 1,3,5,7,9,11,13,15,17,19,21,23,25,467 (제품명·제조업소·소비기한·용량·원료명·영양정보·기능정보·섭취량·의약품아님·주의·GMO·수입문구·상담전화) |
| 교환반품지 `GET /merchants/group-delivery/exchange-refund-location/v2` | `1516561` 서울 관악구 신사로26길 38-8 301호 (main) |
| 배송비 묶음그룹 `.../delivery-location/v2` | `1516529` "기본 묶음 그룹" (main) |
| 택배사 `GET /delivery-companies` | CJ대한통운 id 1, 롯데 3, 한진 5, 우체국 7, 로젠 9 … |
| 상점 상품 `GET /products/v2` | 1건 (835157677) |
| 주문 `GET /orders/v2` 최근 30일 | 0건 |

---

## 2. API 다이제스트 (구현에 필요한 것만)

공통: 응답은 거의 항상 HTTP 200 + `resultType: SUCCESS|FAIL`, 실패 시 `error.errorCode/reason`. Rate limit 쓰기 30/s·읽기 50/s(초과 시 200 + `TOO_MANY_REQUEST`; 등록 가이드는 "등록/수정 초당 10건"). 만료 토큰 401. 토큰은 캐시해서 재사용(매 호출 발급 시 제한). 모든 엔드포인트에 선택 `partnerName`.

### 2.1 상품 등록 `POST /api/v3/shopping-fep/products/v2`
required: `categoryId, deliveryPolicy, exchangeReturnPolicy, exposure, images, isTaxFree, name, notice, stocks`
- `name` 1~100자 `^[0-9a-zA-Z가-힣 ()\-·\[\]/&+,~.*_#]$` (`@!%$` 불가). **상품명은 최초 등록/REJECT 시만 변경 가능** → 최초 신중. `brandName` 선택(금지어 없음/중국/기타/OEM/협력사). 제조사·원산지·KC 전용 필드 없음 → 고시에 기재. `isTaxFree` 과세 false.
- `stocks[]` ≤300: `options[{groupName,valueName}]`(템플릿 `categorySalesOptions.key`와 일치, 값은 `unitValues` 단위로 끝나야 함, 택1 그룹 중 1개 이상), `remainingCount`(0=품절), `isMainPrice`(정확히 1개 true), `originPrice`(정상가 ≥1), `salePrice`(≤ originPrice; 할인가 별도 필드 없음), `managementCode`, `images[{url,order}]`. **`isSoldOut`·`searchOption` 등 가이드 예시 필드는 v2 스키마에 없음 — 보내지 말 것.**
- `images[]`: `type ∈ THUMBNAIL|DESCRIPTION|DESCRIPTION_HTML|AD`, `url` ≤255자. **THUMBNAIL 1 + DESCRIPTION(또는 _HTML) 1 필수.** 썸네일 1:1 **600×600 이상**(쿠팡 최소 500 → 미달분 패딩 필요), GIF 불가. URL을 토스가 다운로드 — 실패 시 등록 전체 실패, 응답 최대 30분 → 타임아웃 길게.
- `exposure`: `searchKeywords[]`(공백·특수문자 불가 `[0-9a-zA-Z가-힣]{1,10}`, 없으면 `[]`), `description` ≤1500자(AI 추천용; PUT 시 required).
- `deliveryPolicy`: `deliveryType NORMAL`, `deliveryMethod NORMAL`, `preparationDays` 0~14(영업일, 기본 3 = **발송기한**), `deliveryLocationId`(묶음그룹 id, null=개별), `deliveryFeeType FREE|PAID|CONDITIONALLY_FREE|CASH_ON_DELIVERY`, `deliveryFee`, `minimumPurchasePrice`, `isJejuAndIslandsMountainsDelivery`, `jejuDeliveryFee`, `islandsMountainsDeliveryFee`, `deliveryCompanyId`(넣을 것).
- `exchangeReturnPolicy`(전부 필수): `exchangeRefundLocationId`, `refundOneWayDeliveryFee`(편도), `exchangeRoundTripDeliveryFee`(왕복), `applicationMethodDescription`, `applicationTermDescription`(1~500자).
- `notice`: `{categoryCode, items:[{id, content≤4000}]}` — 오기재는 검증 없이 등록되나 반려·페널티 2점.
- 응답 `success.id`. 이후 **자동 검수** `inspectionStatus LLM_INSPECTION_READY→COMPLETE|REJECT(rejectionReasons[])`, 평균 1.5h. COMPLETE 후엔 가격·재고·배송정책만 변경 가능(카테고리·옵션명 변경 불가 → 삭제 후 재등록).
- 수정 `PUT /products/{productId}/v2`(전체 교체, 이미지 변경 시 재검수). 숨김/노출 `POST /products/hide|show {productId}`, 삭제 `POST /products/remove`(노출중 불가). 조회 `GET /products/{id}/v2`, 목록 `GET /products/v2?regStartDate&regEndDate&productIds&nextToken&size`.
- 가격/재고(`productItemId = stocks[].itemId`): `PUT /product-items/{itemId}/sale-price {productId, salePrice}`, `.../origin-price`, `.../stocks/normal-stock/remaining-count {productId, remainingCount}`.

### 2.2 카테고리
`GET /products/categories/children?id=`(생략=1차) → `{id,name,level,parentId,isLeaf,policy}`; `GET /category/{id}/constraint-templates` → `categorySalesOptions[]` + `productNoticeInfoTemplateTypes[]`. 식품 카테고리 옵션 제약은 2026-03-26 변경됨(첨부) → 템플릿 주기 재조회 필요.

### 2.3 주문 `GET /orders/v2?startDate&endDate(≤31일)&status&nextCursor&limit(≤50)`
- 행 단위 `orderProductId`. 상태 `PAID→PREPARING_PRODUCT→DELIVERING→DELIVERED→CONFIRMED_ORDER`(+클레임 상태 15종). `shippingDeadlineAt`, `receiverPhone`(안심번호), `productManagementCode/productItemManagementCode`(우리 키 역매핑용), `deliveryLocationType JEJU|MOUNTAIN|NORMAL`.
- 셀러 전이 `PUT /orders/products/status {orderProductIds≤100, status PREPARING_PRODUCT|DELAY_SHIPPING|DELIVERED|CANCELED_PAYMENT, delayReasonType}` — DELIVERING은 송장 API로만. 발송지연은 주문당 1회·결제 후 3영업일 내·최대 14일.
- 권장 루프: 폴링 → PAID 수집 → `PREPARING_PRODUCT`(발주확인) → 발주 → 송장 `PUT /orders/products/delivery {orderProductId, deliveryCompany("CJ대한통운" 한글명), trackingNumber}` → 자동 DELIVERING. 배송완료 7일 후 자동 구매확정.
- 클레임 `GET /claims?type&status&fromRequestDate/toRequestDate(≤7일)`, 취소요청 7영업일 미처리 → 자동승인. 셀러 임의취소 `POST /order-products/{id}/seller-cancel`(3점).

### 2.4 정산
판매수수료 8%(계약별 상이 가능) + 결제 3%(영세 1.6%), VAT 별도, 기준금액 = 판매가 − 셀러부담쿠폰. 구매확정 D+2 영업일 지급. `GET /settlement-steps?dateCondition&fromDate&toDate(≤31일)&size`.

### 2.5 판매 제한·정책
- **건강기능식품 = 조건부**(건강기능식품 판매업 신고 + 사전 광고심의 표기). 식품은 제조·수입판매업 제품 판매 가능. 농수산물·가공품 원산지 표시 필수.
- 중복등록 4점(카탈로그 AI가 자동 병합), 정상가 과다·등록 후 정상가 변경 2점, 허위과대광고 5점, 판매불가 상품 5점.
- 페널티 합산 30일 10점 = 이용정지, 재발 = 퇴점. 발송기한 미준수 1점/건(+옵션 미노출), +14일 10점, 가송장 3점, 임의취소 3점, 클레임 3영업일 무조치 3점, CS 1영업일 미응대 4점.

### 2.6 테스트 환경
구글폼(outbound IP·담당자) → 메일로 테스트앱·인증번호·공용 테스트 상점 초대. `https://oauth2-alpha.cert.toss.im/token`, `https://shopping-fep-alpha.toss.im`. **검수 통과는 메일로 요청**해야 결제 테스트 가능, 상점은 타 연동사와 공용. → 우리 규모에선 **운영 환경에서 1건 등록 → 바로 숨김**으로 실측하는 편이 현실적.

---

## 3. 우리 파이프라인 설계안

### 3.1 데이터 흐름
```
jimscanner_coupang_listings (APPROVED, source upickb2b/ggsan, request_payload)
  → 변환(카테고리 매핑·옵션 파싱·고시 이식·이미지 600px 보정·가격)
  → POST /products/v2 → jimscanner_toss_listings 기록
  → 검수 폴링(inspectionStatus) → 어드민 표시
주문: 매시간 폴링 GET /orders/v2(PAID) → jimscanner_toss_orders → PREPARING_PRODUCT
  → 발주(order-server kind='toss', 매입처 = 리스팅 source/goods_no)
  → ggsan 송장 감지(기존 크론) → PUT /orders/products/delivery
재고/가격: 기존 stock-sync가 sold_out 판정 시 remaining-count 0, MSP/리프라이스 시 sale-price
```

### 3.2 신규 객체
- `scripts/lib/toss-api.mjs` — 토큰 캐시(만료 60s 전 갱신), `tossGet/tossPost/tossPut`, `resultType` 검사, 초당 10건 스로틀.
- `scripts/toss-register.mjs` — `--no=<seller_product_id|source_goods_no>` 단건 / 배치 `--limit --dry`, 기본 등록 직후 `hide`(육안 검토 후 `show`).
- `scripts/local-cron-toss-orders-sync.mjs` — 31일 창 폴링(쿠팡처럼 자가복구), runs 테이블.
- `supabase/toss_listings.sql`, `supabase/toss_orders.sql` (네이버 테이블 미러: product_id, item_id, source, source_goods_no, category_id, sale_price, origin_price, inspection_status, exposure_status, request_payload, last_response …).
- `order-server.mjs` resolveOrder에 toss 분기(주문 테이블 3번째), `/admin/toss-orders` 페이지(네이버 주문 페이지 복제).

### 3.3 변환 규칙(초안)
| 토스 필드 | 소스 |
|---|---|
| `categoryId` | 상품명 패턴 → leaf (naver `CAT_RULES` 재사용: 유산균 59849, 오메가3 59847, 루테인 59817, 밀크시슬 59823, 콜라겐 59863, 글루코사민 59805, 쏘팔메토 59837, 커큐민 59859, 코큐텐 59861 …, 기본 59807 기타영양제) — 나머지 leaf는 1회 덤프해 매핑표 작성 |
| `name` | 쿠팡 `registered_title`에서 " - 수량별 판매가…" 꼬리 제거(naver `seoName` 재사용), `@!%$` 제거 |
| `stocks[0].options` | `수량: "1개"` + `(택1)개당 수량: "30포"` / `(택1) 개당 캡슐/정: "90정"` — 제목에서 `(\d+)(포|스틱|정|캡슐|개)` 파싱, 실패 시 `개당 수량 "1개"` |
| `salePrice` | 쿠팡 `list_price_krw`(MSP ≥ 보장) ; `originPrice` = **salePrice와 동일**(정상가 과다 페널티 회피; 소비자가 근거 있을 때만 상향) |
| `remainingCount` | 쿠팡 stock_status in_stock → 99, sold_out → 0 |
| `images` | 쿠팡 payload 대표이미지 → THUMBNAIL(600 미만이면 sharp 패딩 후 Supabase site-assets 업로드, `coupang_image_spec` 방식), 상세 이미지들 → DESCRIPTION(order 순) |
| `notice` | `PROCESSED_FOOD`(쿠팡과 동일 가공식품 전략) ← 쿠팡 payload `notices[]`(식품의유형·제조원·소비기한·용량·원재료·영양성분·주의·상담전화) id 매핑. 건기식 판매업 신고 전까지 `HEALTH_FUNCTIONAL_FOOD` 미사용 |
| `deliveryPolicy` | `NORMAL/NORMAL`, `preparationDays 3`(드롭십 리드타임 고려해 2~3 검토), `deliveryLocationId 1516529`, `FREE`(쿠팡과 동일 무료배송 가격구조), 제주/도서산간 `isJejuAndIslandsMountainsDelivery true` + 추가비(ggsan 정책 확인), `deliveryCompanyId 1`(CJ) |
| `exchangeReturnPolicy` | `1516561`, 편도 3,000 / 왕복 6,000(쿠팡과 동일), 신청방법·기간 문구 고정 |
| `exposure.searchKeywords` | naver `seoTags` 재사용(공백 제거, ≤10자, ≤? 개수 제한 문서에 없음 → 5개) |
| `managementCode` | `cp:{seller_product_id}` / item `src:{source}:{goods_no}` → 주문 역매핑 키 |

### 3.4 마진
토스 수수료 ≈ 8% + 3% = 11%(VAT 별도 → 실효 ~12.1%). 쿠팡 `FEE=0.106`과 유사 → 쿠팡 list_price 그대로 쓰면 마진 구조 거의 동일(배송비 정책 동일 가정). `coupang_pricing_model` 상수에 `TOSS_FEE` 추가.

### 3.5 단계
- **P0 (반나절)**: `toss-api.mjs` + leaf 매핑표 덤프 + 유산균 1건 등록(→즉시 hide) → 검수 결과 확인 → 변환 규칙 확정. 실측 포인트: 옵션 단위 검증, 600px, 고시 id, `CASH_ON_DELIVERY` 등 enum 불일치.
- **P1 (1일)**: 배치 등록 — 쿠팡 APPROVED 중 유픽·ggsan 재고 있는 상위 50건(마진 양호·MSP 준수), `jimscanner_toss_listings`, 어드민 리스트 최소 UI.
- **P2 (1일)**: 주문 폴링 크론 + 발주확인 전이 + order-server toss 분기 + 송장 등록(ggsan 송장 크론 연계) + `/admin/toss-orders`.
- **P3**: 재고(품절→remaining 0)·가격(MSP 리프라이스) 동기화, 클레임 조회 알림, 정산 수집.

---

## 4. 결정 필요 / 리스크

1. **건강기능식품 판매업 신고 유무** → 있으면 `HEALTH_FUNCTIONAL_FOOD` 고시로 건기식 정식 등록 가능, 없으면 쿠팡처럼 가공식품(PROCESSED_FOOD)만. 토스는 건기식 "조건부 판매"라 미신고 건기식 등록 시 5점 리스크.
2. **발송기한 페널티** — 드롭십 리드타임(ggsan 1~2일, 유픽 1~3일)과 `preparationDays`를 맞추고, 품절 시 `remainingCount 0` 즉시 반영 안 하면 임의취소 3점. stock-sync 연동이 P1보다 먼저여야 안전.
3. **상품명 변경 불가·카테고리 변경 불가** — 최초 등록 품질이 곧 최종. 1건 실측 후 규칙 고정.
4. **IP 허용목록** — 쿠팡·네이버·토스 3곳 모두 IP 제한. 여행/IP 변경 대응으로 고정 IP VPS(sync 크론 이전) 검토 가치 상승.
5. **중복 등록/카탈로그 병합** — 동일 상품 여러 옵션을 별도 상품으로 올리면 4점. 유픽 변형별 별도상품(네이버 방식)은 토스에선 옵션(stocks)으로 합쳐야 함.
6. 테스트 환경은 공용 상점·메일 검수 요청이라 비용 대비 효용 낮음 → 운영에서 소량 실측 권장(등록 직후 hide).

---

## 5. 참고 엔드포인트 모음 (base `https://shopping-fep.toss.im/api/v3/shopping-fep`)
- 카테고리: `GET /products/categories/children?id=`, `GET /category/{id}/constraint-templates`, `GET /product-constraint-templates/{templateId}`
- 고시: `GET /notices/category-codes`, `GET /notices?categoryCode=`
- 셀러: `GET|POST|PUT /merchants/group-delivery/exchange-refund-location(/v2)`, `.../delivery-location(/v2)`, `GET|POST|PUT|DELETE /merchants/holidays`, `GET /merchants/penalty/summary|impositions`
- 상품: `POST /products/v2`, `PUT /products/{id}/v2`, `GET /products/{id}/v2`, `GET /products/v2`, `POST /products/hide|show|remove`, `GET /product-items/grouped-by-products`, `GET /products/{id}/product-items`, `PUT /product-items/{itemId}/sale-price|origin-price|stocks/normal-stock/remaining-count`, `POST|GET|DELETE /purchase-limits`
- 주문/배송: `GET /orders/v2`, `GET /orders/products/{orderProductId}`, `PUT /orders/products/status`, `PUT /orders/products/delivery`, `GET /orders/delivery-companies`, `GET /delivery-companies`
- 클레임: `GET /claims`, `POST /order-products/{id}/seller-cancel`, `POST /claims/{claimId}/cancel|exchange|return/...`
- 정산: `GET /settlement-steps`
- 변경이력: 2026.04.20 착불·희망일 필드, 2026.03.26 식품 옵션 제약 변경, 2026.03.03 배송정책 Phase1(`preparationDays`·`deliveryDeadline`·`deliveryCompanyId`), 2025-12-15 v1 주문/상품/검수요청 API 제거(자동 검수)

---

## 3.6 썸네일 검수 실측 규칙 (2026-08-19, 12건 등록 경험)

- 원본(ggsan/유픽)의 브랜드 로고·HACCP 뱃지·콜아웃 오버레이 → 즉시 REJECT("텍스트·로고·워터마크·테두리") → **Gemini(`gemini-3.1-flash-image-preview`) 클린 패키지샷 필수**(toss-register.mjs 기본 동작).
- "여백" 반려의 실체는 흰 여백이 아니라 **구도**: ① 제품이 프레임에서 잘림(징코 블리스터) ② 와이드 구도로 상하 빈 띠·반사 밴드(인삼의힘·리탱글 1차) → 반려. **세로로 긴 구도(좌우 여백 20~25%)·정사각 꽉 찬 구도는 통과**(징코 박스단독, 판토모틴 대각선, 리탱글 박스+스틱).
- Gemini는 같은 입력엔 거의 같은 레이아웃을 내므로 구도 변경이 안 먹으면 `--src`(다른 원본)·`--crop`(원본 일부만 입력)으로 입력을 바꿀 것. 회색 배경은 스크립트가 선형 게인으로 화이트닝 후 트림.
- 자동 검수는 1~20분, REJECT 사유는 `GET /product-items/grouped-by-products`의 `productItems[].rejectReasons`. 재검수는 `PUT /products/{id}/v2`(썸네일 URL 교체, stocks에 id/itemId 동봉 → itemId 유지).
- 고시 헤더 항목(PROCESSED_FOOD 319)도 content 필수. 카테고리별 판매옵션 템플릿 상이(건강식품: 수량+(택1)캡슐/정|개당수량 / 건강즙: 수량+개당용량+개당수량 / 홍삼: 수량+(택1)중량|용량|캡슐).
- **운영 지침: 한 번에 대량 등록하지 말고 1건씩 검수 완료 확인 후 다음 등록** (사장님 지시).

---

## 3.7 P2 구현 내역 (2026-08-20)

- `supabase/toss_orders.sql` — `jimscanner_toss_orders`(orderProductId 단위, 매입 상태머신·ggsan 추적·toss_invoice_status, RLS) + `jimscanner_toss_orders_sync_runs`
- `scripts/local-cron-toss-orders-sync.mjs` — Windows 작업 **Toss-Orders-Sync**(매시 :17, 30분 제한): ① 31일 창 주문 수집(upsert, 매입 컬럼 보존) ② PAID→PREPARING_PRODUCT 자동 발주확인 ③ ggsan order_view 추적(취소/반품 needs_attention·실결제액·송장 감지) ④ 송장 → `PUT /orders/products/delivery` **직접 등록**(토스는 IP 허용제라 쿠팡처럼 Vercel 라우트 경유 불가) → registered/failed
- `/admin/toss-orders`(사이드바 토스쇼핑 그룹) — 발송기한 D-1 경고, 매입 상태/주문번호 기록(PurchaseCell → `/api/admin/toss-orders/update`), 결제진행(쿠팡 PurchaseButton 재사용 — 로컬 order-server가 쿠팡→네이버→토스 순으로 주문키 해석)
- `scripts/order-server.mjs` — `resolveTossOrder`: 매입처 = 주문별 오버라이드 > `item_management_code`("{source}:{goods_no}") > toss_listings 폴백, 완주 시 jimscanner_toss_orders 에 입금대기·주문번호 기록
- 미구현(P3): 재고 sold_out→remainingCount 0 동기화, MSP 리프라이스 연동, 클레임 폴링
