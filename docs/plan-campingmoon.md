# 캠핑문(campingmoon.co.kr) 위탁 → 쿠팡·토스 **옵션 단위** 등록 · 결제진행 · 주문/배송/입금 싱크 계획

작성 2026-10-14 · 근거: 로그인 실측 정찰(읽기 전용 — 장바구니·주문서 변경 없음) + 기존 매입처 연동 코드 지도 · 상태: **계획(사장님 검토 대기)**
자격증명: `.env.local` `CAMPINGMOON_USER` / `CAMPINGMOON_PASS`. 문서·메모리에 비번 기록 금지.
요청 원문: "상품정보 수집 → 쿠팡·토스 등록 → 무통장 결제진행 → 배송싱크 → 주문싱크 → 입금완료 상태 쿠팡·토스 연동. 마진은 쿠팡 유사 상품과 비교(Aside CLI)해 너무 높지 않게, 캠핑문은 (상품금액+배송비)의 35% 할인. **옵션별로 등록**."

---

## 0. 한눈에

| 항목 | 내용 |
|---|---|
| 운영사 | **(주)소리** — Campingmoon 한국 총판. 부산 남구 북항로 132(한진택배 우암집배점) 출고/회수 |
| 플랫폼 | **Cafe24**(mall_id `llue89`, AuthSSL 로그인) → 웰루트·K홀세일과 같은 계열. 로그인·주문서·송장 코드 재사용 |
| 계정 | **(사업자) 35% 회원** 승인 완료(`/myshop/index.html` "님은 [(사업자) 35%] 회원"). 과거 주문 0건, 예치금 0. **장바구니에 기존 3건 들어 있음(건드리지 않음)** |
| 규모 | 전체 **952개**(캠핑문 자사브랜드 143 · 코펠/주방 223 · 기타소품 317 · 화로/연료 126 · 텐트/침낭 114 · 테이블/의자 108 · 레저 41). **품절 비율 높음**(자사브랜드 1쪽 20개 중 13 품절) |
| 옵션 | **1축 select 만**(색상/사이즈/선택, 샘플 25개 중 2축·추가옵션 0). 옵션별 가산액(`+4,000원`)·옵션별 품절(`[품절]`, `is_selling:"F"`) 있음 |
| 가격 | 소비자가(취소선) / 판매가. **35% 할인은 상세·장바구니에 안 보이고 주문서 결제예정금액에서만 적용**(회원등급 할인). 공지: 일반 10%·사업자 35%, "정상가 기준" |
| 배송 | 3,000원(15만원↑ 무료, 묶음 가능), **한진택배**, 평일 **14:30** 입금+주문확인분 당일 출고. 제주/도서 "별도 추가금 있을 수 있음"(금액 미표기) |
| 결제 | 상품별 허용 `card,cash,mileage` → **무통장(cash)** 가능. 입금계좌 우리 1005-103-507229 (주)소리. 입금자명 = **사이트 등록명**(B2B 규칙). 위탁은 **실수취인 입력** |
| 고시 | **상품정보제공고시 없음**(상세는 외부 호스트 이미지 1장 + 공통 안내문) → 기타 재화 고시를 우리가 구성 |
| 핵심 리스크 | ① 35% 기준(배송비 포함 여부)은 **첫 실주문에서만 확정** ② 캠핑문은 브랜드 총판 → 쿠팡에 같은 모델을 파는 셀러 다수(아이템위너 경쟁) ③ 옵션 단위 매핑은 **현재 코드베이스에 한 번도 없던 경로**(수집·등록·주문·재고 전부 신규) ④ 가격 인상 공지 잦음 → 리프라이스 크론 필수 |

**권장 순서:** P0 수집(옵션 포함) → P1 가격 모델 + 쿠팡 시세(Aside) 선별 리포트(사장님 승인) → P2 쿠팡 옵션 등록 1건 → P3 토스 옵션 등록 1건 → P4 결제진행 첫 주문 1건(할인 기준 확정) → P5 송장·입금완료·재고 싱크 → P6 리프라이스 크론·어드민 → 배치 확대

---

## 1. 사이트 정찰 결과 (2026-10-14)

### 1.1 로그인·세션
- `AuthSSLDomain=login2.cafe24ssl.com` → raw POST 403. **`scripts/wellroot-collect.mjs` `login()` 재사용**(playwright chrome headless → `#member_id`/`#member_passwd` 입력 → Enter → 쿠키를 fetch 에 이식). 실측 OK(`ECSESSID`, `ec_mem_level`, `/myshop/index.html` 200).
- 봇 보호 없음(~150요청 무차단). 비로그인 페이지는 CDN 캐시 300초 → **품절 동기화는 로그인 세션으로**.

