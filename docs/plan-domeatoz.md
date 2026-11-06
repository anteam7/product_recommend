# 도매아토즈(domeatoz.com) 위탁 → 삼일유통 브랜드 식품 쿠팡 등록 · 적립금 결제진행 · 송장/재고 싱크 계획

작성 2026-10-26 · 근거: 로그인 실측 정찰(읽기 전용 — 장바구니·주문 없음, 2026-10-25~26) + 기존 매입처 연동 코드 지도(캠핑문 계획 §3.3 목록) · 상태: **P0~P1 진행 중**
요청 원문: "이 리스트중에서 수집 가능한 업체를 선정하되 … 1개를 먼저 골라보자" → 실사 12곳 중 1순위 "삼일유통으로 진행해"(2026-10-25).
자격증명: `.env.local` `DOMEATOZ_ID` / `DOMEATOZ_PW`. 문서·메모리·로그에 비번 기록 금지.

---

## 0. 한눈에

| 항목 | 내용 |
|---|---|
| 플랫폼 | **도매아토즈** — 여러 공급사가 입점한 위탁 도매 마켓(자체 Express 서버, UTF-8). 우리는 판매사 회원 |
| 1차 공급사 | **삼일유통(공급사코드 00002137)** — 브랜드 커피믹스·음료·과자·소스. 전체 2,230(식품 2,177) · **판매중 1,195 · 품절 1,035**(2026-10-26) |
| 선정 이유 | 화장품스토리형 "브랜드 소모품 롱테일" — 실도매가 vs 쿠팡 실검색 표본 흑자 14/16(중앙 순마진 +12%), 쿠팡 하위 25% 가격 기준 8/16 |
| 가격 | 목록 `WholesalePrice` = 우리 등급 도매가. 소비자가(MSP) **전부 0** → 판매가 하한 규정 없음. 오토샵프로(월 22만원) 등급은 약 8.7% 더 싸지만 미가입 |
| 배송 | **주문 1건당 3,000원 선불**, **묶음배송 가능 수량 1개**(2개 사면 배송비 2번) → 번들 할인 이점 없음. 제주·도서 각 +3,000. 주문마감 **12:00**, 택배 |
| 결제 | **적립금 선충전**(신한·기업 가상계좌, 10만원~). 출금은 마지막 배송 15일 뒤. 엑셀 일괄 주문 가능 |
| 쿠팡 판매 | 허용. **주문은 반드시 도매아토즈 경유**(직거래 시 ID 정지). 이미지 자유 사용 |
| 판매사 OPEN API | 상품·상태·주문·CS. **사용 승인됨**(2026-10-27 호출 확인, 키 = `/user-api` 발급분 → `.env.local DOMEATOZ_API_KEY/SECRET`). 가이드 `domeatoz.com/pdf/atoz_api.pdf`. 클라이언트 `scripts/lib/domeatoz-api.mjs` — 송장 싱크가 사용, 수집·주문은 아직 웹 |
| 핵심 리스크 | ① 음료·생수는 쿠팡 로켓과 정면 경쟁(시세 매칭 필수) ② 품절 비율 47% → 재고 싱크 필수 ③ 적립금 잔액 부족 시 결제진행 실패 |

**순서:** P0 수집 → P1 쿠팡 시세(규격 매칭) 선별 리포트(**사장님 승인**) → P2 쿠팡 등록 파일럿 20~30건(**"실행" 후**) → P3 적립금 결제진행 → P4 송장·재고 싱크 → 배치 확대 → (P5 토스)

---

## 1. 사이트 정찰 결과

### 1.1 로그인·세션
- `POST /login` form(`ReUrl=/`, `UserId`, `UserPass`) → 응답 본문이 `top.document.location.href='/'` 스크립트, `Set-Cookie: sid=…`. **브라우저 불필요(fetch 로 됨)**.
- `sid` 는 롤링 — 응답마다 `Set-Cookie` 로 갱신되므로 매 응답에서 흡수.

### 1.2 목록
- 공급사별 검색: `POST /search` body `page=N&searchType=5&search=<공급사코드>&group_1=&group_2=&group_3=&group_4=&research=` → JSON `{list}`, 30건/쪽(2,230건 = 75쪽).
- 카테고리 목록: `POST /request-ProductList`(page, category_1..4, listtype=2, liststate=1) → `{tn, boards}`.
- 행 필드: `IDX, PorductCode(sic), ProductName, MiniImage, ConsumerPrice, Category, WholesalePrice, Discount, DeliveryPrice, ProductState, MinorType, ProductAttr, DeliveryType, MiniImagefolder, Overseas, IP_Group_1..4`.
- **`ProductState` 1 = 판매중, 2 = 품절(soldout 오버레이), 3 = 판매중단(이미지 대체)** — 사이트 목록 JS 로 확인.

