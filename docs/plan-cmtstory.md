# 화장품스토리(cmtstory.com) 위탁 화장품 → 쿠팡 등록 · 재고/품절 연동 계획

작성 2026-10-07 · 근거: 건강산 계정 로그인 실측 정찰(읽기 전용 — 장바구니·주문·게시글 없음) · 상태: **계획 승인(2026-10-07) → P0 구현 중**
사용자 결정(2026-10-07): ① cmtstory 로그인·사업자승인 **확인됨(구매 가능)** ② 절대준수 문구 없는 상품은 **정가 하한 없이 순마진 10% 가격으로** 판매가 결정
자격증명: **건강산(ggsan)과 같은 계정**(`GGSAN_USER`/`GGSAN_PASS`)으로 로그인됨 — 별도 키 불필요. 비번은 문서·메모리에 기록 금지.
정찰 스크립트: `scripts/_cmt-probe-login.mjs`(로그인·상세 필드) · `scripts/_cmt-probe-sweep.mjs`(카테고리 규모·상세 표본·공지) — 모두 읽기 전용.
기준 문서: `docs/plan-kwholesale.md`(가장 최근 매입처 온보딩 — 구조·동기화 지점을 그대로 따른다)

---

## 0. 한눈에

| 항목 | 내용 |
|---|---|
| 운영사 | **주식회사 건강산**(ggsan.com 운영사)의 화장품 전용 서브몰. 사업자번호·CS(070-7588-1709)·세금계산서 명의 모두 건강산과 동일 |
| 플랫폼 | **고도몰5(GodoMall5)** — 건강산과 완전히 같은 구조(`/goods/goods_list.php?cateCd=` · `/goods/goods_view.php?goodsNo=` · `/member/login_ps.php`) → **건강산용 로그인·품절판정·MSP 파서·주문추적·결제진행 코드를 base URL만 바꿔 재사용** |
| 계정 | 건강산 계정으로 로그인 성공, 등급 **일반회원**(추가할인 0%), 예치금 0원. 가격·절대준수가 전부 노출. **구매 가능 여부(사업자승인)는 미확인**(§7-1) |
| 규모 | 국내 판매 카테고리 8개(001~008) 합계 **244건(카테고리 중복 포함)** — 토너/세럼 53 · 마스크/팩 55 · 바디/헤어 48 · 크림 48 · 선케어 20 · 클렌징 14 · 홈/프래그런스 5 · 맨즈 1. 제외: 오프라인전용(009) 5 · 사은품(010) 10 · 임박특가(011) 7 · **수출전용(014) 605** |
| 가격 | 상세 hidden `set_goods_price`(도매가, VAT 포함) · `set_goods_fixedPrice`(정가=권장판매가). 표본: 도매 10,000 / 정가 30,000 / 절대준수 1개 20,000 |
| **판매가 규칙** | 상세 상단 **"판매가격절대준수 1개 N원 / 2개 N원 / 3개 N원 이상 판매"** 문구 = 하한(건강산과 같은 형식 → `ggsan-prep-goods.mjs` tiered_msp 파서 그대로). 문구 없으면 "화장품스토리가 제시하는 판매가 이상 자율가"(FAQ) → **정가를 하한으로 보수 적용**(§2). 위반 = 구매 제한·탈퇴 |
| 마진(표본 4건, MSP 판매 시) | 세럼 10,000→20,000 · 바디로션 6,200→9,300 · 크림 10,000→15,000 · 클렌징티슈 1,800→2,900. 하한이 도매가의 1.5~2배라 **대부분 MSP에서 10% 순마진 충족**, 저가(3천원 미만) 상품만 마진 공식가가 MSP를 넘는다 |
| 결제 | **예치금**(입금 후 1:1 게시판에 입금자명·금액 → 충전). 무통장·카드도 이용안내에 있으나 공지는 예치금이 기본. 다건 합산 입금 가능 |
| 출고 | 평일 **오전 11시까지 입금된 주문 당일 출고**(금 11시 이후 → 월요일). 택배 **CJ대한통운·한진** 주력(+로젠·롯데·우체국). 출고지·반품지: 인천 송도테크노파크IT센터 S동 1001호 |
| 배송비 | 기본 **3,000원(박스비 포함)**, 1출고지 **20만원 이상 무료**, 제주·도서산간 +6,000(도선료 1만↑). 모든 상품 묶음배송 가능, 부피 큰 상품은 자체 배송비 |
| 반품 | 불량·오배송만 수령 7일 이내 교환/반품. **소비자 단순변심 반품은 건강산 불가**(셀러 부담, 착불 재발송) → 반품지는 내 주소 유지 |
| 세금계산서 | 매월 1~5일 1:1 게시판 신청(최초 1회), 5~10일 발행, 공급자 **주식회사 건강산**(건강산 거래와 합산될 가능성 → 회계 확인) |
| 이미지 | 인증 거래처는 썸네일·상세 무료 사용, **변형·수정 불가**(사이즈 조절만 가능). 이미지 쓰면서 타업체 구매 시 회원자격 상실 |
| 핵심 리스크 | 건강산 계열 리셀러가 같은 이미지·같은 하한가로 쿠팡에 깔려 있을 가능성(아이템위너 경쟁) → 등록 전 쿠팡 시세·판매자 수 확인 |

