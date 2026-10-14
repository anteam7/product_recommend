# 토스쇼핑 연동 검토 및 계획 (2026-08-19)

> 상태(2026-08-19 저녁): **P0/P1 완료** — `scripts/lib/toss-api.mjs` + `scripts/toss-register.mjs`로 12건 등록, 11건 자동검수 COMPLETE(인삼의힘 1건 "여백" 반려 보류). 파트너스 표시는 "판매 대기". hide API는 SUCCESS 반환하나 노출상태 변화 없음. **P2(주문 폴링·발주확인·송장) 미착수.** 썸네일 검수 실측 규칙은 §3.6 참조.
> 상태(2026-10-13): **재개** — 8/19 등록분 11건이 두 달간 `WAITING_FOR_SALE`(판매 대기)로 묶여 있던 것을 `POST /products/show` 로 전부 SELLING 전환(§3.8). 단건 5건 추가 등록 + `scripts/toss-register-batch.mjs`(1건씩 검수 확인 후 다음, 자동) 로 상위 20건 일괄 진행. 토스 API IP 허용 갱신 필요했음.
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
- `/admin/orders?market=toss`(2026-10-13 전 마켓 통합 페이지로 합침, 옛 `/admin/toss-orders`는 리다이렉트; 토스 셀은 `orders/toss/PurchaseCell.tsx`) — 발송기한 D-1 경고, 매입 상태/주문번호 기록(PurchaseCell → `/api/admin/toss-orders/update`), 결제진행(쿠팡 PurchaseButton 재사용 — 로컬 order-server가 쿠팡→네이버→토스 순으로 주문키 해석)
- `scripts/order-server.mjs` — `resolveTossOrder`: 매입처 = 주문별 오버라이드 > `item_management_code`("{source}:{goods_no}") > toss_listings 폴백, 완주 시 jimscanner_toss_orders 에 입금대기·주문번호 기록
- 미구현(P3): 재고 sold_out→remainingCount 0 동기화, MSP 리프라이스 연동, 클레임 폴링

## 3.8 2026-10-13 재개 — 판매 대기 해소·일괄 등록 러너

**발견.** 8/19 등록분 12건 중 11건이 두 달 내내 **아이템 상태 `WAITING_FOR_SALE`(판매 대기)** 였고 토스 주문은 0건. 원인은 등록 직후의 `POST /products/hide`: 상품 `exposureStatus` 는 EXPOSURE 그대로라 "노출"처럼 보였지만, 실제 구매 가능 여부는 **`GET /product-items/grouped-by-products` → `productItems[].status.code`** 가 결정한다(`summaryStatus` 는 SELLING 이어도 PENDING 으로 찍히므로 무시). `POST /products/show` 호출 즉시 `SELLING` 으로 바뀜 → 11건 전부 전환. 인삼의힘(835563999)은 토스에서 삭제돼 있었고(DB `REMOVED`), P0 테스트 건(835157677 타트체리 젤리)은 DB에 없어 보강.

**정합 조치.** 토스가 < 현재 쿠팡 MSP 인 타트체리즙은 `tossSetOriginPrice`→`tossSetSalePrice` 로 22,900 으로 올린 뒤 show. 쿠팡이 STOPPED(매입처 품절·auto_paused)인 타트체리 젤리는 토스도 hide(가격은 MSP 이상으로 정정). 쿠팡 재등록으로 spid 가 바뀐 커큐민은 `jimscanner_toss_listings.coupang_seller_product_id` 를 새 spid 로 교정 후 show. **토스 가격·재고는 쿠팡과 자동 동기화가 없다** — 후속 과제(쿠팡 price/stock sync 에 토스 반영 추가).