### 1.3 상품DB 다운로드(수집 원천)
- `POST /dbDownload`(폼: `solution=PL`, `companyCode=in&companyCodeList=<공급사코드>`, 상태 전체 on, 가격 설정 0) → `{Re:1, tn, idx}` → `POST /DbDownPage`(`UserId, idx, n1, n2, Solution=PL`) → `tempdata` = 행 배열(엑셀은 브라우저가 이걸로 만든다).
- 행 필드: `*업체상품코드(AZ0+IDX)`, 모델명, 브랜드, 제조사, `*원산지`, `*상품명`, 원가(=도매가), 배송비, `*과세여부`, `*이미지1~4URL`(상대경로), `*상세설명`(HTML), 키워드, `상품상세코드`(21 가공식품) + `상품상세1~22`(고시 "라벨:값"), `JsonOption`, `ReturnPrice`. 판매 상태 필드는 없음 → 목록 `ProductState` 로.
- 공급사 전 상태 2,307행(목록 2,230 + 단종 77). 한 번 요청으로 끝나고 조회 제한에 안 걸린다.

### 1.4 상세 `/product/{IDX}` — **약 50회 조회 후 "조회 수가 많아 차단되었습니다"**(2026-10-26 실측) → 기본 수집에 쓰지 않음
- JS: `aJson.ProductName/OptionType('Y'|'N')/Price/Image/Category`, `arOption = {optionType, optionName[], items[{itemName[], addPrice, isSoldOut}]}`.
- 텍스트: 상품코드 `AZ0…`, 공급사코드, 상품 등록일·**수정일**, 묶음배송 가능 수량, 과세여부, 배송가능지역, 반품가능여부, 원산지, 제조사/수입사, 모델명, 주문마감 시간, 기본 배송비, 제주/도서산간 추가배송비, 검색 키워드.
- 상품고시: 제품군 "가공식품" — 값은 대부분 "상품 상세설명 참조".
- 이미지: 대표 `https://domeatoz.com/<Image>`. 상세는 삼일유통 G마켓 호스팅 `gi.esmplus.com/samil0101/item2/...` — **공통 배너 `common/intro2.jpg`·`common/info2.jpg` 는 제외**(공급사 안내).

---

## 2. 가격 모델

```
W      = 도매아토즈 도매가(우리 등급)
S      = 3,000 (주문 1건당, 묶음배송 1개라 수량이 늘면 S 도 늘어남)
cost   = W + S
fee    = 쿠팡 식품 10.6% (기본값, src/lib/coupang/fee.ts 에 별도 항목 불필요)
net(P) = P − cost − fee×P − (P − cost)/11                    (src/lib/margin.ts 와 동일)
floor  = max(순마진 7%, 순이익 2,000원)      target = 순마진 10%
ref    = 쿠팡 규격 일치 시세의 하위 25%(P25, 일치 3건 이상) — 2건 이하면 최저가
price  = clamp(target, floor, ref × 0.99) ; ref×0.99 < floor 면 STRUCTURAL(보류) ; 일치 0건 = NO_MATCH(보류)
```
- 수식은 `scripts/lib/campingmoon-price.mjs` 의 공용 함수(`netProfit/priceAtMargin/priceAtAbs`)를 쓰고 원가만 `W+S` 로 바꾼다(`scripts/lib/domeatoz-price.mjs`).
- **1개 단위만 등록**(묶음배송 1개 → 2개 묶음도 원가가 정확히 2배라 이점 없음). 상품명 자체가 이미 "x 40PET" 같은 박스 단위.
- **시세 기준을 P25 로 둔 이유**: 식품 검색 최저가는 로켓·특가가 많아 그 아래로는 못 판다. 실사 때 "하위 25% 가격으로 마진 필터"로 합의한 기준.

### 2.1 시세 매칭(규격 일치)
- 검색어 = 상품명 정제본(괄호·사은품 문구 제거, 50자).
- 일치 = ① 핵심 단어(숫자 없는 앞 4토큰) 절반 이상 포함 ② **용량(ml·g, L·kg 환산) 전부 일치** ③ 수량(x N·N개·N입·PET·캔·병·포 등) 전부 일치, 우리가 단품이면 상대도 단품. 규격 정보가 없는 상품명은 매칭 거부(오매칭 방지).
- 쿠팡 세션: **Aside CLI**(`openCoupangSession({ backend: 'aside' })`), **검색 1분에 1회 이하**(사장님 지시 2026-10-26). Playwright `chrome` 백엔드도 있으나 6~10초 간격에서 약 32회 만에 차단돼 쓰지 않음.