**권장 순서:** P0 수집(dry → 저장) → **P0.5 쿠팡 시장성 확인** → P1 소량 등록(5개) → 재고/품절 연동 켜기 → 확대 → (이번 범위 밖) P2 결제진행 · P3 송장

---

## 1. 사이트 정찰 결과 (2026-10-07)

### 1.1 플랫폼·세션
- 쿠키 `GD5SESSID`, 마크업 `godomall` 555회 — 고도몰5. 로그인 `POST /member/login_ps.php {loginId, loginPwd, saveId, returnUrl}` → 성공 시 `parent.location.href='https://www.cmtstory.com/main/index.php'` 스크립트(건강산과 동일, 호스트만 다름).
- 비로그인: 리스트 가격이 "회원전용", 상세는 가격 없음. 로그인 후 전부 노출.
- 마이페이지: 일반회원등급 · 쿠폰 0 · 마일리지 0 · 예치금 0. 진행 중 주문 0.

### 1.2 리스트(`goods_list.php?cateCd=NNN&page=N`)
- 20개/페이지, "총 N 개" 텍스트로 전체 수. 품절 아이콘(`soldout` 이미지/`alt="품절"`)이 리스트에 있음 — 수집기 품절 플래그 1차 소스.
- `cateCd` 3자리 상위 + 하위(예 `014004001`). 국내 판매분은 001~008만 수집하고 009/010/011/014는 **URL 파라미터 단계에서 제외**(014 수출전용 605건이 섞이면 카탈로그가 오염된다).