**등록기 수정(`toss-register.mjs`).** `--opts` 키는 정확 일치(공백·(택1) 무시) 우선, 부분 일치는 템플릿의 다른 키와 정확히 같은 오버라이드는 제외("수량"이 "개당 수량"을 덮던 버그). 제목에 "x 15포/스틱"이 있으면 택1 그룹에서 '개당 수량'을 먼저 고르고, 그 키가 없는 템플릿(다이어트식품 등)은 '개당 캡슐/정'에 포 단위로 넣는다(쿠팡 itemName 이 "15정"으로 적힌 젤리 스틱 오류 방지). `\b` 가 한글 뒤에서 경계가 안 생겨 "10포 4박스"의 4박스를 못 잡던 버그 수정. `CAT_RULES` 를 leaf 131개 기준으로 확장(비타민군·멀티비타민·홍삼 형태별·건강즙 종류별·분말/환·다이어트·헬스보충). 카테고리 매핑 입력은 상품명 + 쿠팡 display_category_name.

**신규 등록은 `--show` 로.** 검수(COMPLETE)가 노출을 막아주므로 hide 가 필요 없고, hide 하면 위의 판매 대기 함정에 빠진다.

**일괄 러너 `scripts/toss-register-batch.mjs`.** 후보 = 쿠팡 APPROVED·auto_paused=false·request_payload 있음·매입처 ∈ ggsan/upickb2b/bio77/kwholesale·MSP>0·토스 미등록(spid)·토스에 같은 상품명 없음. 우선순위 = 최근 90일 쿠팡 판매수량 → 매입처 순 → 가격. 1건 `--show` 등록 → `--check` 60초 폴링(최대 25분) → COMPLETE/REJECT 기록 → 다음. 연속 실패 3건 또는 TIMEOUT 이면 중단. 로그 `_workspace/toss-batch-<KST날짜>.jsonl`. `--list` 로 계획만 출력. 화장품스토리(cmtstory)·웰루트 농산물은 카테고리/고시 미지원이라 후보에서 제외(후속: 화장품 카테고리·고시 매핑).

**이날 결과.** 단건: 위드바이오 유산균·웰러스 햄프씨드·탱글 석류젤리·네이처그랜드 비타민B 통과, 김소형원방 다이어트 카페는 "여백" 반려 → `--rethumb`(세로 단일 박스 구도)로 교체 재검수. 일괄 20건 결과는 CLAUDE.md 변경 이력 / 로그 참조.

### 3.8.1 추가(2026-10-14 새벽) — 일반 식품·반려 자동 조치·가격 보정
- **일반 식품 카테고리**: `scripts/toss-dump-food-leaves.mjs` 가 토스 식품(50995) 트리 전체를 BFS 로 받아 `scripts/lib/toss-food-leaves.json`(leaf 1,280개) 에 캐시. `toss-register.mjs` CAT_RULES 에 식용유(올리브유·들기름·참기름·기타오일, 캡슐 제품 제외)·잡곡/씨앗·꿀/시럽·미숫/선식·건과/견과·차/커피·식초·음료/간식 규칙 추가(건강식품 규칙 뒤, 환/분말 규칙 앞). 모든 식품 leaf 템플릿이 PROCESSED_FOOD 고시를 받으므로 고시 로직은 그대로.
- **반려 자동 조치(`toss-register-batch.mjs`)**: "카테고리 불일치" → 반려 메시지의 추천 경로를 `lib/toss-categories.mjs` 로 leaf id 로 풀어 기존 상품 삭제 후 `--cat --force` 재등록(삭제 전 `--dry --require-opts` 로 옵션 확보 확인, 미확보면 보류). "여백" → `--rethumb --strict --apply` 풀블리드 패키지샷 교체 재검수(1회). 둘 다 실패 streak 에 안 셈. 시작 시 최근 24h 반려분도 같은 조치.
- **옵션 가드**: 제목/속성에서 수량·중량·용량·캡슐 수를 못 찾아 자리값("1개")이 되는 상품은 `--require-opts`(러너 기본) 로 등록하지 않고 `OPTS_UNKNOWN` 건너뜀(로그). 매입처 실시간 품절도 `SOLD_OUT` 건너뜀. 파싱 개선: "10g x 30포"의 g 는 낱개 중량(mg 만 함량으로 제외), 액상 키워드면 g→ml 대체, 쿠팡 속성(개당 용량/중량) 폴백, 택1 우선순위 개당 수량→캡슐/정(포 단위)→중량/용량.
- **수수료 차이 가격 보정(사용자 요청)**: `lib/toss-price.mjs` — 토스가 = 쿠팡가 × (1−f_c−1/11)/(1−f_t−1/11), f_c=쿠팡 매입처별(10.6%/화장품 9.6%), f_t=토스 11% → 같은 순이익(기본 약 +0.5%, 10원 올림, MSP 이상). 등록기 기본 적용(`--no-fee-adjust` 로 끔), 기등록분은 `scripts/toss-reprice.mjs`(정가→판매가 순, 실패 시 정가 되돌림, 쿠팡 STOPPED/품절은 보류) 로 일괄 반영(2026-10-14 41건). 쿠팡 가격이 바뀌면 다시 돌리면 된다(크론 미연결 — 후속).