---

## 3. 데이터 모델 (`supabase/domeatoz_products.sql`)

`jimscanner_domeatoz_products` — PK `idx`(도매아토즈 상품 IDX). **공급사 컬럼(`supplier_code/supplier_name`)을 둬서 다른 입점 공급사도 같은 테이블·같은 source `domeatoz` 로 확장**.
- 목록: `product_code, name_raw, name_clean, category_code, group_1..4, wholesale_price, consumer_price, delivery_price, product_state, soldout, status(active|soldout|gone)`
- 상세: `option_type, options, bundle_qty, cutoff_text, tax_type, ship_area, returnable, origin, maker, model_name, jeju_extra, island_extra, keywords[], notice, thumb_url, detail_images, site_registered_on, site_updated_on, detail_fetched_at`
- 판정: `auto_excluded_reason`(비식품·건강식품·냉동/아이스크림·분유·옵션 상품), `register_excluded/_reason`(사람)
- 시세: `market_query, market_low, market_p25, market_median, market_count, market_top3, market_checked_at`
- 등록 캐시: `coupang_category_code/_name/_predicted_at`, `content_hash, first_seen_at, last_seen_at, last_changed_at, updated_at`

---

## 4. 단계별 계획

| 단계 | 산출물 | 게이트 |
|---|---|---|
| **P0 수집** ✅ | `scripts/domeatoz-collect.mjs`(fetch 로그인 → 공급사 목록(상태) + 상품DB 다운로드(내용), content_hash 변경분만, `--details[=N]` 은 상세 페이지 소량) + DDL | 2,230 수집, 재실행 변경 0 |
| **P1 시세 선별** | `scripts/domeatoz-market.mjs`(Aside, 1분 1검색) + `lib/domeatoz-price.mjs` → `_workspace/domeatoz-select-<날짜>.md` | **사장님 승인**(P25 기준·마진 하한·NO_MATCH 보류) |
| **P2 쿠팡 등록** 🔄 | `scripts/domeatoz-register.mjs` — 1 idx = 1 쿠팡 상품(단일 item, 묶음 수 변형도 각각), 판정 OK 만(저장된 시세로 decide 재현), 가공식품 고시, 구매옵션 = `lib/domeatoz-spec.mjs purchaseSpecOf`("142g 5개" → 개당 중량·수량) + `lib/coupang-purchase-options.mjs`, 검색어 `lib/search-tags.mjs`, 상세 = esmplus 상품 이미지 + 위탁 배송 안내, 출고 3일, brand 생략. listings source CHECK 에 `domeatoz`(`supabase/domeatoz_register.sql` 적용). 드립 = `scripts/register-drip.sh domeatoz`(매입처 공용) | 사장님 "확인된 것 먼저 등록, 확인될 때마다 추가"(2026-10-26) → 파일럿 3건 ✅ → 드립 |
| **P3 결제진행** 🔄 | `order-server.mjs` `runFlowDomeatoz`(`RUN_FLOWS.domeatoz`) — 적립금 결제(`DEPOSIT_PAY_SOURCES`·`DEPOSIT_PAY_LABEL`), 브라우저 전 fetch 로 **중복 발주(외부주문코드)·판매 상태** 확인, 완주 가드(수량·단가·등록 도매가 대비 인상·금액 상한·잔액·적립금 = 결제금액), 완료 확인 = 주문 목록 외부주문코드 검색. 사이트 호출은 `lib/domeatoz-site.mjs`(`domeatozProductRow/Cash/FindOrders`). 어드민 `PURCHASE_AUTOMATED_SOURCES`·`PurchaseButton` | 직전 정지 ✅(2026-10-27 첫 주문) → 완주 첫 실행 확인 ⏳ |
| **P4 싱크** 🔄 | 품절 ✅ `local-cron-stock-sync.mjs SUPPLIERS` 1줄 `kind: 'domeatoz'` — 대상 상품의 공급사 목록(`lib/domeatoz-site.mjs`, 수집기와 공용)을 매시 한 번 훑어 `ProductState` 1 = 재고 · 2·3 = 품절, 목록에서 사라진 대상도 품절(목록이 잘리면 throw → 이번 회차 건너뜀). 송장 ✅ `local-cron-ggsan-sync.mjs TRACKERS` 1줄 — **OPEN API** `/orderList`(최근 60일 한 번에) → 주문번호로 상태·택배사·송장 → 공통 루프가 SHIPPED + 쿠팡 송장등록. 등록표 `recent` = **직접 결제 주문 연결**(사이트에서 직접 결제해 DB 에 주문번호가 없는 쿠팡 주문을 외부주문코드·메모의 쿠팡 주문번호로 찾아 주문번호·ORDERED·실결제액 기록 + 쿠팡 발주확인, 2건 이상이면 사람 확인) | 첫 송장 자동 반영 ⏳ |
| P5 | 토스(`toss-register-batch.mjs SOURCES`), 수집(`/productList`·`/productModifyList`)·주문(`/productOrder`) API 전환 검토 | 이후 |