### 1.3 상세(`goods_view.php?goodsNo=`) — 수집 필드
| 필드 | 소스 | 비고 |
|---|---|---|
| 상품명 | `og:title` | 예 "텐제로 다크 이레이저 롤러 아이 세럼 30ml" — 용량이 이름에 들어 있어 구매옵션 파싱 가능 |
| 도매가 | `input[name=set_goods_price]` | VAT 포함(FAQ) |
| 정가(권장판매가) | `input[name=set_goods_fixedPrice]` | 30000.00 형식 |
| 옵션 유무 | `input[name=optionFl]` (y/n) | 표본 4건 전부 n. `optionSno` select 는 템플릿에 상존하므로 optionFl 만 믿는다 |
| 카테고리 | `input[name=cateCd]` | 대표 카테고리 1개 |
| 재고 | `set_goods_stock=∞` | 수치 없음 → **품절은 `btn_restock_box|btn_add_soldout` 마커로만**(`supplier-stock.mjs mallCheckStock` 그대로) |
| 절대준수가 | 상세 텍스트 "판매가격절대준수 1개 20,000원 / 2개 38,000원 / 3개 54,000원 이상 판매 부탁드립니다." 또는 "2,900원 이상 판매 부탁드립니다." | `ggsan-prep-goods.mjs extractSalesRule` 정규식이 그대로 맞음(tiered 1~4개 확인) |
| 사용기한 | "상품필수 정보 › 사용기한 2029-03-12" | 일부 상품 없음(클렌징티슈) |
| 제조사 | "제조사 (주)이든팜" | 브랜드 코드 `brandCd` 는 빈값 → 쿠팡 brand 생략 |
| 배송 | "기본배송료 3,000원 · 200,000원 이상 0원 · 지역별추가배송비" | 전 상품 공통 |
| 이미지 | 대표/추가: `godomall.speedycdn.net/.../goods/{goodsNo}/(big|magnify)/…` · 상세: `cdn-pro-web-211-225.cdn-nhncommerce.com/.../editor/goods/…` | ⚠ 건강산 파서는 호스트 `godomall-storage.cdn-nhncommerce.com` 고정 → **호스트 무관, 경로(`/goods/{no}/`, `/editor/goods/`)로 판별**하도록 일반화 필요 |
| 화장품 고시 | **상세 텍스트에 없음**(전성분·책임판매업자·제조국 미노출) | 상세 이미지에 있다고 가정 → 쿠팡 고시는 '상세설명 참조' 중심(§4.2) |

### 1.4 거래 규정 (공지 sno=1 "필독! 사업자 승인 및 도매거래 안내" + FAQ 전문)
- **회원인증(사업자등록증 → 사업자승인요청 게시판/이메일) 후 구매 가능.** 오후 4시 일괄 승인. 승인 후 장기 미구매 시 로그인 제한 가능.
- 주문서 **주문자 정보는 회원(대표) 정보 그대로**, 배송정보에만 고객 정보(건강산 결제진행 흐름과 동일한 규칙).
- 주문 후 품절 발생 시 해당 금액 예치금 처리. 미출고 품목은 당일 15시/20시 이후 주문조회·이메일로 확인.
- 교환은 선출고·맞교환 불가 → 새 주문+입금 후 발송, 회수 후 환불.

---

## 2. 판매가 규칙 — 사용자 요구: "매입처 하한 준수 + 내 순마진 10% 이상"

```
MSP(N)     = 절대준수 문구 tiered[N]                       (문구 1개만 있으면 tiered[1]=그 값, N≥2 는 tiered[1]×N)
             문구 없음 → 0 (하한 없음, 순마진가가 곧 판매가)   ← 사용자 결정 2026-10-07 (정가는 참고값으로만 저장)
원가(N)    = 도매가 × N + 배송비(3,000; 도매가 합 ≥ 200,000 이면 0)
순마진가   = ceil( 0.9091 × 원가 / (1 − fee − 0.0909 − 0.10) / 100 ) × 100     // 웰루트·K홀세일 공식, fee 는 쿠팡 카테고리 수수료
판매가(N)  = max( MSP(N), 순마진가(N) )  → 100원 올림
originalPrice = 판매가 (K홀세일과 같은 이유 — 허위할인 소지 차단)
```
- **수수료는 영양제 10.6% 고정이 아니라 화장품 9.6%**(`scripts/lib/coupang-commission.mjs commissionRate` — 스킨·세럼·크림·클렌징·마스크팩·선크림·샴푸·바디워시 등 매칭) → 등록기 `FEE_RATE` 상수 대신 카테고리별 수수료를 쓴다. 매칭 안 되면 10.6%(보수).
- 표본 계산(9.6%): 세럼 원가 13,000 → 순마진가 16,700 < MSP 20,000 → **20,000**. 클렌징티슈 원가 4,800 → 순마진가 6,200 > MSP 2,900 → **6,200**(단품은 배송비 때문에 비싸짐 → 2·3개 묶음이 유리).
- 가격 자동화는 **인상만**: 도매가·절대준수가 변동 감지 시 판매가 상향(유픽 price-sync 패턴), 하향·쿠폰·즉시할인 금지([[price_msp_floor_policy]]). `/admin/pricewatch` 리프라이스도 MSP 하한 적용.