### 3.8.2 추가(2026-10-14 새벽 2차) — 감독 루프 공회전 원인·수정
새벽 감독 루프(`toss-register-supervise.sh`, 40회) 결과: 1회차만 20건 등록(12 통과)하고 2~40회차는 2분 만에 "연속 실패 3건"으로 멈춤. 원인과 조치:
- **대표 이미지 404**: 쿠팡 등록 때 payload 에 저장한 ggsan CDN 대표 이미지 URL 이 공급처 이미지 교체로 404(포스파티딜세린 2종·NMN). 러너는 이 실패를 DB 에 남기지 않아 매 회차 같은 3건에서 멈췄고, 감독 루프는 ✗ 줄 수(이어받은 TIMEOUT 포함)를 "진전"으로 오판해 10분 대기 없이 2분 간격으로 돌았다.
  - `toss-register.mjs ensureThumb` — URL 후보 배열(대표 → 쿠팡 CDN 사본 → ggsan 현재 페이지 대표 → 나머지 payload 이미지)에서 받아지는 첫 이미지를 쓴다. 비이미지 응답(404 HTML)은 sharp metadata 로 걸러냄.
  - `toss-register-batch.mjs` — 등록 전 단계 실패(이미지·브랜드 금지어·MSP 미달·고시 불가 등 상품 자체 문제)는 `jimscanner_toss_listings` 에 `FAILED` 행(toss_product_id 없음, rejection_reasons 에 오류)으로 남겨 후보에서 제외. 네트워크·토큰·IP·429 같은 일시 오류는 남기지 않음. `--retry-failed` 로 다시 후보에 넣을 수 있고, `toss-register.mjs` 는 FAILED 행을 중복으로 보지 않으며 성공 시 지운다. 오류 메시지는 스택 꼬리 대신 `Error:` 줄을 기록.
  - `toss-register-supervise.sh` — 진전 = 새 등록 또는 검수 통과가 있을 때만. 무진전 회차는 10분 대기, 연속 6회면 종료(사람 확인). 파일명 날짜는 로컬(KST) `date`(Git Bash 에서 `TZ=Asia/Seoul` 은 UTC 로 떨어져 10-13 으로 찍혔음).