### 1.2 카탈로그·상세 셀렉터
- 목록 `/product/list.html?cate_no=N&page=P`(16개/쪽), 총개수 `.prdCount strong`. 아이템 `li#anchorBoxId_{product_no}` → `a[href*=product_no]`, `img.thumb`, `p.name span`, `ul.xans-product-listitem li`(판매가), `.status .icon img[alt="품절"]`.
- 상세 `/product/detail.html?product_no=N`: `og:title`/`var product_name`, 소비자가 `#span_product_price_custom strike`, 판매가 `#span_product_price_text`/`var product_price`, 상품코드 `P0000GMR`, `var is_soldout_icon='T|F'`.
- **옵션 inline JSON `var option_stock_data`**: `item_code(= product_code+000A…) → {option_name, option_value, option_price(옵션 적용가), stock_price(가산액), is_selling:"T|F", is_display, is_mandatory, item_image_file}`; `<option value="P0000GMK000B">브라운 [품절]</option>`, `(+3,000원)` 접미. 단품은 `single_option_stock_data`. `stock_number`(493·457)는 품절과 무관 → **신뢰 불가, is_selling 만 본다**.
- 이미지 `//campingmoon.co.kr/web/product/{big|medium|small}/YYYYMM/{hash}.jpg`(핫링크 제한 없음), 추가이미지 없음. **상세 = `#prdDetail .cont img` 1장, 외부 `//cki100.x-y.net/campingmoon/100/NNNN.jpg`(~2MB)** → 수집 시 Supabase site-assets 로 복사(외부 호스트 의존 제거).
- 상품명 노이즈: 388개 중 179개가 내부 코드 접두 `a170…`, `ms43…`, `ch…`, `FXK…`; 모델코드는 일부만 끝에(`MT-3955`, `T-2355`); `(옵션품절)` `[스토퍼 포함]` `12개 묶음 50%` `[감성캠핑]`. 브랜드/모델/제조사 행 없음.
- 공개 JSON 없음(robots `/exec/front/` 차단). 검색 `/product/search.html?keyword=`.

### 1.3 주문·마이페이지(읽기 전용 관찰)
- 장바구니 → `Basket.orderAll()` → `GET /order/orderform.html?basket_type=all_buy`. 상품 페이지 **바로구매 `product_submit(1)`** 가 장바구니를 거치지 않으므로 기존 3건과 섞이지 않는다(K홀세일 플로우와 동일, 첫 실행에서 주문서 품목 수 1 확인).
- 주문서 필드명은 미확인(품목 없이 GET 하면 `/`로 튕김) — Cafe24 표준(`#sameaddr1`, `#rname`, `#rzipcode1`, `#raddr1/2`, `#rphone1_*`, `addr_paymethod=cash`, `select#bankaccount`, `#pname`, `#btn_payment`)은 K홀세일 `runFlowKwholesale`(order-server.mjs:771)에서 검증됨.
- 마이페이지 `/myshop/order/list.html`(`#OrderHistoryForm`, 기간 프리셋), 상세 `/myshop/order/detail.html?order_id=YYYYMMDD-0000NNN`. 주문 0건이라 상태 문자열·송장 위치는 **첫 주문 후 실측**(`lib/cafe24-tracking.mjs` `fetchCafe24Order` 는 실배송 미검증).

---

## 2. 가격 모델 (핵심)

### 2.1 매입원가
```
P      = 캠핑문 판매가(상세 표시가, 옵션이면 option_price = P + 가산액)
S      = 3,000 (주문 1건당 배송비; 15만원↑ 무료는 위탁 단건에선 사실상 없음)
cost   = (P_opt + S) × 0.65            ← 사장님 설명 "상품금액+배송비 총액의 35% 할인" (DISCOUNT_BASE=total)
cost'  = P_opt × 0.65 + S              ← 보수안(배송비 할인 제외, 공지 "정상가 기준")
```
- 둘의 차이는 1,050원. **첫 실주문의 결제예정금액으로 확정**하고 그 전까지는 보수안 `cost'` 로 가격을 잡는다(마진이 모자라는 쪽으로 틀리지 않게). 확정 후 상수 하나(`DISCOUNT_BASE`)만 바꾸고 리프라이스.
- 제주/도서산간 추가금은 금액 미표기 → 쿠팡 `remoteAreaDeliverable=N`(미배송), 토스 제주/도서 미배송으로 등록(기존 토스 등록기 규칙과 동일).