---

## 3. P0 — 상품정보 수집

### 3.1 테이블 `jimscanner_cmtstory_products` (PK `goods_no`) — `supabase/cmtstory_products.sql`
`title` · `title_clean` · `cate_cd`(대표) · `cate_cds text[]`(소속 전부) · `wholesale_price_krw` · `fixed_price_krw`(정가) · `has_msp_text` · `msp_price_krw`(1개 하한) · `tiered_msp jsonb` · `msp_basis`('text'|'fixed') · `sale_prices jsonb`({1,2,3} §2 결과) · `sale_price_basis` · `shipping_fee_krw`(3000) · `free_ship_threshold_krw`(200000) · `has_option` · `soldout` · `status`(active|soldout|gone) · `manufacturer` · `expiry_date` · `expiry_short`(180일 미만) · `thumb_url` · `images_main jsonb` · `images_content jsonb` · `detail_url` · `coupang_category_code`(예측 캐시) · `coupang_fee_rate` · `register_excluded`/`register_excluded_reason` · `needs_review` · `first_seen_at`/`last_seen_at`/`last_changed_at` · `raw jsonb`
- **생성컬럼 `coupang_eligible`** = status='active' ∧ ¬soldout ∧ ¬has_option ∧ wholesale>0 ∧ msp>0 ∧ ¬expiry_short ∧ ¬register_excluded (웰루트·K홀세일과 같은 패턴 — 등록기는 이 컬럼만 본다). 옵션 상품은 1차 제외(옵션조합 미구현, 표본엔 없음).
- 건강산 `jimscanner_ggsan_products` 에 섞지 않는다 — 그 테이블은 트렌드 레이더·추천 RPC와 결합돼 있고 goods_no 가 두 몰에서 겹칠 수 있다(둘 다 1000000xxx 대역).

### 3.2 공통 라이브러리 `scripts/lib/godomall-catalog.mjs` (신규)
- `createGodomallSession({ base, user, pass })` — fetch+쿠키 로그인(`supplier-stock.mjs mallLogin` 과 동일, 성공 판정은 `main/index.php` 리다이렉트 **호스트 무관**).
- `listCategory(session, base, cateCd)` — 전 페이지 순회 → `{goodsNo, soldout}` (리스트 품절 아이콘).
- `parseGoodsView(html, { base })` — `ggsan-prep-goods.mjs` 의 `extractDetail` + `extractSalesRule` 이식: hidden 가격·optionFl·cateCd·og:title·제조사·사용기한·절대준수 tiered·이미지(경로 기준, CDN 호스트 무관).
- 건강산 스크립트는 이번에 건드리지 않는다(등록 흐름이 다르고 회귀 위험). 파서가 안정되면 `ggsan-prep-goods.mjs` 가 이 모듈을 쓰도록 후속 정리.

### 3.3 `scripts/cmtstory-collect.mjs [--dry] [--only=] [--limit=] [--cats=001,...]`
1. 로그인(건강산 자격증명, base=`https://www.cmtstory.com`).
2. 카테고리 001~008 전 페이지 → 고유 goodsNo + 품절 + 소속 카테고리(합집합).
3. 상세 파싱 → §2 로 `msp/tiered/sale_prices` 계산 → `coupang-commission.commissionRate(title)` 로 수수료.
4. upsert(변경분만 `last_changed_at`), 리스트에서 사라진 상품 `status='gone'`(판매중이면 재고 0 처리는 §5 크론이 담당).
5. dry 리포트: 총/품절/옵션/문구없음/임박/후보 수, 마진 분포(중앙·P25·3천원 미만), 하한 근거(text/fixed) 비율.
- 예상: 244(중복) → 고유 200 내외 → 품절·옵션·임박 제외 후 **후보 150~180**(P0 실행 후 확정).