- **토스 검수가 일부 상품을 수동으로 돌림**: 새벽 등록 20건 중 14건이 90분 안에 결과가 없었고 3시간 뒤에도 `LLM_INSPECTION_READY`(같은 시간대 다른 상품은 1~8분에 통과) → 전역 지연이 아니라 상품별 수동 검수로 추정. 러너는 이어받은 대기분(창 7일)을 실행당 1회만 확인하고 계속 대기면 `⏳` 로 두고 TIMEOUT 실패로 세지 않는다(세면 창 크기만큼 연속 TIMEOUT 으로 등록이 멈춤).
- **옵션 파싱에 고시 제품명 보강**: 제목에 수량·중량 토큰이 전혀 없을 때만 고시 "제품명/포장단위"(ggsan 원문, "60gx3병")를 제목 다음·쿠팡 itemName 앞에 끼운다. itemName 은 쿠팡 속성("3 회분")에서 만들어져 "3정 1박스"처럼 틀릴 수 있어 홍삼분말세트가 "3정"으로 등록돼 "상품 정보 불일치" 반려됐었다 → 수량 3개·개당 중량 60g 으로 재등록. 같은 보강으로 헬씨허그 올리브오일(제목 "100%")도 자동 재등록·통과(옵션은 1개·10g — 실제 10g×30포, 필요하면 수량 30포로 손질).
- 반려 수동 조치: 알파CD 원데이(옵션 정보 오류 → 수량 6박스·개당 14포 로 재등록), 굿바이 스트레스(기타영양제·L테아닌 모두 불일치 → 복합아미노산 60057 로 재등록), 글루타치온 필름(세로 단일박스·두 박스 구도 모두 "여백" 4회 반려 → 보류, 수동 썸네일 필요).

### 3.8.3 추가(2026-10-14 오전) — "옵션 수량" 반려 → 수량 1개 기본

- **현상**: 09:30~09:50 등록분 8건이 연속으로 `기타 반려사유 — 옵션 정보가 잘못 입력되었어요. 옵션 수량 또는 가격 정보를 확인, 수정해 주세요.` 러너는 "연속 실패 9건"으로 멈췄지만 감독 루프가 등록 수를 진전으로 보고 30초 뒤 재시작.
- **원인(10-13·10-14 러너 로그 116건 집계)**: 토스 `수량` 옵션을 묶음 수(2개·3개·6개…)로 올린 29건 중 통과 3 · 반려 11 · 90분 초과(수동 검수) 15. 수량 1개는 79건 중 통과 56(반려 9는 썸네일·상세 사유). 같은 구성이라도 수량>1이면 검수가 "옵션 수량/가격" 반려나 수동 검수로 돌린다. 부수 버그: "콘드로이친 1200 세트"→수량 1200개, "25ml x 30병"→수량 30개 + 캡슐/정 30정.
- **수정**: `toss-register.mjs` 수량 기본 `1개`(세트, 구성은 제목에 유지; 옛 동작은 `--pack-qty` 또는 `--opts="수량=N개"`), 병·통·캔만 있는 상품은 개당 수량 N개. `toss-register-batch.mjs` `tryRequant`: 이 사유 + 등록 수량≠1개면 dry 확인 → 삭제 → DB REMOVED → 같은 카테고리로 재등록(1회, 시작 시 24h 반려분에도 적용). `toss-register-supervise.sh`: "연속 실패" 중단이면 종료(사람 확인), 러너 크래시(exit≠0·후보 0)는 소진이 아니라 무진전으로, 로그 이름에 시작 시각(`toss-run-<날짜>-<HHMM>-<회차>.log`).
- **남는 수동 거리**: 썸네일 "텍스트·로고·워터마크"(3), "상세 이미지 검증 실패"(3), 카테고리 불일치 자동 재등록 실패(흑삼차·아토셀), 글루타치온 필름(여백 4회).
- **검증(10:06 재시작)**: 수량 1개로 재등록한 33건 중 자동 검수 23건 전부 통과(1~17분). **수동 검수(90분+)로 넘어간 건은 수량과 무관하게 전부 반려** — 10-13 밤~10-14 아침 40건 중 35 반려(그중 수량 1개 16건, 쿠팡 정보와 일치) · 5 대기 · 통과 0. 기준은 공개 문구로 확인 불가(가격 추정, 가격모니터 시세 자료 없음) → 수동 검수 반려 수량 1개 건은 자동 재등록하지 않고 REJECT 로 둠(파트너센터 문의 권장: 예 856330817). 러너: 이어받은 건의 반려는 실패 streak 에 안 셈, **25분 넘게 검수 중이면 수동 검수로 보고 창에서 제외**(`--escalate-min`, 결과는 계속 추적·다음 실행 7일 창) — 재등록 8건이 수동 검수로 넘어가 창 8칸을 모두 붙잡고 러너가 30분+ 놀던 것.