### 2.2 판매가 = 셋 중 가장 낮은 값이 아니라 **구간**
```
fee_c  = 쿠팡 카테고리 수수료 — 스포츠/레저 10.8% 로 가정(Wing 카테고리 수수료표에서 확인 필요), 토스 11%
net(price) = price − cost − fee×price − (price − cost)/11                 (src/lib/margin.ts 와 동일)
floor  = max( price where net = cost 대비 순마진 7%,  cost + 2,000원 + 수수료 역산 )   ← 하한(이 아래면 등록 안 함)
target = price where net/price = 10%                                       ← 목표
market = 쿠팡 동일/유사 모델 최저가(Aside 세션 검색, 2.3)
price  = clamp(target, floor, market − 1%)   ;  market < floor 이면 STRUCTURAL(등록 보류, 리포트)
```
- 토스 등록가 = `tossPriceFromCoupang(쿠팡가, 'campingmoon')`(기존 수수료 차이 보정 ×, `COUPANG_FEE_BY_SOURCE.campingmoon` 추가).
- 캠핑문 **자체 소비자 판매가 준수 조건은 없음**(K홀세일·ggsan 과 다름). 계산상 우리 판매가는 캠핑문 판매가의 약 85~95% 가 되어 총판 가격보다 낮아진다 → **총판과의 관계상 허용되는지 사장님 확인**(§8 Q4).
- 옵션 가산액이 있는 옵션은 cost 가 달라지므로 **옵션(vendorItem/토스 stock)마다 가격이 다르다**. 쿠팡은 item 별 salePrice, 토스는 stock 별 salePrice 로 그대로 표현 가능.

### 2.3 쿠팡 시세 비교 — Aside CLI
- `scripts/lib/market-price.mjs` `openCoupangSession({ backend: 'aside' })` → `session.search(kw)` = `{ median, count, items:[{title, price, reviews, rating}] }`(취소선 정가 제외). CDP 9222 는 폴백.
- 검색어 2종: ① `캠핑문 <정제 상품명>` ② 모델코드가 있으면 `<모델코드>`(`MT-3955`). 매칭은 `coupang-pricewatch.mjs` 의 토큰 유사도(≥0.4)를 lib 로 떼어 재사용 + 모델코드 일치는 가중.
- 산출: `market_low`(매칭 최저가), `market_median`, `match_count`, 상위 3건 제목·가격(검수용). `jimscanner_campingmoon_products.market_*` 에 저장, 선별 리포트(§4 P1)에 표로.
- 주의(기존 메모리): 이름 매칭이라 SKU 불일치 과대·과소 가능 → **리포트에서 사람이 훑고 승인**, 매칭 0건은 target 가격으로 등록하되 `pricewatch` 전수 스윕 대상에 포함.

---

## 3. 아키텍처 — 옵션 단위 매핑이 전부 신규

### 3.1 현재 코드베이스의 전제(한 상품 = 한 옵션)와 바꿀 곳
| 단계 | 현재 | 캠핑문에 필요한 것 |
|---|---|---|
| 수집 테이블 | `product_no` 1행, 옵션 라벨 배열만(wellroot) | **상품 + 옵션(item_code) 2계층**, 옵션별 가산액·is_selling |
| 쿠팡 등록 | `lib/coupang-purchase-options.mjs` 가 색상/사이즈 만나면 `{error}` → 건너뜀(wellroot 128중 62 SKIP) | items[] = 옵션 1개당 1 item(`attributes:[{색상/사이즈, EXPOSED}]` + 카테고리 필수 구매옵션), item 별 salePrice·`externalVendorSku` |
| 토스 등록 | `stocks` 1개(`items[0]`), `toss_item_id` 단일, reprice 단일 | **stocks[] = 옵션 1개당 1 stock**(`색상=블랙` + 수량 1개), stock 별 가격·`managementCode campingmoon:{no}:{item_code}` |
| 리스팅 ↔ 매입처 매핑 | `jimscanner_coupang_listings` 1행 = `source_goods_no` 1개 | **vendorItemId/토스 itemId → item_code 매핑 테이블** |
| 주문 → 매입처 | `resolveOrder` 가 goodsNo 만 돌려줌(`order-server.mjs:74`), 토스 `^([a-z0-9]+):(.+)$` | 주문의 `vendor_item_id`(이미 `jimscanner_coupang_orders` 에 저장됨) / 토스 `item_management_code` 로 **옵션까지** 해석 |
| 결제진행 RUN_FLOWS | 수량만 입력, 옵션 선택 없음 | `select[name=option1]` 값 = item_code 선택 후 `product_submit(1)` |
| 재고 싱크 SUPPLIERS | 목록 품절 아이콘(상품 단위) → 모든 vendorItem 일괄 정지 | 상세 `option_stock_data.is_selling` 로 **vendorItem 단위** 정지/재개 + **토스 `tossSetStock`(현재 아무도 안 씀)** |
| 송장 TRACKERS | `cafe24('src','라벨',base,'PREFIX')` 1줄(쿠팡만) | 1줄 추가 + **토스 송장 추적을 TRACKERS 로 일반화**(현재 ggsan 하드코딩) |
| 번들 SKU 파서 | `^(.+?)-B?(\d+)$`, 접두 = goodsNo 전제(`coupangBundleSize`, `orders/model.ts:318`) | 캠핑문 SKU `campingmoon:{no}:{item_code}`(하이픈 없음, 1개 단위만) → 파서가 건드리지 않음. 매핑은 vendor_item_id 우선 |