### 3.4 갱신 (`scripts/run-crons.mjs` 일 1회 통합)
- 가격(도매가·절대준수가·정가)·품절·신규·단종·사용기한 재수집 → **도매가/하한 인상 시 쿠팡 판매가 자동 상향**(유픽 `lib/upick-price-sync.mjs` 패턴을 cmtstory 분기로), 하향은 리포트만.
- 공지 감시: 공지 목록 제목에 휴무·품절·단종·가격 키워드 → 운영일지(`execution-log`) 기록.

---

## 4. P1 — 쿠팡 등록

### 4.1 사전 준비 (사용자)
1. **cmtstory 구매 가능 여부 확인** — 계정이 건강산에서 승인됐어도 서브몰 승인은 별개일 수 있다. 장바구니→주문서 진입 또는 1:1 문의로 확인(미승인이면 사업자등록증을 사업자승인요청 게시판에 제출).
2. **쿠팡 시장성 확인(P0.5)** — 후보별 쿠팡 검색: 판매자 수·아이템위너가·리뷰 수(디버그 크롬 CDP, [[price_lookup_via_cdp]]). 같은 이미지·같은 하한가 리셀러가 있으면 위너 불가 → 경쟁 적은 상품·묶음부터.
3. 세금계산서: 건강산 명의로 합산 발행될 수 있음 → 회계 처리 방식 확인.

### 4.2 `scripts/cmtstory-register.mjs` (`kwholesale-register.mjs` 복제 — 공통 모듈 유지)
| 항목 | 설계 |
|---|---|
| 대상 | `coupang_eligible=true` (+ `--only=`). **첫 배치 5개**, 20개 초과는 사용자 확인 |
| 판매가 | 수집기 `sale_prices[N]` 그대로, MSP 미만이면 등록 중단(안전장치). `originalPrice=판매가` |
| 변형 | 수량 축 1·2·3개 — tiered 구간이 있는 수량만(웰루트 `variantQtys`). 쿠팡 화장품 카테고리가 단품 허용이면 `--bundle=1` 도 가능 |
| 카테고리 | `categorization/predict` → `coupang_category_code` 캐시. 필수 구매옵션 카테고리면 변형 2개 이상으로 충족 |
| 구매옵션 | `lib/coupang-purchase-options.mjs parseSpec(title)` — "30ml"·"100g"·"30매" → 개당 용량/중량/수량. **화장품 카테고리 속성명(용량·개당 용량)이 식품과 다를 수 있어 첫 dry 에서 `buildPurchaseOptions` 결과 검증 필수**(틀리면 "30ml 1개에 54,000원"처럼 노출) |
| 고시 | 카테고리 메타의 **'화장품'** 고시 11항목: 용량(이름 파싱) · 제품 주요 사양('상세설명 참조') · 사용기한(수집값, 없으면 '상세설명 참조') · 사용방법('상세설명 참조') · 제조업자/책임판매업자(수집 `manufacturer`) · 제조국('상세설명 참조') · 전성분('상세설명 참조') · 기능성 심사필('상세설명 참조') · 주의사항('상세설명 참조') · 품질보증기준('관련 법령 및 소비자분쟁해결기준에 따름') · 소비자상담 전화(`COMPANY_CONTACT`). 상세 이미지에 고시 내용이 실제로 있는지 **표본 확인** |
| 상품명 | `coupang-name-audit` 규칙 + **화장품 기능성 표현(미백·주름개선·자외선차단 등)은 식약처 심사 여부를 모르면 차단**([[name_creation_rules]]). 공급사 안내문 혼입 제거([[supplier_note_contamination]]) |
| 이미지 | 대표 1 + 추가 + `/editor/goods/` 상세. 500~5000px 규격 미달분은 **패딩만**([[coupang_image_spec]]) — 공급사 규정상 변형·수정 불가이므로 AI 썸네일 재생성·오버레이 금지 |
| 브랜드 | `brandCd` 빈값 → 생략([[coupang_register_gotchas]]) |
| 배송 | `deliveryCompanyCode='CJGLS'`(건강산 등록기와 동일) · FREE · `outboundShippingTimeDay=2` · 출고지 `24724717` · 반품지 `1002609354`(기존 그대로 — 소비자 변심 반품은 건강산이 안 받으므로 내 주소가 맞다) |
| 고지 블록 | 상세 끝 TEXT: "[개인정보 처리 위탁 안내] 이 상품은 (주)건강산(화장품스토리)에서 직접 발송… 수령인 정보가 (주)건강산 및 택배사에 제공…" |
| 기록 | `jimscanner_coupang_listings.source='cmtstory'`, `source_goods_no=goods_no`, `dome_price_krw=도매가`, `msp_price_krw`, `source_shipping_fee_krw=3000` — **listings source CHECK 제약에 `cmtstory` 추가 DDL 선행**(`supabase/cmtstory_register.sql`, `kwholesale_register.sql` 패턴) |