### 3.8.4 추가(2026-10-14 오후) — "검색태그 금칙어" 반려 → 금칙어 제외 재등록

- **현상**: 2회차(11:03~) 더존건강 "명품 황제 … 진액" 3건이 `검색태그 금칙어 — 검색태그에 상품명 금칙어와 동일한 단어는 입력할 수 없어요. 금칙어를 삭제한 뒤 다시 등록해 주세요. (금칙어: 명품)`로 반려. 등록기 `keywords()`가 제목 앞 6토큰을 검색태그로 쓰므로 제목의 "명품"이 그대로 태그가 됐다. 토스 금칙어 목록은 비공개(웹에도 없음) — 반려 문구의 `(금칙어: X)`가 유일한 소스.
- **수정**: `toss-register.mjs` `NAME_BANNED`(기본 명품 + `--ban=단어,단어`)를 상품명 토큰에서 제거(ℹ 로그), `TAG_BANNED`(NAME_BANNED + 최고·최저가·1위·베스트·특가·할인·정품·추천·인기 등 과장어)를 검색태그에서 제거. 토스가 "상품명 금칙어"라고 분류한 단어이므로 태그만이 아니라 상품명에서도 뺀다(상품명은 등록 후 변경 불가라 재등록 필요). `toss-register-batch.mjs` `tryRetag`: 이 사유면 메시지에서 금칙어를 뽑아 dry 확인 → 삭제 → DB REMOVED → 같은 카테고리 `--ban=` 으로 재등록(1회, 시작 시 24h 반려분에도 적용). 새 금칙어가 반복되면 등록기 기본값에 추가.
- **같은 시각 다른 반려(수동)**: `상품 정보 불일치` 2건 — 양배추즙 젤리 "20gx10포*3개입(선물세트)"(수량 1개 세트로 올려 정규화 상품명과 수량 불일치: 묶음 표기 상품은 `--pack-qty` 재등록 판단 필요), 흑마늘 진액 70ml(상품명 용량과 상세 이미지 표기 불일치: 공급처 자료 확인 필요).
- **OPTS_UNKNOWN 건너뜀 48건 분석(3회차, 후보의 17%)**: bio77 23 · ggsan 13 · upickb2b 11 · wellroot 1. 쿠팡 데이터(itemName "1박스", 속성 공란)·공급처 DB(bio77 총중량만, ggsan raw_payload 고시 없음, bio77 detail_html 비어 있음, ggsan 상품 페이지에도 내용량 표기 없음) 어디에도 캡슐·정 수가 없는 알약류 ~38건은 수동 `--opts`(상세 이미지 보고 입력) 외 방법 없음. 자동으로 풀 수 있는 두 유형을 수정: (1) 제목 "1L x 2병"인데 쿠팡 itemName "2정 1박스"(속성 "2 회분"에서 생성)가 정 수로 잡혀 병 수를 못 세던 것 → 제목에 병·통·캔이 있고 정/캡슐/포가 없으면 제목 우선(`bottlesTitle`), (2) 분말·가루·청·꿀·오일·스프레이·흑마늘·케일처럼 낱개 토큰 없이 중량/용량만 있는 단일 용기 상품은 `개당 수량 1개`가 사실 → `u.single`이면 ℹ 로 채우고 자리값으로 세지 않음(진액·보액·즙·정제·스틱·박스·세트는 제외 — 보령마가천 2100ml 는 70ml x 30포 박스). 검증: 오미자 진액 1L x 2병 → 수량 1개·개당 수량 2개·개당 용량 1l, 커큐민 분말 100g·레몬 과즙 분말 200g·사양벌꿀 2.4kg → 개당 수량 1개, 마가천 진액골드·오리진 멀티비타민은 여전히 OPTS_UNKNOWN.
- **3회차 종료(15:07)**: 후보 286 중 129 진행, 등록 83·통과 79·반려 9·건너뜀 49·대기 18. 중단 사유는 같은 계열(유기농 동결건조 하스카프베리 분말 스틱/통·NFC 블루베리 착즙액) 3건 연속 "상세 이미지 검증 실패" → 감독 루프 규칙대로 종료. 남은 후보 157건(wellroot 98·bio77 55·kwholesale 4)에는 같은 계열이 4건뿐이라 재시작.
- **"상세 이미지 검증 실패" 자동 조치(15:30)**: 오늘 7건 전부 `N번 상세 이미지 가로 크기가 최소 600 이상이어야 합니다`(헬씨허그 글루타치온 임팩트·내츄럴플러스 관절연골엔·마린에이 효소 2건·유기농 동결건조 하스카프베리 2건·NFC 블루베리). `toss-register.mjs` `ensureDetailWidth`: 등록 전 DESCRIPTION 이미지를 받아 가로 600px 미만이면 600px 로 확대(세로 비율 유지, JPEG 90) 후 site-assets `toss/{spid}/detail_{order}_{ts}.jpg` 업로드 URL 로 교체(다운로드·업로드 실패 시 원본 유지, dry 는 생략). `toss-register-batch.mjs` `tryRedetail`: 이 사유면 삭제 → 같은 카테고리 재등록(1회, 시작 시 24h 반려분·폴링 둘 다). 상세컷은 등록 후 PUT 으로 못 바꾸므로 재등록이 유일한 경로.

