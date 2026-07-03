# 네이버 스마트스토어 운영 런북 (몸에조은가게)

> 매 작업 완료 시 하단 **작업 이력** 테이블을 업데이트한다.  
> 처음 보는 사람도 이 문서만 읽으면 바로 실행할 수 있도록 유지한다.

---

## 1. 상시 자동 크론 (로컬 Windows 작업 스케줄러)

| 스케줄러 태스크명 | 스크립트 | 주기 | 역할 |
|---|---|---|---|
| `Naver-Orders-Sync` | `scripts/local-cron-naver-orders-sync.mjs` | 매시간 07분 | 주문 수집 → `jimscanner_naver_orders` upsert |

### 주문 ↔ 매입 관리 메뉴 (`/admin/naver-orders`, 2026-07-03)
쿠팡 `/admin/coupang-orders` 미러. 흐름: 주문 자동수집 → 매입상태 **발주완료** 선택 시 **네이버 발주확인 자동 호출**(`POST /v1/pay-order/seller/product-orders/confirm`) → 💳 결제진행(order-server가 쿠팡/네이버 id 자동판별, 유픽·ggsan 주문서 자동작성) → 매입처 주문번호·송장 기록(내부).
- 발주확인 전 건은 네이버 상태 칸에 **⚠ 발주확인 필요** 배지 (PAYED + placeOrderStatus≠OK)
- **Vercel IP 함정**: 프로덕션 어드민의 발주확인은 Vercel IP라 GW.IP_NOT_ALLOWED → 브라우저가 로컬 order-server `POST /naver-confirm?id=`(집 PC = 허용 IP)로 자동 폴백. 이 PC에서 어드민을 열어야 발주확인 가능
- 실수익 = 결제금액 − 매입원가 − **실수수료**(commission_amount) − 부가세(÷11)
- 네이버 **발송처리 API는 미연동** — 송장은 내부 기록만, 발송처리는 스마트스토어센터에서 (후속 예정)
- API 라우트: `/api/admin/naver-orders/update` (매입 필드 수정 + ORDERED 전환 시 발주확인 best-effort)