### 4.3 매입처 추가 동기화 지점 (누락 시 조용히 빠짐 — K홀세일 §4.4 와 같은 목록, `kwholesale` 가 있는 파일 기준)
1. `supabase/purchase_catalog.sql` 뷰 UNION ALL 추가 + `src/app/admin/(dashboard)/purchase-catalog/sources.ts` 라벨·URL
2. `scripts/register-agent.mjs SOURCE_SCRIPTS` · `src/app/api/admin/register-jobs/route.ts SUPPORTED_SOURCES`
3. `src/app/admin/(dashboard)/coupang-orders/page.tsx` `SUPPLIER_LABELS` · `supplierUrl` (· `PURCHASE_AUTOMATED_SOURCES` 는 P2 때)
4. `scripts/local-cron-stock-sync.mjs SUPPLIERS` (§5)
5. listings source CHECK (4.2)
6. (P2) `scripts/order-server.mjs SUPPORTED_SOURCES·RUN_FLOWS` · (P3) `scripts/local-cron-ggsan-sync.mjs`

---

## 5. 재고 싱크 · 품절 연동 (사용자 요구 범위)

| 기능 | 방식 | 변경 지점 |
|---|---|---|
| 품절 감지 | 매시 `local-cron-stock-sync.mjs` — `SUPPLIERS.cmtstory = { kind:'mall', base:'https://www.cmtstory.com', user: GGSAN_USER, pass: GGSAN_PASS, label:'화장품스토리' }`. 상용몰 분기라 **`mallLogin`+`mallCheckStock`(goods_view 라이브, `btn_restock_box` 마커) 그대로** — 코드 추가 없이 맵 1줄 | `local-cron-stock-sync.mjs` |
| 품절 → 쿠팡 | 기존 흐름: vendor-item 재고 0 + `auto_paused` + `STOPPED` 기록 | 변경 없음 |
| 재입고 → 복구 | 기존 흐름: 재고 MIN_QTY(10) 복구 + `APPROVED` | 변경 없음 |
| 판매분 보충 | 기존 `ensureQuantity`(MIN_QTY 이하로 줄면 되채움) | 변경 없음 |
| 단종(gone) | 수집기가 리스트에서 사라진 상품을 `gone` → 다음 재고 크론에서 goods_view 가 unknown 이면 조치 없음 → **gone 상품은 수집기가 직접 재고 0 + `register_excluded`** (현재 상용몰 분기엔 gone 처리가 없어 추가) | `cmtstory-collect.mjs` |
| 가격 변동 | §3.4 인상 자동반영(쿠팡 vendor-item prices API, 강등 없음), 하향 리포트 | `cmtstory-collect.mjs` + `lib/upick-price-sync.mjs` 재사용 |
| 네이버 | 이번 범위 밖(쿠팡만) | — |

세션 주의: 건강산과 **같은 계정을 두 몰에 매시 로그인** — 각 몰 세션은 독립(도메인별 `GD5SESSID`)이라 충돌 없음. 다만 "승인 후 장기 미구매 시 로그인 제한" 규정이 있어 크론 로그인 실패를 `execution-log` 에 남겨 조기 발견.