### 3.8.5 추가(2026-10-14 저녁) — 2회차(15:13~) 결과와 네 가지 결함 수정

- **2회차(toss-run-20261014-1510-2.log, 후보 201건, 16:47 기준 [201/201])**: 등록 114 · 통과 102 · 반려 12 · 건너뜀 96(OPTS_UNKNOWN, 매 회차 재스킵) · 대기 이월 21. 상세 폭 재등록 7건 중 5건 통과, 2건(글루타치온 임팩트·NFC블루베리)과 금칙어 재등록 천마상황버섯·사양벌꿀은 1.5시간+ 수동 검수 추정. 단일 용기(분말·청·꿀·오일·스프레이) 자동값 9건과 오미자 진액 2병은 전부 통과(생강청만 썸네일 로고 반려).
- **반려 12건 내역**: 여백 4(보령마가천진액골드·크랜베리 호박씨·식이섬유 포뮬러·볶은 귀리분말, strict 교체 후에도) · 카테고리 불일치 2(브로멜라인 퀘르세틴 분말 — 쿠팡 itemName "30정"인데 제목은 분말, 추천 카테고리 없음; 산양삼 60정) · 상품 정보 불일치 2(딥씨 햄프씨드 오일 60캡슐, 폴리시아 프리바이오틱스FOS "상품명과 이미지의 수량 표기가 서로 달라요") · 텍스트/로고 1(고이담은 생강청) · 검색태그 금칙어 1(호로파 60정) · 등록 실패 2(wellroot 류신 마카 아르기닌·베르가못 락토페린: "상세 이미지/HTML 없음").
- **결함 ① 금칙어 부분일치**: 호로파 60정이 `(금칙어: 호로)`로 반려 → 러너가 `--ban=호로`로 재등록했지만 태그 필터가 토큰 완전일치라 "호로파"가 남아 같은 사유로 재반려. `keywords()` 태그 필터를 부분일치(`k.includes(금칙어)`)로 변경(상품명 쪽 `stripBanned`는 완전일치 유지 — 토스는 상품명 "호로파"는 문제 삼지 않았다). 태그가 전부 빠져 비면 카테고리 leaf 이름으로 대체.
- **결함 ② 자동 조치 2세대 반려 반복**: 러너 `pastRejects()`가 DB REJECT(24h)만 보고 `retag/recat/requant/redetail` 플래그를 세우지 않아, 금칙어 재등록으로 만든 상품이 또 반려되면 다음 회차가 또 삭제·재등록할 구조였다(이번엔 1회차 안에서 끝나 미발생). `priorSteps()`가 오늘·어제 `toss-batch-*.jsonl`에서 `step+tossId(ok)`를 읽어 그 단계 플래그를 세움 — 2세대 반려는 사람 몫.
- **결함 ③ 상세 이미지 URL 255자 초과**: 토스 이미지 URL 255자 제한. wellroot 상세컷(cafe24 NNEditor 한글 파일명 인코딩, 263~280자)이 "스킵"되어 DESCRIPTION 0장 → 등록 실패(FAILED 2건). 스킵 대신 `LONG_URLS`에 담아 `ensureDetailWidth()`가 site-assets에 재업로드(폭 600 미만이면 확대 겸)해 짧은 URL로 교체. 2건 수동 재등록 완료(856501433 · 856502193, 검수 대기).
- **결함 ④ 옵션 0값**: 산양삼 60정(wellroot 619)의 쿠팡 itemName/속성이 "0g 1개"라 `개당 중량 0g`으로 등록 + 카테고리 규칙 `/홍삼|인삼|고려삼/` 계열로 홍삼진액/파우치(59995) → 카테고리 불일치. `parseUnits()`에 `nz()`(수치 0은 빈칸) 적용, 정제형 삼 규칙 추가(홍삼 아닌 삼 N정/캡슐/환 → 기타영양제 59807, 홍삼 N정/캡슐 → 홍삼캡슐 59999). dry-run: 산양삼 → 59807 + (택1) 개당 캡슐/정 60정. 산양삼 자체는 여백 반려도 겹쳐 수동 보류. 덤으로 `락토(?!페린)` — 락토페린 정이 유산균(59849)으로 가던 것 수정.
- **수동 재등록 결과(17:00)**: 류신 마카 아르기닌 856501433 **통과**. 베르가못 락토페린 856502193 "여백" 반려(러너가 다음 회차 strict 썸네일 교체). 호로파 60정 856506317은 태그를 비워도 `상품명 / 옵션명 금칙어 (금칙어: 호로)` — **토스는 상품명도 부분일치로 막는다**. "호로파"라는 이름 자체가 못 올라가므로 자동 조치 대상이 아니다(러너 `tryRetag`에 "금칙어가 상품명 토큰 일부면 수동" 가드 추가). "페누그릭 60정" 식 개명은 사장님 판단.
- **수동 처리 대기(누적, 2회차분 추가)**: 여백 4 · 로고 1 · 상품 정보 불일치 2 · 브로멜라인 퀘르세틴 분말(제형 확인) · 산양삼 60정(여백) · 호로파 60정(상품명 금칙어, 개명 여부) · OPTS_UNKNOWN 알약류 ~38 · 수동 검수 반려 수량 1개 16(파트너센터 문의).
- **러너 마무리 공회전(17:40 관찰)**: 2회차는 16:47에 마지막 등록을 끝내고도 수동 검수 추정 2건(알파CD 분말·알부민 120정)을 `--wait-max` 90분까지 붙잡아 17:47까지 1시간 놀았다(감독 루프의 3회차도 그만큼 지연). 후보 소진(또는 중단) 뒤 남은 대기분이 전부 이어받은 건·수동 검수 추정이면 즉시 종료하도록 수정 — 다음 실행의 resumePending(7일 창)이 어차피 재확인한다.
- **OPTS_UNKNOWN 95건 재분석(17:53, `_workspace/toss-opts-unknown-20261014.md`)**: bio77 62(거의 "… 1개 알약케이스 사은품증정" 정제, 수 미상) · wellroot 18 · ggsan 13(정제, 수 미상) · upick 2(치약·아토셀). wellroot 18 중 자동으로 풀리는 세 유형을 수정: (1) 분말·환이 재료 이름(비트·양배추·도라지…) 때문에 건강즙 leaf(용량 템플릿)로 가던 것 → 제형 우선 규칙(분말+즙재료→건강분말 60005, 환+즙재료→건강환 60007), (2) 제목에 N정/캡슐이 있는데 템플릿에 캡슐/정 옵션이 없으면(양배추정 90정 → 쿠팡 노출카테고리 "건강환"으로 건강환 leaf) 기타영양제 59807로 바꿔 다시 짬(`--cat` 지정 시 제외), (3) 키워드에 없는 단일 용기 식품(루피니빈 500g·밥다시마 110g·용융소금 140g·피쉬콜라겐 60g…)도 g/kg 50 이상·ml 100 이상이면 개당 수량 1개(`singleBulk`, mg·소량·진액/포/정/박스는 제외). dry-run 7건 중 6건 자리값 없이 통과, 도라지 맥문동 환(중량 없음)만 계속 수동. 나머지(정제 수 미상 ~75건)는 상세 이미지 판독 외 방법 없음.
- **카테고리 폴백 보강(18:00)**: 규칙에 안 걸리면 전부 기타영양제(59807)였다 → 쿠팡 노출 카테고리 leaf 이름이 토스 식품 leaf 이름과 정확히 하나로 일치하면 그 leaf(`leafByDisplay`, 실측 등록 대상 616건 중 512건 일치: 기타소금 26769·혼합곡/기타곡류 28483·건다시마 28215·톳 28227·채소가루 26825…). 고른 leaf 가 PROCESSED_FOOD 고시를 안 받으면 기타영양제로 물러남(`--cat` 명시 시 종전처럼 오류). dry-run: 용융소금→기타소금 140g, 루피니빈→혼합곡 500g, 밥다시마→건다시마 110g, 건조 톳→톳 60g.
- **4회차(18:03~18:14, 후보 96)**: 등록 14 · 통과 15 · 반려 9 · 건너뜀 82. 위 수정으로 풀린 wellroot 11건(양배추정 90정·비트 분말 2종·아로니아/복분자 농축분말·루피니빈·피쉬콜라겐·용융소금·밥다시마·건조 톳 등) 전부 통과(3건은 strict 썸네일 교체 후). 반려 9 중 8건이 **신규 사유 "구매옵션 수량 과다"**("구매옵션의 값이 비정상적으로 크게 등록되어 있어요. 구매옵션의 수량은 구매자가 한 번에 구매하는 수량이에요") — 전부 수동 검수(170~420분)로 넘어갔던 건이고, 옵션은 수량 1개 + 개당 수량 30포/28포·개당 캡슐/정 60캡슐 등 자동 검수가 수백 건 통과시킨 것과 동일. 수동 검수자가 "(택1) 개당 수량 30포"를 구매 수량으로 읽는 것으로 보인다. **오늘 수동 검수로 넘어간 건은 사유 문구만 바뀌었을 뿐 전부 옵션으로 반려**(오전 16 + 저녁 8 = 24건). 그대로 재등록하면 검수 우회라 자동 조치하지 않음 — 파트너센터에 "카테고리 판매옵션 템플릿이 요구하는 개당 수량/캡슐 수 값을 수동 검수가 구매 수량으로 반려한다"고 문의 권고. 나머지 1건 아토셀 500ml(upick)은 카테고리 불일치(추천 없음) — 식품이 아닐 가능성, 수동.
- **감독 루프 종료(19:11)**: 5~10회차(18:16~19:11) 후보 82건 전부 OPTS_UNKNOWN 건너뜀 → 무진전 6회로 자동 종료. 검수 대기 7건은 수동 검수 중(다음 실행이 7일 창으로 재확인). DB 집계(19:12): 전체 558: 통과 427 · 반려 67 · 삭제 57 · 검수 대기 7 | 오늘 등록 515: 통과 395 · 반려 60 · 삭제 53 · 대기 7. 남은 수동 목록 81건 `_workspace/toss-opts-unknown-20261014.md`(bio77 59 · ggsan 13 · wellroot 8 · upick 1 — 정제 수 미상이라 상세 이미지 판독 필요). 재개는 수동 `--opts` 등록 또는 새 후보가 생긴 뒤 `bash scripts/toss-register-supervise.sh 40 8 ggsan,upickb2b,bio77,kwholesale,wellroot`.