### 3.2 데이터 모델 (`supabase/campingmoon_products.sql`)
```
jimscanner_campingmoon_products   product_no PK, product_code, name_raw, name_clean, model_code, cate_nos text[], consumer_price, sale_price,
                                   soldout bool, has_option bool, option_title, thumb_url, big_url, detail_image_src, detail_image_copy(site-assets),
                                   content_hash, status(active|gone), coupang_category_code, market_low, market_median, market_count, market_top3 jsonb,
                                   market_checked_at, register_excluded, note, first_seen_at, updated_at
jimscanner_campingmoon_items      item_code PK, product_no FK, option_value, add_price, option_price, is_selling bool, soldout_at, updated_at
jimscanner_listing_items          id, market('coupang'|'toss'), seller_product_id/toss_product_id, vendor_item_id/toss_item_id, source, goods_no, item_code,
                                   option_value, sale_price, status, updated_at      ← 캠핑문 외 매입처도 쓸 수 있는 공용 옵션 매핑
purchase_catalog 뷰 UNION ALL 블록(kwholesale 블록 복제), 리스팅 source CHECK 에 'campingmoon'
```
- 매입원가 = `(option_price + 3000) × 0.65`(또는 보수안) 를 **뷰/스크립트에서 계산**(상수 `DISCOUNT_BASE`), DB 에는 캠핑문 표시가만 저장(가격 변동 추적).

### 3.3 등록표 한 줄씩(복사 금지 원칙, [[feedback_supplier_registry_pattern]])
`local-cron-stock-sync.mjs SUPPLIERS` · `order-server.mjs RUN_FLOWS/SUPPORTED_SOURCES/DEPOSIT_BANK_LABEL` · `local-cron-ggsan-sync.mjs TRACKERS` · `purchase-catalog/sources.ts SOURCE_META` · `register-agent.mjs SOURCE_SCRIPTS` · `api/admin/register-jobs SUPPORTED_SOURCES` · `orders/model.ts SUPPLIER_LABELS/PURCHASE_AUTOMATED_SOURCES/supplierUrl` · `agent/snapshot.mjs·fixtures.mjs` · `toss-register-batch.mjs SOURCES` · `fee.ts FEE_RATE_BY_SOURCE` + `toss-price.mjs COUPANG_FEE_BY_SOURCE`(수동 동기화 쌍).

---

## 4. 단계별 계획

### P0 수집 — `scripts/campingmoon-collect.mjs` (반나절)
- wellroot `login()` 재사용 → 카테고리 152(전체) 1~60쪽 목록 → 상세 952건(옵션 JSON·이미지·상세 1장). 상세 이미지는 site-assets `campingmoon/{product_no}/detail.jpg` 로 복사(sharp 로 폭 ≥600 보장, 토스 검수 기준).
- 상품명 정제 `name_clean`: 내부 접두 `^(a|ms|ch)\d*|^FXK` 제거, `(옵션품절)`·`12개 묶음 50%`·`[감성캠핑]` 제거, 모델코드 추출 `\b[A-Z]{1,3}-\d{3,4}\b`, 금지어·광고성 검사는 기존 `NAME_RULES`.
- `content_hash` 로 변경 감지, 사라진 상품 `gone`. 재실행은 변경분만 갱신. 1시간 크론 아님(일 1회 + 리프라이스 전 실행).

### P1 가격·시세 선별 리포트 — `scripts/campingmoon-market.mjs` (반나절 + Aside 실행 시간)
- 대상: `soldout=false` 이고 옵션 중 `is_selling` 하나 이상. 우선 **캠핑문 자사브랜드(155) + 화로/연료 + 테이블/의자**(브랜드 인지도·단가) 약 300건.
- Aside 세션 1개로 순차 검색(건당 ~6초, 300건 ≈ 30분). `market_*` 저장 → `_workspace/campingmoon-select-<날짜>.md`: 상품 | 옵션 수 | 캠핑문가 | cost | floor | target | market_low(매칭 수) | 제안가 | 판정(OK/STRUCTURAL/NO_MATCH).
- **사장님 승인 게이트**: 수수료율·마진 하한·할인 기준 가정이 리포트 머리에 명시. 승인된 목록만 `register_excluded=false`.