---

## 6. 이후 단계 (이번 계획 범위 밖 — 등록 검증 후)

- **P2 결제진행**: `order-server.mjs runFlowGgsan` 이 `BASE` 상수(건강산 고정)를 쓰므로 `runFlowGodomall(base, …)` 로 base 주입 → cmtstory 는 예치금 결제(건강산 완주 모드와 같은 주문서) + 주문자 정보 미수정 규칙. 예치금 충전은 사람(입금 → 1:1 게시판).
- **P3 송장**: `local-cron-ggsan-sync.mjs ggsanLogin` 의 성공 정규식이 `www.ggsan.com` 하드코딩 → 호스트 무관으로 바꾸고 `createGgsanSession(env, { base })` 옵션 추가. 택배사 sno 맵(`8`=CJ, `5`=한진)에 로젠·롯데·우체국 실측 추가 필요(그 외는 needs_attention). 쿠팡 송장등록 `CARRIER_MAP` 은 CJ·한진 이미 있음.
- 반품 운영: 소비자 변심 반품 → 내 주소 수령 후 재판매(건강산 반입 불가). 불량만 7일 내 건강산 반품.

---

## 7. 리스크·미확인

1. **구매 권한**: 서브몰 사업자승인 미확인 — 등록 전에 반드시 확인(승인 없이 등록하면 첫 주문에서 발주 불가).
2. **문구 없는 상품의 하한**: FAQ "제시 판매가 이상 자율" 의 '제시 판매가'가 정가인지 별도 권장가인지 불명 → 정가 하한(보수) 적용, 1:1 확인 후 완화.
3. **화장품 구매옵션·고시**: 식품 등록기와 속성 축이 다름 — 첫 dry payload 검토 전 실등록 금지. 기능성 화장품 표현 규제.
4. **이미지 변형 금지** vs 쿠팡 규격(500px 미만 패딩): '사이즈 조절'로 해석, AI 재생성은 하지 않음.
5. **리셀러 경쟁**: 같은 이미지·같은 하한가 → 아이템위너 경쟁(K홀세일과 같은 구조). P0.5 시장성 확인으로 선별.
6. **계정 공유**: 건강산 크론·결제진행과 같은 자격증명 — 비번 변경 시 두 몰 동시 영향, 로그인 제한 시 두 몰 동시 정지.
7. 세금계산서 건강산 합산 발행 가능성, 도매가 VAT 포함(FAQ 명시 — 순마진 계산은 기존 공식 그대로).
8. 상세 텍스트에 전성분·책임판매업자 없음 → 상세 이미지 의존. 쿠팡 심사에서 고시 보강 요구 시 이미지 OCR 또는 수기 보강.

---

## 8. 사용자 결정·확인 필요

| # | 항목 | 권장 |
|---|---|---|
| 1 | cmtstory 구매 가능(사업자승인) 확인 | ✅ 사용자 확인 완료(2026-10-07) |
| 2 | 절대준수 문구 없는 상품의 하한 | ✅ 사용자 결정: 하한 없음, 순마진 10% 가격(2026-10-07) |
| 3 | 판매가 = max(MSP, 순마진 10%) · 수수료 화장품 9.6% | 예(사용자 요구 그대로) |
| 4 | 수집 범위 | 국내 카테고리 001~008만, 009/010/011/014 제외, 옵션 상품 1차 제외 |
| 5 | 변형 | tiered 구간에 맞춰 1·2·3개 (저가 상품은 묶음이 유리) |
| 6 | 출고지·반품지 | 기존(항동로·신사로) 유지 |
| 7 | 등록 전 쿠팡 시장성 확인(P0.5) | 예 — 후보 선별 |
| 8 | 사용기한 제외 기준 | 180일(웰루트·K홀세일과 동일) |
| 9 | 결제진행·송장(P2·P3) | 등록 검증 후 별도 진행 |

---