등록표 한 줄씩([[feedback_supplier_registry_pattern]]): `purchase-catalog/sources.ts SOURCE_META` · `register-agent.mjs SOURCE_SCRIPTS` · `api/admin/register-jobs SUPPORTED_SOURCES` · `orders/model.ts SUPPLIER_LABELS/PURCHASE_AUTOMATED_SOURCES/supplierUrl` · `lib/search-tags.mjs kindOf` · `agent/snapshot.mjs`·`fixtures.mjs` · purchase_catalog 뷰 UNION ALL.

---

## 5. 사장님 확인/할 일
1. ~~**적립금 충전**(10만원~, 첫 주문 전)~~ ✅ 2026-10-27 100,000원 충전 확인 — 결제진행은 적립금 잔액에서만 결제.
2. ~~**판매사 OPEN API 사용 승인**~~ ✅ 2026-10-27 승인 확인(송장 싱크에 사용 중).
3. 시세 기준(P25)·마진 하한(7% 또는 2,000원)·NO_MATCH 보류 — P1 리포트에서 확정.

---

## 6. 진행 기록
- 2026-10-26: 전체 목록 재수집 — 판매중 1,195(식품 외·건강식품·다이어트·아이스크림·분유 등 51 제외 시 1,144 · 묶음 수 변형 제외 883종). 실사 때 "표본 300 전부 판매중"은 목록 앞쪽만 본 것(전체 품절 47%). fetch 로그인 확인.
- 2026-10-26: P0 완료 — 상세 페이지 수집은 49건 뒤 조회 제한으로 막혀 상품DB 다운로드 JSON 으로 전환. DB 2,230행, 시세 조회 대상 1,139(자동 제외: 비식품 21 · 건강식품/다이어트 15 · 냉동 8 · 건기식 의심 5 · 분유 2 · 옵션 1 · 상품DB 없음 4). 상세 이미지 0장 4 · 1장 1,008 · 2장+ 183. 일부 상세에 쿠팡 CDN 이미지(공급사가 쿠팡에도 판매).
- 2026-10-26: P1 시작 — `market-price.mjs` 에 `chrome` 백엔드(Playwright channel chrome, 전용 프로필 `_workspace/coupang-chrome-profile`) 추가 + CDP/chrome 공용 `_makePageSearch` 로 정리, 결과 제목 50→100자(식품 규격이 제목 뒤에 붙음). 시험 6건: OK 1 · STRUCTURAL 4(롯데 카스타드 — 쿠팡 P25 < 우리 도매가+배송비) · NO_MATCH 1.
- 2026-10-26 19:31: 전량 조회 1차가 검색 약 32회(6~10초 간격) 만에 쿠팡 차단 → 26건만 판정(OK 5 · STRUCTURAL 16 · NO_MATCH 5). 매칭은 대부분 정확(같은 상품·같은 총량), 허니버터칩·홈런볼처럼 **쿠팡 최저가가 우리 도매가보다 낮은** 소포장이 많다 — 등록 가능분은 배송비가 묻히는 대포장 위주일 것. 보완: 쿠팡 제목 "상품명, 2개, 367.5g"(수량이 용량 앞) 인식, 묶음 수 변형은 끝 수량을 뗀 이름으로 한 번만 검색(1,139건 → 검색 752회), 간격 12~20초, 연속 실패 3회면 세션 닫고 20분 휴식 후 실패한 첫 상품부터 재개(최대 12회). 2차 전량 조회 백그라운드.
- 2026-10-26 19:40: 사장님 지시 — 쿠팡은 Playwright 가 아니라 **Aside CLI 로**, **검색은 1분에 1회 이하**(오래 걸려도 됨). `--backend=aside --gap=60000 --cooldown=30 --max-cooldowns=20 --recheck` 로 재시작(검색 752회 ≈ 13시간+). 재시도도 60초 뒤.
- 2026-10-26 23:14: 시세 대조 1차가 289/1,139 에서 PC 메모리 부족으로 강제 종료(OK 64 · STRUCTURAL 117 · NO_MATCH 94 · 검색 실패 17). 23:16 미조회 862건(검색 663회)만 이어서 재시작(`--recheck` 없이).
- 2026-10-26: P2 — 사장님 "확인된 것들은 먼저 등록하고 추후 하나씩 확인될 때마다 추가 등록". 등록기·규격 공용 모듈(`lib/domeatoz-spec.mjs`, 시세 대조도 같은 모듈 사용)·source CHECK 적용. 묶음 변형을 한 상품의 옵션으로 묶지 않은 이유: 나중에 OK 로 확인된 변형을 붙이려면 판매중 상품 full PUT(임시저장 강등)이 필요하고, 주문↔매입 연결(`source_goods_no` = idx)이 단순해진다. dry 67건 전부 통과(카테고리 27종 모두 가공식품 고시). 파일럿 3건(비빔국수양념 2kg×6 · 마가렛트 660g×5 · 자일리톨 알파 195g×6) 등록 + 승인요청 완료 → `register-drip.sh domeatoz 10 10 200 18`(10분마다 10건, 3회차마다 승인 후속=재고 30) 시작.
- ⚠ 남은 위험: **P3 결제진행·P4 품절 싱크 전**이라 주문은 도매아토즈에서 수동 발주(적립금 필요), 도매아토즈 품절은 쿠팡에 자동 반영되지 않음 → P4 를 다음 작업으로.
- 2026-10-27 00:10: 드립 1회차 10건 ✓ · 3건 ✗ "브랜드 정보가 필요합니다"(프로틴바 102553·초코바 72924·과일잼 58750 — 브랜드 필수 카테고리). 등록기에 그 오류일 때만 브랜드 사전 검색(첫 토큰 완전일치 → brandId, 없으면 이름만) 재시도 추가, 쿠팡 미생성 FAILED 3행 삭제 → 2회차 10건 ✓(오리온 KR-68537·복음자리 KR-69694 로 통과). 누적 23건 승인요청. 브랜드 붙은 상품은 seller gating(유통경로 검토)으로 심사가 길어질 수 있음(plan-cmtstory 실측).
- 2026-10-27 07:43: 정정 — 00:30 메모리 부족 때 죽은 건 시세 대조뿐이고 드립은 계속 돌아 04:52 까지 71건(파일럿 포함 74건 전부 승인완료) 등록 후 후보 소진(18회 무진전)으로 스스로 끝났다. 시세 대조(남은 830건)·드립 재시작.
- 2026-10-27: P4 품절 싱크 — 로그인·목록을 `lib/domeatoz-site.mjs` 로 빼 수집기와 재고 동기화가 같이 씀(수집기 재실행으로 동작 확인: 목록 2,230 · 판매중 1,195 · 품절 1,035 · 변경 0). 등록 74건은 지금 전부 판매중이라 내릴 것 없음. 등록분 예상 마진: 단순 평균 10.76% · 매출 가중 10.34% · 중앙값 10.0% · 건당 순이익 평균 3,038원(10% 초과 21건은 순이익 하한 2,000원 때문), 실주문 0.
- 2026-10-27 08:56: 도매아토즈가 들어간 첫 재고 동기화(08:33) 정상 — 대상 69 · 품절 0 · 오류 0. 그런데 대상이 78이 아니라 69여서 확인해 보니 **재고 동기화 전체 버그**: 활성 리스팅 조회가 페이지 없이 1,000행에서 잘려 1,380 중 401건(최근 등록분 — 캠핑문 180 · 유픽 55 · 건강산 37 · 화장품스토리 23 · 77바이오 15 · 웰루트 12 · 도매아토즈 8 …)이 매 회차 품절 점검 밖이었다(캠핑문 대량 등록 10/16 즈음 1,000 초과 추정). 캠핑문 옵션 단계도 1,115 중 115 누락. `selectAll`(1,000행씩 나눠 읽기)로 수정, 조회 실패는 '활성 상품 없음' 대신 오류로 기록. 09:33 회차부터 전량 점검.
- 2026-10-27 13:50: P3 결제진행 — 주문 흐름 정찰(읽기 전용, 주문서까지만): 상품 페이지 `aJsonArray` + `#ordervalue` → `ProductSubmit()` = `POST /orderInfo`(주문서) → 수령인·`outcode`(외부주문코드)·적립금(`#Cash`, [전액사용] `AllCash()`) → [결제하기] `#tt` = 숨은 iframe 으로 `POST /orderPayment`. 적립금 `POST /request-CashRefresh`, 주문배송조회 `POST /request-orderList`(SearchType=10 외부주문코드 → `IO_OrderNumber·IO_State·IO_DeliveryName·IO_DeliveryNumber` — 송장 TRACKERS 에도 그대로 쓸 수 있음). ⚠ 주문서의 [기본 배송지]·[주문자와 같음] 은 사장님 본인 주소·번호를 채우므로 누르지 않고 칸에 직접 입력. 제주·도서산간은 `BefarZoneState` 가 배송비를 6,000으로 바꿈. `runFlowDomeatoz` 구현 후 첫 쿠팡 주문(오리온 카스타드 690g×2, 5103875375613)으로 **직전 정지** 확인: 상품 17,090 + 배송 3,000 = 20,090원, 적립금 20,090원 적용(보유 100,000), 점검 전부 통과. 완주(실결제)는 사장님 승인 대기. 주문이 12:00 이후라 다음 날 출고.
- 2026-10-27 14:10: P4 송장 — 사장님 "결제는 내가 할게, 배송상태 싱크 연동, API 가 있다더라". OPEN API 가 이미 승인돼 있음을 확인(`GET /myCashSearch` 100,000원). 실측 함정: 주문 조회 기간은 **beginDay = 늦은 날짜·endDay = 이른 날짜**(최대 30일), `/orderListSearch` 의 외부주문코드 검색('외주주문코드')은 서버가 ERROR·'주문관리메모'는 연결 끊김('주문번호'만 정상), 연달아 부르면 가끔 ECONNRESET → `lib/domeatoz-api.mjs` 는 재시도 + 외부주문코드는 `/orderList` 전체를 받아 직접 비교. 같은 이유로 결제진행 중복 확인(`domeatozFindOrders`, 웹)도 서버 검색 대신 기간 내 전체를 읽어 비교하도록 변경. 송장 싱크 `--dry --only=domeatoz`·전체 `--dry` 정상(다른 매입처 영향 없음). 매시 :30 `Coupang-Ggsan-Sync` 작업이 14:30 회차부터 도매아토즈 포함. 실제 송장 매핑(택배사 이름 표기)은 첫 발송 때 확인 필요.