### P2 쿠팡 옵션 등록 — `scripts/campingmoon-register.mjs` (1일)
- 카테고리: `categorization/predict`(cmtstory-register.mjs:300 패턴) + 캐시. 캠핑 카테고리의 필수 구매옵션은 카테고리 메타로 확인(색상·사이즈·수량 등), `isAllowSingleItem` 과 무관하게 **옵션마다 item**.
- items[i]: `itemName = {name_clean} {option_value}`, `attributes = [{attributeTypeName:'색상'|'사이즈', attributeValueName, exposed:'EXPOSED'}, + 필수 구매옵션]`, `externalVendorSku = campingmoon:{product_no}:{item_code}`, `salePrice` 옵션별, `maximumBuyCount` 1~3, 재고 30(기존 ensureQuantity 규칙).
- 고시: 기타 재화(`domeggook-register-one.mjs:70-89` 패턴 — 품명/모델명=name_clean+model_code, 인증="해당없음"(KC 대상 전기·가스용품은 **등록 제외**: 버너·토치·난방·랜턴 전기류는 P1 에서 플래그), 제조국="상품 상세페이지 참조", 제조자/수입자="(주)소리(Campingmoon 한국 총판)", A/S 전화=우리 번호).
- 이미지: 대표 = big(500×500 미달이면 sharp 패딩, [[coupang_image_spec]]), 상세 = site-assets 사본. 옵션별 이미지(`item_image_file`)가 있으면 item 이미지로.
- 등록 후 `jimscanner_coupang_listings` 1행 + `jimscanner_listing_items` 옵션 행(vendorItemId 는 승인 후 GET 으로 채움, 기존 approvals 재확인 루프에 추가).
- **1건 테스트(옵션 3개짜리 의자) → 승인 확인 → 20건 → 배치**. 신규 옵션 경로라 "유효하지 않은 구매 옵션" 거부 공식([[coupang_put_attribute_formula]])을 등록 단계에서도 지킨다(공백 없는 값, 그룹 하나).

### P3 토스 옵션 등록 — `toss-register.mjs` 확장 (1일)
- 쿠팡 리스팅 items[] 전부를 돌며 `stocks[]` 생성: `options = [{groupName:'색상'|'사이즈', valueName}, {groupName:'수량', valueName:'1개'}]`(템플릿이 `사용 인원` 등 다른 키면 템플릿 키 사용), stock 별 `salePrice = tossPriceFromCoupang(item.salePrice,'campingmoon')`, `managementCode campingmoon:{no}:{item_code}`, `isMainPrice` 는 최저가 stock.
- 카테고리: 스포츠/레져 > 캠핑(25995) 하위 leaf 를 캠핑문 cate_no + 제목 규칙으로(의자 26035·캠핑 테이블 26031·텐트 26173·랜턴 25999·버너/스토브 26113·화로대…); leaf 캐시 `toss-dump-food-leaves.mjs --root=24215 --name=sports`. 고시 **ETC_GOODS**(5항목, 실측한 캠핑 leaf 전부 허용) 기본, 조리기구는 KITCHEN_UTENSILS 가 요구되면 전환.
- 도메인 분기 `isSports`(식품/화장품에 이어 3번째) — 식품 규칙·기타영양제 폴백 차단은 화장품과 같은 방식.
- `jimscanner_toss_listings` 는 상품 1행 유지 + `jimscanner_listing_items(market='toss')` 에 stock 별 itemId. `toss-reprice.mjs` 는 listing_items 가 있으면 item 별로.
- **1건 테스트로 다중 stock API 수용 여부 확정**(현재까지 단일 stock 만 써 봄) → 검수 통과 확인 → 러너 sources 에 추가.