### 주문 동기화 특이사항
- **엔드포인트**: `GET /v1/pay-order/seller/product-orders?from=...&to=...`
- **날짜 포맷**: UTC ISO 8601 (`new Date().toISOString()`) — KST/+09:00 포맷은 400 오류
- **창 크기**: 최대 24h. 크론은 2h 슬라이딩 창 사용
- **백필**: `node --env-file=.env.local scripts/local-cron-naver-orders-sync.mjs --backfill` (31일 × 24h 창)
- **API 권한**: "주문 판매자" 그룹 (pay-order/seller/* 경로) — seller-channel-orders 경로는 다른 권한 그룹이라 404
- **Rate limit**: 429 발생 시 창 간 600ms sleep (백필), 일반 300ms
- **응답 구조 (중첩!)**: `contents[]` = `{ productOrderId, content: { order, productOrder, delivery? } }` — 플랫 필드 아님.
  주문자/결제일은 `content.order`, 상품명/상태/금액/배송지는 `content.productOrder`(주소 상세는 `detailedAddress`), 송장은 `content.delivery`.
  `channel_product_no`=`productOrder.productId`, `origin_product_no`=`productOrder.originalProductId`(리스팅 테이블 매칭 키).
  수수료 = paymentCommission+saleCommission+channelCommission+knowledgeShoppingSellingInterlockCommission (정산예정액 = 결제액 − 이 합)

### 트러블슈팅: `GW.IP_NOT_ALLOWED` (토큰 발급 403)
- **증상**: sync_runs가 매시간 `error`(수집 0건, ~300ms 즉시 실패), `error_message`에 `네이버 토큰 실패 HTTP 403 ... GW.IP_NOT_ALLOWED`
- **원인**: 공인 IP 변경 → 커머스API센터 애플리케이션의 허용 IP 목록에서 벗어남 (쿠팡 Wing IP 접근제어와 동일 패턴)
- **조치**: 현재 공인 IP 확인(`curl https://api.ipify.org`) → [커머스API센터](https://apicenter.commerce.naver.com) > 애플리케이션 관리 > 해당 앱 수정 > 서비스 서버 IP에 추가/교체
- **이력**: 2026-07-02 03시 이후 IP 변경으로 43회 연속 실패 → 2026-07-03 발견, error_message 기록 로직 추가

---

## 2. SEO 적합도 작업 (1회성 → 재실행 가능)

### 2-1. 태그 보강
```bash
node --env-file=.env.local scripts/naver-update-tags.mjs [--limit=N] [--apply]
```
- 금지어 자동 필터 + 재시도 내장
- 결과: 태그 3~10개 성분·효능 태그 보강
- **완료**: 352/352건 (2026-06-13)

### 2-2. 표준카테고리 재배정
```bash
node --env-file=.env.local scripts/naver-recategorize.mjs [--dry]
```
- CAT_RULES 패턴 기반 leafCategoryId PUT
- **완료**: 96건 (2026-06-13)

### 2-3. 상품명 키워드 최적화
```bash
# 1단계: 분석 (저장: .tmp/naver-name-proposals.json)
node --env-file=.env.local scripts/naver-keyword-optimize.mjs [--limit=N]

# 2단계: 필터 (BAD_KW 자동 제거 → improvement:false 처리)
node --env-file=.env.local scripts/_filter-proposals.mjs

# 3단계: 적용
node --env-file=.env.local scripts/naver-keyword-optimize.mjs --apply --from-file
```
- `shopTotal()`: 네이버 쇼핑 검색량으로 수요 프록시
- **주의**: Full PUT → TEMPORARY_SAVE 강등 가능 (실제론 대부분 SALE 유지됨)
- **BAD_KW**: 너무 일반적인 키워드(건강/라이프/케어 등), TV쇼명, 문법 파편 제거
- **완료**: 83건 (2026-06-14)

### 2-4. 상단 브랜드 배너 교체
```bash
node --env-file=.env.local scripts/naver-update-brand-top.mjs [--no=<origin_product_no>]
```
- 상세 상단에 브랜드 배너 이미지 삽입
- **완료**: 352건 (2026-06-13)

### 2-5. 상품명 잔재문구 수정
```bash
node --env-file=.env.local scripts/_naver-fix-names.mjs
```
- "수정해주세요", "변경된 이미지" 등 내부 메모가 상품명에 노출된 경우 수정
- **완료**: 6건 (2026-06-13)

---

## 3. 가격경쟁력 진단 (주기적 재실행 권장)

```bash
node --env-file=.env.local scripts/naver-price-compete.mjs [--limit=N]
# 결과: .tmp/naver-price-audit.json
```

**등급 기준**: WIN(하위 30%) / PAR(30~70%) / LOSE(70% 초과) / structural(시장 중위가 < MSP)
- 광고 후보 = WIN + structural=false
- LOSE + structural=true → 광고 금지
- **최근 진단**: 2026-06-12, WIN 89 / PAR 200 / LOSE 62 / structural 114

---

## 4. 전시카테고리 관리 (수동 — API 미지원)

> Naver Commerce API에 전시카테고리 전용 엔드포인트 없음. 파트너센터 UI에서만 가능.

**파트너센터**: sell.smartstore.naver.com → 상품관리 → 전시카테고리 관리

### 카테고리별 키워드 (DB 검색용)
| 전시카테고리 | 검색 키워드 |
|---|---|
| 눈·두뇌건강 | 루테인, 포스파티딜세린, 은행잎, 아스타잔틴, 빌베리 |
| 관절·뼈건강 | 콘드로이친, MSM, 보스웰리아, 초록입홍합, 글루코사민 |
| 유산균·장건강 | 효소, 프리바이오틱스, 식이섬유, 이눌린, 낙산균 |
| 오메가3·혈행 | 폴리코사놀, 크릴오일, 코큐텐, 코엔자임, 나토키나제 |
| 건강즙·스틱 | 즙, 진액, (70ml×30포 형태) |
| 미네랄·기타 | 밀크씨슬, 바나바, 셀레늄, 아연, 마그네슘, 칼슘 |

### 현황 (2026-06-14 기준)
- 12종 전시카테고리 생성 + 352개 배정 완료 (2026-06-13)
- 표준카테고리 재배정으로 일부 상품이 전시카테고리에서 빠짐 → 수동 보완 필요
- 건강즙·스틱 49건, 눈·두뇌건강 11건, 관절·뼈건강 13건, 유산균 9건, 오메가3 7건, 미네랄 21건

---

## 5. Naver Commerce API 특이사항

### 인증
- `lib/naver-api.mjs`: bcrypt HMAC 서명, `type=SELF`, 토큰 캐시 (3시간)
- 토큰은 21자 opaque (JWT 아님)

### 작동하는 엔드포인트 (현재 권한)
| 경로 | 설명 |
|---|---|
| `GET /v1/categories` | 표준카테고리 조회 |
| `GET /v2/products/origin-products/{no}` | 원상품 조회 |
| `PUT /v2/products/origin-products/{no}` | 원상품 수정 (Full PUT) |
| `GET /v1/pay-order/seller/product-orders` | 주문 목록 (from/to, max 24h) |
| `GET /v1/pay-order/seller/product-orders/last-changed-statuses` | 변경 주문 ID 목록 (max 24h) |
| `POST /v1/pay-order/seller/product-orders/query` | 주문 상세 (body: productOrderIds) |

### 403 / 권한 없음
- `GET /v2/products/channel-products/{no}` → 403 (경로 존재, SELF 타입 제한)

### 날짜 포맷 규칙
- 주문 API: **UTC Z 포맷** (`toISOString()`) ✓
- KST `+09:00` 포맷 → 400 오류

### 전시카테고리
- API로 조회/수정 불가
- 상품 PUT 시 `originProduct.displayCategoryNos` 배열로 이론상 가능하나 조회 방법 없음

---

## 6. DB 테이블

| 테이블 | 역할 | 주요 키 |
|---|---|---|
| `jimscanner_naver_listings` | 상품 목록 캐시 | `origin_product_no` |
| `jimscanner_naver_orders` | 주문 + 매입 추적(purchase_*, supplier_order_no, place_order_status — supabase/naver_orders_purchase.sql) | `product_order_id` (upsert key) |
| `jimscanner_naver_orders_sync_runs` | 주문 동기화 실행 로그 | - |

---

## 7. 작업 이력

| 날짜 | 작업 | 건수 | 스크립트 | 비고 |
|---|---|---|---|---|
| 2026-06-13 | 브랜드 배너 교체 | 352건 | naver-update-brand-top.mjs | 상세 상단 배너 전체 교체 |
| 2026-06-13 | 전시카테고리 생성+배정 | 12종/352건 | 수동(파트너센터) | - |
| 2026-06-13 | 가격경쟁력 진단 | 352건 | naver-price-compete.mjs | WIN89/PAR200/LOSE62/structural114 |
| 2026-06-13 | 표준카테고리 재배정 | 96건 | naver-recategorize.mjs | 기타건강보조식품 → 세분류 |
| 2026-06-13 | 태그 보강 | 352건 | naver-update-tags.mjs | 금지어 자동필터+재시도, 352/352 성공 |
| 2026-06-13 | 상품명 잔재문구 수정 | 6건 | _naver-fix-names.mjs | 내부 메모 노출 제거 |
| 2026-06-14 | 상품명 키워드 최적화 | 83건 | naver-keyword-optimize.mjs | 쇼핑검색량 기반, SALE 유지 확인 |
| 2026-06-14 | 주문 동기화 크론 구축 | - | local-cron-naver-orders-sync.mjs | Naver-Orders-Sync 작업 스케줄러 등록 |
| 2026-06-14 | 전시카테고리 보완 | 6개 카테고리 | 수동(파트너센터) | 건강즙49/눈뇌11/관절13/유산균9/오메가7/미네랄21 |
| 2026-06-14 | 태그 재보강 | 352건 | naver-update-tags.mjs --live | 전체 재실행, 업데이트 352/스킵 0/실패 0 |
| 2026-06-14 | 브랜드명 오류 수정 | 2건 | node 인라인 | 만사형통(송침유 → 만사형통 (13569375264, 13569375257) |
| 2026-07-03 | 주문 sync IP차단 복구 + 매핑 수정 | - | local-cron-naver-orders-sync.mjs | 7/2~ GW.IP_NOT_ALLOWED 43회 실패→IP 재등록, 중첩 응답구조 매핑 수정, error_message 기록 추가, 첫 실주문 수집 확인 |
| 2026-07-03 | 주문↔매입 관리 메뉴 신설 | - | /admin/naver-orders | 쿠팡 미러: 발주확인 자동호출·결제진행(id 자동판별)·매입원가/실수익·송장 내부기록, DDL naver_orders_purchase.sql |
| 2026-07-03 | 쿠팡 판매실적 상품 노출 전환 | 9건 | _naver-expose-suspended.mjs | naver-register-coupang-sold.mjs로 SUSPENSION 등록된 9건 → 전시 ON 전환(GET→PUT), 전건 전시=ON·판매=SALE 검증, DB status_type=SALE 동기화 |