- 2026-10-28 18:55: 시세 대조 재개(08:09) — 사장님 "1분에 하나가 아니라 3분에 하나로" → `domeatoz-market.mjs` 검색 간격 하한 180초, 차단 휴식 60분. 3분 간격에서도 약 18검색마다 차단 휴식(09:31~18:53 70/804건, OK 7 · STRUCTURAL 41 · NO_MATCH 14). 드립 재개로 8건 추가(86건 판매중). 스틱·티백 "50T"처럼 개수만 있는 이름 = 사장님 "수량 50개처럼 개수로" → `purchaseSpecOf` mode 'count'(구매옵션 수량만), 커피믹스·차처럼 최소 중량 필수 카테고리는 같은 브랜드·같은 개수 쿠팡 표기(market_top3) 2건 이상이 ±5% 로 맞는 낱개 중량을 따름(사장님 선택, 판매자 오기는 혼자라 빠짐) — 카페믹스 50T "11g · 50개입 · 1개", 생강차플러스 30T 는 같은 브랜드 표기 없어 제외 유지.
- 2026-10-28 22:18: 19:08 PC 재부팅으로 시세 대조(79/804)·드립(#62, 오늘 9건) 함께 정지 → 재시작. 사장님 "sonnet 으로" → 드립을 `SEARCH_TAGS_MODEL=sonnet` 환경변수로 띄움(검색어 선별 Claude 호출만 해당, 시세 대조는 Claude 미사용). 시세 대조 `--cooldown=60 --max-cooldowns=20` 미조회 733건(로그 `_workspace/domeatoz-market-run-h.log`), 드립 `register-drip.sh domeatoz 10 10 200 30`(콘솔 `domeatoz-drip-console-d.log`). 재부팅 후 다시 띄울 때도 같은 환경변수.
- 2026-10-30 17:22: 사장님 "시세조회하지말고 등록해 — 시세조회 때문에 계속 등록이 안 되는 게 더 안 좋아". 시세 대조는 3분 1검색·차단 휴식으로 이틀에 약 380건(OK 비율 ~10%)이라 드립이 "후보 0"으로 공회전(10/30 market-run-i 는 11:08 15/606 에서 무로그 정지). → `domeatoz-register.mjs --no-market`(`decideNoMarket`: 시세 OK 는 시세가 그대로·먼저, 미조회·NO_MATCH·STRUCTURAL 은 목표가 = 순마진 10%) 신설, 시세 대조는 다시 띄우지 않음. 후보 101(OK) → 1,035. 드립 `REGISTER_FLAGS=--no-market SEARCH_TAGS_MODEL=sonnet register-drip.sh domeatoz 20 10 300 6`. 주의: STRUCTURAL 은 쿠팡 시세보다 비싸게 올라가 판매가 어렵다(목표가 유지 — 캠핑문 `--allow-structural` 과 같은 선택). 개수만 있는 이름 + 최소 중량 필수 카테고리(커피믹스·차)는 시세 표기(market_top3)가 없으면 구매옵션 실패 → 자동 제외(register_excluded) 된다. 같은 날 sonnet 응답이 JSON 뒤에 설명을 붙여 검색어 파싱이 깨지던 것 수정(`lib/search-tags.mjs firstJsonObject`).
- 2026-10-31 11:31: 10/30 드립이 140건 등록 후 #8부터 후보 858 인데 0건 — 정렬 맨 앞 6건(스프라이트 제로·몬스터 망고 로코 등)의 대표 이미지가 공급사에서 404 로 지워졌는데 일시 장애로 세어 "연속 오류 6건 → 회차 중단"을 매 회차 반복, 20:02 무진전 종료. 같은 날 20:53 매시 작업 `JimScanner-Domeatoz-RegisterDrip`(`_workspace/sched/start-register-drip.ps1`, 10/30 09:53 생성)이 `--no-market` 없이 다시 띄워 후보 0 으로 밤새 공회전. 수정: 대표 이미지는 thumb_url → images 순으로 최대 5장 시도, 404·410 만 다음 이미지로 넘기고 전부 지워졌으면 "대표 이미지 없음" 결정적 실패(자동 제외), 망 오류·5xx 는 계속 일시 장애로 센다. 기동기에 `REGISTER_FLAGS=--no-market` + `20 10 300 6` 반영 후 재기동 → #1 등록 20(이미지 404 6건 제외). 이 시점 쿠팡 리스팅 243(승인 236) · 남은 후보 약 832.
- 2026-11-01 15:34: 사장님 "구매옵션 247건 중량 채워서 등록 진행해" → 구매옵션 사유 자동 제외 248건(개수만 있는 이름 "100T"인데 최소 중량 필수 143 · "+"·"각N개" 세트 97 · "355mlx48캔" x 붙은 단위 7 · 구성품 1). ① `lib/domeatoz-spec.mjs` 단위 뒤 x 허용 ② `scripts/domeatoz-spec-from-images.mjs` 신설 — 상세 이미지(esmplus CDN, 860x400 표시사항)를 Claude CLI(sonnet, Read)가 8건씩 읽어 낱개 중량·총 낱개 수를 `scripts/lib/domeatoz-unit-spec.json` 에 쌓는다. 지어낸 값 방지: 낱개 값이 이미지 글자에 있거나(kg·L 환산 포함) 이름의 총수 × 낱개가 이미지 총량과 맞아야 하고, 총수는 이름과 대조, 이름에 총수가 없는 세트는 이미지 총량·"낱개 × 수" 칸 합·이름 구성품 수 중 하나와 맞아야. 자기 이미지에 낱개가 없으면("50T"뿐) 같은 상품 줄(개수만 다른 변형)이 이미지로 확인받은 값을 빌린다(`checked: sibling:<idx>`). 판정 규칙을 고친 뒤엔 `--revalidate`(Claude 재호출 없음). ③ 등록기는 이름으로 규격을 못 만들거나 개수만 있는데 중량 필수면 이 파일을 쓰고(같은 개수일 때), 없으면 기존 쿠팡 같은 브랜드 표기 중량. `--dry --only` 는 제외 상품도 미리 본다. 결과: 248 중 **216 해제**(dry 통과 — 최소 중량 12g·개당 1200개입 등), 남은 제외 32 = 세트 구성품 낱개가 서로 다름 23(대추차 15T+마차 15T 등, 쿠팡 구매옵션은 낱개 하나) · 이미지에도 낱개 없음 5(맥스웰 마일드·꽃샘 생강차플러스) · 대표 이미지 404 4. 모카골드 선물세트 2건은 커피세트(58852, 구성품 필수) 대신 일반커피믹스(58845)로 고정. 드립 재기동 → 후보 216.
- 2026-11-01: 사장님 "결제할 때마다 결제하고 남은 적립금 같이 표시" → 주문 화면 결제 행에 "🎟 적립금 N원 결제 · 남은 적립금 M원"(`orders/depositNote.ts` prepaid 파싱 + `DepositInfo`). 결제 후 사이트에서 다시 읽은 잔액은 메모에 '약' 없이 기록(`depositBalanceExact`), 다시 못 읽어 계산한 값만 '약'. 이전 결제분 메모는 '약'이 붙은 채로 표시된다.
- 2026-11-06: **다른 공급사 상품 등록 시작**. 전체 공급사(464곳) 표본 1,138개를 쿠팡 파트너스(브로커 경유, 30초 1건)로 비교 완료 → 같은 상품 쿠팡 최저가 ≥ 우리 목표가(순마진 10%)인 "가능" 107. 사장님 "1차로 거른 상품도 등록", "옵션이 많은 상품은 제외해".
  ① `scripts/domeatoz-adopt.mjs --idx=… [--cat=idx:코드]` — 고른 상품만 OPEN API `/productInfo` 로 받아 같은 표에 upsert(공급사 전체 수집 안 함, 공급사 하나가 3천~9천 개). 받지 않음: 판매중 아님·해외·의료/건기식·성인·MSP(판매가 준수)·착불/화물·KC 의심(전기·배터리·조명)·어린이제품·**판매 옵션 10개 초과**·옵션 전부 품절. 상세 이미지는 공급사 배송/교환 안내 배너·높이 10px 빈 줄을 빼고 https 로 열리는 것만(실측: 공급사 자체 배송·반품 정책 배너가 섞여 있음 — "당일배송"·추가배송비 문구).
  ② `domeatoz-register.mjs` 일반 상품 경로(식품 밖) — 고시 분류별(의류·가방·자동차용품·주방용품→기타 재화), 필수 속성 = 옵션 축(색상/사이즈)·상품명(수량 "10개", 길이 "80cm"), 옵션 1개 = item 1개 + `jimscanner_listing_items` 매핑. 실제 배송비는 상품마다 다름(반팔티 5,000).
  ③ 재고 싱크: 공급사별 대상 30건 미만이면 `/productInfo` 상품별(삭제 = "해당 상품을 찾을수 없습니다" → 품절), 30건 이상(삼일유통)은 종전 목록 훑기. ⚠ 옵션 일부 품절은 아직 item 단위로 안 내림.
  ④ 결제진행은 옵션 상품이면 "직접 주문하세요"로 멈춤(종전 가드). 첫 6건(USB 가이드·핸들커버·스텐 뜰채·비누 케이스·패딩조끼 6옵션·크로스백 5옵션) 받음, 반팔티 3종(옵션 44)·BOSCH 배터리·탁구로봇(KC) 제외.
  ⑤ 삼일유통 수집기 매일 06:20 예약(`JimScanner-Domeatoz-Collect` → `_workspace/sched/run-domeatoz-collect.ps1`, 10/27 이후 멈춰 있던 것 — 수집 직후 새 후보 39건). ps1 함정: 5.1 `*>` = UTF-16 로그 → cmd 리다이렉트, 공백 경로는 8.3(`C:\PROGRA~1\nodejs\node.exe`), 작업 스케줄러는 System32 에서 시작하므로 cmd 안에서 `cd /d` 필수(없으면 결과 1·로그 미갱신).
  ⑥ 나머지 "가능" 101 → adopt 건너뜀 32(KC 의심 13·옵션 >10 8·MSP 7·어린이 3·의료 1). **도매아토즈 cupangCode 는 69 중 49가 쿠팡 예측과 다름** — 다용도본드(일회용 신발커버)·KF-AD 마스크(면 마스크, 의약외품 카테고리)·액정보호필름(자동차 PPF)·방음재(카매트)처럼 명백히 틀린 것이 많아, 받기 전에 쿠팡 `categorization/predict` 와 대조해 38건은 예측으로 `--cat` 지정, 9건은 도매아토즈 값 유지(남녀공용 썬캡·가발 전체 등 더 맞는 쪽), 스마트워치 메탈밴드는 둘 다 틀려 111815 '스트랩'. 주문 제작 뱃지·DIY 시계 키트는 제외. **adopt 전에 카테고리 대조를 거칠 것.**