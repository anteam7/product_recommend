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
| 판매사 OPEN API | 상품·상태·주문·CS 존재하나 **고객센터 승인 필요**("사용승인 안된 회원 입니다") → 승인 전에는 웹 수집 |
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
| **P3 결제진행** | `order-server.mjs` `RUN_FLOWS.domeatoz` — 적립금 결제(DEPOSIT_PAY_SOURCES, 결제금액 가드), `PurchaseButton` | 적립금 충전 후 첫 주문 `full=false` 확인 |
| **P4 싱크** | `local-cron-ggsan-sync.mjs TRACKERS` 1줄(주문배송조회 송장), `local-cron-stock-sync.mjs SUPPLIERS` 1줄(목록 `ProductState` 로 품절/재입고) | 첫 송장 자동 반영 |
| P5 | 토스(`toss-register-batch.mjs SOURCES`), OPEN API 승인 시 수집·주문 API 전환 | 이후 |

등록표 한 줄씩([[feedback_supplier_registry_pattern]]): `purchase-catalog/sources.ts SOURCE_META` · `register-agent.mjs SOURCE_SCRIPTS` · `api/admin/register-jobs SUPPORTED_SOURCES` · `orders/model.ts SUPPLIER_LABELS/PURCHASE_AUTOMATED_SOURCES/supplierUrl` · `lib/search-tags.mjs kindOf` · `agent/snapshot.mjs`·`fixtures.mjs` · purchase_catalog 뷰 UNION ALL.

---

## 5. 사장님 확인/할 일
1. **적립금 충전**(10만원~, 첫 주문 전) — 결제진행은 적립금 잔액에서만 결제.
2. **판매사 OPEN API 사용 승인** 고객센터 요청(승인되면 수집·주문을 API 로 전환).
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