### P4 결제진행(무통장) — `order-server.mjs` `runFlowCampingmoon` (1일 + 첫 주문 수동 검증)
- `resolveOrder` 확장: 쿠팡 주문의 `vendor_item_id` → `jimscanner_listing_items` → `{goodsNo: product_no, itemCode}`; 토스는 `item_management_code` `campingmoon:{no}:{code}` 파싱. 기존 매입처는 영향 없음(매핑 행이 없으면 종전 경로).
- 플로우 = `runFlowKwholesale` 복제 금지 → **Cafe24 공용 플로우 함수에 `selectOption(itemCode)` 단계 추가**: 상세 → `select[name=option1]` 에서 `value=itemCode` 선택(라벨 `[품절]` 이면 중단) → 수량 → `product_submit(1)` → 주문서 품목 1건 확인 → 수령인(실수취인) → `addr_paymethod=cash`, 은행 우리, 입금자명 = 사이트 등록명 → 결제예정금액 읽기.
- **금액 가드**: 기대값 두 개(`(P_opt+3000)×0.65` / `P_opt×0.65+3000`) 중 하나와 ±10원 일치해야 진행. 첫 주문은 `--dry`(제출 직전 멈춤)로 금액 확인 → 어느 식인지 확정 → `DISCOUNT_BASE` 고정 → 실제 제출. 품절 문자 수신 가능성(B2B 공지) → 주문 후 1일 내 상태 확인.
- 완료 후 `purchase_status=AWAITING_DEPOSIT`(💰입금대기), 주문번호 `ggsan_order_no`, 계좌 `purchase_note`(기존 K홀세일과 동일). **14:30 컷오프** 안내를 입금대기 행에 표시.

### P5 입금완료 → 마켓 연동 · 송장 · 재고 싱크 (1~2일)
- **입금완료**: 기존 `[✓입금완료]` 버튼 → `ORDERED` + `purchase_jobs(mode='coupang_ack')` → order-server 가 쿠팡 발주확인(변경 없음). 토스는 `local-cron-toss-orders-sync.mjs` ③ 이 PAID 전부를 PREPARING_PRODUCT 로 올리는 현재 동작 유지(입금 전 PREPARING 이 되는 건 캠핑문만의 문제가 아니므로 별도 과제).
- **송장**: `TRACKERS` 에 `cafe24('campingmoon','캠핑문','https://campingmoon.co.kr','CAMPINGMOON')` 1줄. `fetchCafe24Order` 가 한진 송장을 읽는지 **첫 배송에서 실측**. 토스 송장 추적(④, ggsan 하드코딩)을 TRACKERS 를 쓰도록 일반화 → 캠핑문 토스 주문도 자동 송장. 기존 흐름대로 쿠팡 `registerInvoice`·토스 송장 API.
- **재고**: `SUPPLIERS` 에 `campingmoon: {kind:'cafe24', table, key:'product_no', cateCol:'cate_nos'}` + **옵션 단계**: 등록된 상품만 로그인 세션으로 상세 조회(시간당 ~N00건, 300초 캐시 회피) → `is_selling` 변화 → vendorItem 단위 `setVendorSale` 정지/재개 + `tossSetStock(0|30)`(신규 연결). 전 옵션 품절이면 상품 STOPPED+`auto_paused`(재입고 때 크론이 되살리는 규칙 유지).
- 주문 싱크(수집)는 기존 쿠팡/토스 주문 크론이 그대로 가져오므로 추가 없음; `/admin/orders` 매입처 라벨·URL 등록표만.

### P6 리프라이스 크론 · 어드민 (반나절)
- `campingmoon-reprice.mjs`: 일 1회 수집 후 가격 변동분 → 2.2 공식으로 재계산 → 쿠팡 item 별 vendor-item 가격 API(`cmtstory-reprice.mjs` SKU 매칭 패턴), 토스 stock 별 `tossSetSalePrice`. 하한(floor) 아래로는 절대 내리지 않음(MSP 하한 정책과 동일 취지, [[price_msp_floor_policy]]). `run-crons.mjs` 등록.
- `/admin/purchase-catalog` UNION + SOURCE_META, `/admin/orders` 등록표, 등록 큐(register-agent) 연결. 캠핑문 전용 MSP 페이지는 불필요(MSP 없음).

---

## 5. 작업량·순서 요약

| 단계 | 산출물 | 예상 | 게이트 |
|---|---|---|---|
| P0 | collect.mjs, DDL 3테이블, 뷰 | 0.5일 | 952건 수집·옵션 JSON 저장 확인 |
| P1 | market.mjs, 선별 리포트 | 0.5일 + Aside 30분 | **사장님 승인**(수수료·마진·할인 가정) |
| P2 | register.mjs(옵션 items), listing_items | 1일 | 1건 승인 → 20건 → 배치 |
| P3 | toss-register.mjs 스포츠 도메인·다중 stock | 1일 | 1건 검수 통과 |
| P4 | order-server 플로우 + resolveOrder 옵션 | 1일 | **첫 주문 dry 로 할인 기준 확정** |
| P5 | TRACKERS 1줄, 토스 추적 일반화, 옵션 재고 싱크 | 1~2일 | 첫 배송 송장 자동 반영 |
| P6 | reprice 크론, 어드민 등록표 | 0.5일 | 가격 변동 1회 반영 확인 |

---