## 9. 단계·검증

| 단계 | 산출물 | 검증 |
|---|---|---|
| **P0** | `supabase/cmtstory_products.sql` + `scripts/lib/godomall-catalog.mjs` + `scripts/cmtstory-collect.mjs` | 전량 dry → 카테고리 합계 대비 누락 0 · 표본 10개 화면 대조(도매가·정가·절대준수 tiered·사용기한·제조사·이미지 수) · 재실행 멱등 · 마진 분포 리포트 |
| **P0.5** | 쿠팡 시세 스윕(판매자 수·위너가) | 후보별 경쟁도 표 → 사용자 선택 |
| **P1** | `supabase/cmtstory_register.sql`(listings CHECK) + `scripts/cmtstory-register.mjs` + 동기화 지점 §4.3 ①②③⑤ | `--dry` payload(구매옵션·고시·가격) 검토 → **5개 실등록** → 승인·노출가·단위가격 표기 확인 |
| **재고/품절** | `local-cron-stock-sync.mjs SUPPLIERS` 1줄 + 수집기 gone 처리 + run-crons 일일 갱신 | 재고맵 전건 매칭 · 수집기 품절 ↔ 크론 판정 일치 · 품절 1건 인위 확인(품절 상품 등록 → 재고 0 전환) |

실행 원칙: 실제 등록·가격 변경은 단계마다 사용자 "실행" 확인 후([[market-orchestrator]] 안전장치). 코드 변경 후 `npm run build`, 커밋은 사용자 확인(implementer cron 레포).

---

## 10. 구현 현황 (2026-10-07)

### P0 수집 — 완료 (DB 적용 · 실저장 · 멱등 확인)
- DDL `supabase/cmtstory_products.sql` 적용(apply-sql.mjs, 4 statements). `scripts/lib/godomall-catalog.mjs`(고도몰5 공용: 로그인 재사용 · 리스트 · 상세 · 절대준수가 파서, CDN 호스트 무관) + `scripts/cmtstory-collect.mjs`.
- 결과: 국내 8개 카테고리 **고유 244건**(리스트 표기 총수와 일치, 상세 실패 0) → 품절 58 · 사용기한 임박 11 제외 → **등록 후보 175**. 재실행 변경 0·동일 244(멱등).
- 파서 검증: 정찰 때 화면으로 본 4건(세럼·바디로션·크림·클렌징티슈)과 도매가·정가·수량별 절대준수가·사용기한·제조사 전부 일치.
- 절대준수 문구 173/175(수량별 29), 문구 없음 2. 제조사 169, 사용기한 134, 상세이미지 0장 1.
- **마진 실측(수수료 9.6%)** — 1개: 중앙 1,679원(10.4%), MSP 기준 60 / 마진가 기준 115, **3천원 미만 123/175**. 2개: 중앙 4,742원(14.3%), 3개: 중앙 7,741원(17.1%).
  도매가 중앙 8,500원이라 단품은 배송비 3,000원이 원가의 1/4 → 하한보다 마진가가 높은 상품이 많고 절대마진이 얇다. **2·3개 묶음이 주력**(배송비 1회 분산, 하한도 묶음 할인 폭보다 마진가가 높음).
- 수수료: `commissionRate` 가 '콜라겐'·'비타민' 성분명을 영양제(7.6%)로 오인 → 전 상품 뷰티 9.6% 고정(수집기에서 치환).

### 남은 것
1. P0.5 쿠팡 시장성 확인(후보 175 → 판매자 수·위너가) — 사용자 선택.
2. P1 `cmtstory-register.mjs`(kwholesale-register 복제, 화장품 고시·구매옵션) + listings source CHECK DDL + 카탈로그 뷰/큐/주문관리 동기화.
3. 재고/품절: `local-cron-stock-sync.mjs SUPPLIERS` 1줄은 첫 등록과 함께(등록 전엔 조회 대상 0).
4. 일일 갱신 크론(run-crons) 통합 + 가격 인상 자동반영.