## 6. 유의사항(기존 교훈 적용)
- 등록 전 쿠팡 FAILED 는 재시도를 막는다([[coupang_register_gotchas]]) → 옵션 거부 사유를 로그에 남기고 수정 후 `--retry`.
- 브랜드는 `Campingmoon`(총판 공식 브랜드) — 유추 거절 위험 낮지만 첫 1건에서 확인.
- 상세 이미지가 1장뿐이라 쿠팡 상세 품질·토스 "상세 이미지 검증"(폭 600) 모두 사본 기준으로 통과시킨다.
- 품절이 많은 공급처 → 등록 대상은 **현재 판매 가능 옵션만**, 품절 옵션은 item 을 아예 만들지 않는다(재입고 시 PUT 으로 item 추가는 카탈로그 매칭 위험 → 재등록 정책은 P5 에서 결정).
- 토스 수동 검수(옵션 반려) 패턴이 캠핑 카테고리에도 나오는지 1건 테스트에서 본다.

---

## 7. 사장님 확인 필요(계획 승인 전)
1. **35% 기준**: 배송비 포함 총액(사장님 설명) vs 상품금액만(공지 "정상가 기준") — 첫 주문 dry 로 확정하기 전까지 보수안으로 가격을 잡아도 되는지.
2. **쿠팡 수수료율**: 스포츠/레저 10.8% 가정. Wing 카테고리 수수료표 확인 부탁(식품 10.6%·뷰티 9.6% 와 다름).
3. **마진 목표/하한**: 순마진 목표 10%, 하한 7% 또는 2,000원 중 큰 값 — 조정?
4. **총판 가격 정책**: 우리 판매가가 캠핑문 소비자 판매가보다 낮아지는 구조(약 85~95%) 허용?
5. **등록 범위**: 952 전체 vs 자사브랜드 143 + 화로·가구 우선 약 300건(권장). KC 대상(전기·가스) 제외 동의?
6. **묶음 수량**: 1개 단위만(권장) vs 2·3개 번들 추가.
7. **장바구니 기존 3건**(4461 18cm·4468 블랙 등 33,000원) 처리 — 비우고 시작할지.
8. 네이버 스마트스토어는 범위 밖(요청: 쿠팡·토스)으로 둠.

---

## 8. 진행 기록 (2026-10-14 밤, 사장님 "그대로 진행해" 승인 후)

- **수수료 확정**: 쿠팡 공식 수수료표(cloud.mkt.coupang.com/Fee-Table) "스포츠/레저용품 기본 10.8%"(캠핑 하위 구분 없음, 부가세 별도 → 실차감 11.88%). 정산 실측 118건으로 영양제 10.6% 일치 확인. 배송비 수수료는 실수취 배송비에만(무료배송 0). `fee.ts`·`toss-price.mjs` 에 campingmoon 0.108.
- **카테고리 메타(쿠팡)**: predict → 캠핑 테이블 81858(색상·사이즈·가로길이 MANDATORY, 수량 축 없음, single 불가) · 캠핑의자 81867(색상·수량) · 코펠세트 81984(색상·수량, 기타 재화 고시 없음 → 스포츠용품/주방용품) · 화로대 81934(사이즈·수량) 등. KC 인증 MANDATORY 없음(RECOMMEND 만), 충전식 랜턴은 배터리 서류 조건부.
- **P0 완료**: `campingmoon-collect.mjs` 964건(판매가능 606·품절 358·옵션 상품 400·옵션 행 1,917·KC 의심 97). 옵션 축 색상 162·사이즈 82·선택 95·복합(색상-사이즈 등) 20여.
- **P1 진행 중**: `campingmoon-market.mjs` Aside 검색 — 0.8초 간격으로 약 30회 만에 쿠팡 차단(검색 null). 간격 3~5.5초로 늘리고 30분 뒤 재개. 첫 21건 판정: OK 5 · BUNDLE2/3 3 · NO_MATCH 6 · STRUCTURAL 7 — **캠핑문 35% 원가로는 쿠팡 최저가(사입 셀러) 아래인 상품이 많다** → 묶음 전략이 핵심. 매칭 오류(특대형화로대 148,000 ↔ 시세 27,600) 보이면 리포트 상위 3건으로 사람이 확인.
- **P2 완료(테스트)**: `campingmoon-register.mjs` — 3744 MT-2 폴딩 중형화로대(단품, 50,250원) → 16414558217, 4456 목베개(색상 2 item, 19,180원) → 16414558248, 둘 다 승인요청(PENDING_APPROVAL). 첫 실행에서 listings `msp_price_krw` NOT NULL 로 DB 기록 실패 → 하한가(floor)를 MSP 칸에 쓰도록 수정, 두 건은 로그 JSON 으로 복구.
- **P3 완료(테스트)**: `toss-register.mjs` 스포츠 도메인 + 다중 stock — 16414558248 → 토스 856602869(색상 2 stock, managementCode = SKU, listing_items 2건). 검수 결과는 러너 `--check`.
- **P4 구현**: order-server `runFlowCafe24Cash`(K홀세일도 이 함수) + 옵션 select + 결제예정금액 기대값 가드(배송비 포함/제외 35% 둘 다 후보, ±10원) + resolveOrder/resolveTossOrder 의 listing_items 해석. **첫 실주문은 `full=false`(제출 직전 정지)로 금액을 눈으로 확인 → DISCOUNT_BASE 확정.**
- **P5 구현**: TRACKERS 1줄(송장은 첫 배송에서 실측), stock-sync SUPPLIERS + 옵션 단계(5-a), followup 이 vendorItemId 를 listing_items 에 채움(승인 후 `node scripts/coupang-followup-approvals.mjs --source=campingmoon`).
- **P6 일부**: 어드민 등록표·카탈로그 뷰(적용됨). **리프라이스 크론(`campingmoon-reprice.mjs`)은 미작성** — 시세 전수 조회가 끝난 뒤 작성.
- **남은 일**: 시세 조회 완료 → 선별 리포트 검토 → `campingmoon-register.mjs`(--limit 20) → 승인 후 followup → 토스 러너 sources 에 campingmoon 추가 → 첫 주문 dry 로 할인 기준 확정 → reprice 크론.

## 9. 전량 등록 모드 (2026-10-15 오전, 사장님 "캠핑문 900여개에 대한 상품 등록")

- **배경**: 시세 조회가 Aside 차단 때문에 10건/28분(전수 25시간+)이고, 조회된 것도 대부분 STRUCTURAL(캠핑문 35% 원가 > 쿠팡 사입 셀러 최저가, 일부는 이름 오매칭)이라 시세 게이트를 유지하면 등록이 거의 안 늘었다(밤새 12건). 사장님이 전량 등록을 지시.
- **규칙 변경**: `campingmoon-register.mjs --allow-nomatch --allow-structural` — 시세 미조회(NO_MATCH)·시세<하한(STRUCTURAL) 모두 **목표가(순마진 10%, ≥하한)** 로 등록. 묶음이 OK 면 묶음 우선(pickPack 그대로). 시세가 들어오면 `campingmoon-market-loop.sh` 가 묶음마다 `campingmoon-reprice.mjs` 를 돌려 천장(시세−1%)까지만 내린다(하한 아래 금지, STRUCTURAL 은 보고만). → "남들보다 높으면 안 됨"은 시세가 하한 위인 상품에서만 보장되고, 하한 아래 시세인 상품은 목표가로 노출된다(사장님 인지 사항).
- **등록기 보강**: 옵션 필수 카테고리(isAllowSingleItem=false)의 변형 1개 상품은 속성만 채워 등록 시도('item 2개 이상' 해석 폐기, 거절되면 되돌릴 것) · 필수 수치 '단 수'는 제목에 N단 없으면 1단 · 상세 이미지 없는 옛 잡화 22건은 대표 이미지를 상세로 · 이미지 '다운로드 실패'는 자동 제외 사유에서 제거 · 연속 오류 6건이면 회차 중단(일시 장애 때 수백 건 훑으며 실패·제외 쌓는 것 방지) · DB insert 실패는 즉시 중단(중복 등록 방지) · 승인요청 직후 '승인반려'는 REJECTED 로 기록(사유는 API 에 없음, Wing 확인).
- **운영**: `CM_REGISTER_FLAGS="--allow-nomatch --allow-structural" bash scripts/campingmoon-register-drip.sh 5 10 300 12`(5건/10분, 3회차마다 followup) + `bash scripts/campingmoon-market-loop.sh 10 25 60` + `bash scripts/toss-register-supervise.sh 40 8`(승인분 → 토스). 02:00 PC 재부팅으로 루프 3개가 다 죽었던 것을 08:22 재시작 — 재부팅 뒤엔 로그 마지막 시각 확인 후 재시작.
- **제외 유지(후보 512 기준)**: 품절 358 · KC 의심 61(`--allow-kc` 전까지, 사장님 판단) · 상품명 광고성 11(특가·세일·사은품·1+1)·타플랫폼 1(스마트스토어전용) · 필수 수치 못 읽는 테이블류('가로길이'). 첫 회차 5건 중 4건은 수 분 내 자동 승인, 1건(1516 돼지꼬리팩, 텐트펙 81819) 요청 직후 자동 반려.
