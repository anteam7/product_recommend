# 매입 대상 상품 카탈로그 + 쿠팡 일괄등록

> 상태: **구현 완료 (2026-09-16)** · 화면 `/admin/purchase-catalog` (사이드바 쿠팡 자동등록 > 🧾 매입 대상 상품)
> 목적: 매입처 5곳의 상품을 한 화면에서 비교해 **사람이 등록할 상품을 고르고**, 체크한 것만 쿠팡에 일괄 등록한다.

---

## 1. 왜 만들었나

등록 스크립트가 공급처마다 따로 놀아서 "지금 뭘 등록할 수 있고, 등록하면 얼마가 남는지"를 한 번에 볼 수가 없었다.
자동 판단(마진 필터)만으로 돌리면 MSP 파싱 오류·경쟁력 없는 상품까지 등록되므로, **사람이 보고 고르는 단계**를 만든다.

---

## 2. 구성

| 계층 | 산출물 | 비고 |
|---|---|---|
| 데이터 | `public.jimscanner_purchase_catalog` (뷰) | `supabase/purchase_catalog.sql` — 매입처 5곳 UNION ALL + 마진 + 등록현황 |
| 큐 | `public.jimscanner_register_jobs` | 같은 상품 중복 적재 방지(부분 유니크 인덱스) |
| 화면 | `src/app/admin/(dashboard)/purchase-catalog/{page.tsx,CatalogTable.tsx,sources.ts}` | 서버조회+필터 / 클라이언트 체크박스·일괄등록 |
| API | `src/app/api/admin/register-jobs/route.ts` | POST=큐 적재(최대 100건), GET=진행상황 폴링 |
| 실행기 | `scripts/register-agent.mjs` | 집 PC 상주. 큐 폴링 → 공급처별 등록 스크립트를 `--only=` 로 실행 |

### 매입처별 원천

| source | 테이블 | 공급가 | MSP | 매입배송비 | 쿠팡 등록기 |
|---|---|---|---|---|---|
| ggsan | `jimscanner_ggsan_products` | `price_krw` | `min_sell_price_krw` | 3,000 가정 | `coupang-register-batch-v2.mjs` |
| upickb2b | `jimscanner_upickb2b_products` | `member_price_krw` | `min_sell_price_krw` | `shipping_fee_text` 첫 금액 | `upickb2b-register.mjs` |
| bio77 | `jimscanner_bio77_products` | `dome_price_krw` | `msp_price_krw` | 3,000 가정 | `bio77-register.mjs` |
| wellroot | `jimscanner_wellroot_products` | `supply_price_krw` | `msp_price_krw` | `shipping_fee_krw` | `wellroot-register.mjs` |
| beseller | `jimscanner_beseller_products` | `supply_price` | `min_sell_price` | 0 (무료배송) | **없음** — 네이버 전용 |

---

## 3. 마진 정의 (화면에 보이는 숫자)

"**최저판매가(MSP)로 팔았을 때**" 기준이다. MSP는 공급사가 정한 하한이라 실제로 가장 싸게 팔 수 있는 합법가다.

```
원가       = 공급가(VAT 포함) + 매입배송비 1건
수수료     = MSP × 10.6%
순VAT      = max(0, (MSP - 원가) / 11)      ← 매입 입력VAT 공제 반영
마진       = MSP - 원가 - 수수료 - 순VAT
손익분기가 = ceil((0.9091 × 원가 / 0.8031) / 100) × 100
```

- 수수료율·배송비 상수는 `src/lib/coupang/price.ts`(FEE_RATE/SHIP)와 **이중관리 지점**이다. 바꾸면 뷰 SQL도 같이 고칠 것.
- `msp_suspicious` = MSP < 공급가. 유픽의 "MSP 900원"처럼 **수집 파싱 오류**가 섞여 있어 화면에 ⚠ 로 표시한다.
- 마진이 음수여도 등록이 막히지는 않는다. 등록 시 판매가는 `max(MSP, 목표마진가)`로 올라간다(§5).

---

## 4. 화면 사용법

- **매입처 탭** — 전체/건강산/유픽B2B/77바이오/웰루트/비셀러. 탭 옆 숫자는 현재 필터 기준 건수.
- **필터** — 미등록/등록됨 · 등록 가능한 것만(`coupang_target`) · MSP 마진 흑자만 · 검색(상품명·상품번호·브랜드) · 정렬 5종.
- **체크박스** — 아래 조건을 모두 만족할 때만 활성화된다. 비활성 사유는 체크박스 `title`에 뜬다.
  - 쿠팡 등록기가 있는 매입처(beseller 제외)
  - 아직 미등록 (`jimscanner_coupang_listings` 에 행 없음)
  - 공급처 기준 등록 가능(`coupang_target` — MSP 있고 판매중)
- **쿠팡 일괄등록** — 선택분을 큐에 넣고 3초 간격으로 진행 상황을 따라간다. **집 PC의 `register-agent.mjs` 가 꺼져 있으면 QUEUED 로 남는다.**

```bash
# 집 PC에서 상주 실행 (큐를 처리하는 쪽)
node scripts/register-agent.mjs            # 5초 폴링, 배치 20건
node scripts/register-agent.mjs --once     # 대기 중인 잡 1배치만 처리하고 종료
```

---

## 5. 등록 시 가격 (스크립트 쪽)

화면의 마진은 "MSP로 팔면" 기준이지만, 실제 등록가는 공급처 스크립트 정책을 따른다.

| 매입처 | 등록 판매가 |
|---|---|
| wellroot | `max(MSP, 목표순마진(기본 10%) 달성가)` — MSP가 원가보다 낮아도 적자 등록되지 않는다 |
| upickb2b | `max(MSP, 손익분기가)` |
| bio77 | MSP 그대로(77bio 지정가 절대준수) |
| ggsan | 기존 배치 정책(시세·MSP 기반) |

---

## 6. 매입처를 새로 추가할 때 (동기화 지점)

1. `supabase/purchase_catalog.sql` 뷰에 UNION ALL 블록 추가 → 재적용
2. `src/app/admin/(dashboard)/purchase-catalog/sources.ts` 에 라벨·상세URL 추가
3. `scripts/register-agent.mjs` `SOURCE_SCRIPTS` 에 등록 스크립트 추가
4. `src/app/api/admin/register-jobs/route.ts` `SUPPORTED_SOURCES` 에 추가
5. 등록 스크립트에 `--only=a,b,c` 타게팅이 있는지 확인 (없으면 추가)
6. 주문→매입 화면 연결은 `docs/` 별도 — `coupang-orders/page.tsx` 의 `SUPPLIER_LABELS`/`supplierUrl`

---

## 7. 알려진 한계

- **시세(경쟁가) 정보가 없다.** MSP 마진이 흑자라도 쿠팡에서 팔릴 가격인지는 별도 판단이 필요하다(`/admin/pricewatch` 참고).
- ggsan/bio77/upickb2b 매입배송비는 고정 3,000원 가정이다. 실제 구간 배송비는 반영되지 않는다.
- `register-agent.mjs` 는 배치 단위로 스크립트를 1회 실행하고 **listings 행이 생겼는지로 건별 성공/실패를 판정**한다. 스크립트가 중간에 죽으면 남은 건은 `등록 결과 없음`으로 FAILED 처리된다(재선택해서 다시 큐에 넣으면 된다).
- 비셀러(beseller)는 쿠팡 등록기가 없어 조회 전용이다.
- **브랜드 유추 주의(2026-09-17 실측)** — ggsan·upickb2b·bio77 등록기는 `brand = 상품명 첫 토큰` 관행을 쓴다. 타사 상표가 걸리면 쿠팡이 "브랜드 ID가 필요합니다"로 거절한다. 웰루트 등록기는 공급처가 명시한 brand 컬럼이 있을 때만 보내고 없으면 생략하는 방식으로 고쳤다.
- **실패 건 재시도** — 등록기들이 FAILED 행까지 "이미 등록됨"으로 세서 재시도가 막힌다(bio77 등 해당). 웰루트만 FAILED 제외로 고쳐져 있다. 다른 공급처는 listings 의 FAILED 행을 지우고 다시 큐에 넣어야 한다.
- **쿠팡 필수 구매옵션 의무화(2026-02~)** — 예측 카테고리가 `isAllowSingleItem=false` 면 단일상품 등록이 불가해 SKIP 된다. 웰루트 실측에서 128건 중 62건이 여기 걸렸다(환·분말·가루류). 살리려면 옵션조합(items[] 다중 variant) 등록 구현이 필요하다.

---

## 8. 등록 후 마무리 — `scripts/coupang-followup-approvals.mjs`

등록 직후에는 쿠팡 검수(수시간~1-2일) 전이라 `vendorItemId`가 없어 **재고를 넣을 수 없다**. 재고가 0이면 검수를 통과해도 판매가 시작되지 않으므로, 검수 통과 시점에 이 스크립트로 마무리한다.

```bash
node scripts/coupang-followup-approvals.mjs --dry              # 웰루트 현황만 확인
node scripts/coupang-followup-approvals.mjs                    # 재고 30개 설정
node scripts/coupang-followup-approvals.mjs --source=bio77 --qty=10
node scripts/coupang-followup-approvals.mjs --only=216 --qty=5
```

대상은 `TEMPORARY_SAVE / PENDING_APPROVAL / APPROVED` 상태의 listings이며 쿠팡 statusName 별로:

| statusName | 처리 |
|---|---|
| 승인반려·거절 | `REJECTED` + 사유 기록 (재시도 불가) |
| 임시저장 | 승인요청 재호출 → `PENDING_APPROVAL` |
| 검수 대기(vendorItemId 없음) | 대기 보고만 — 나중에 다시 실행 |
| 승인완료 | `APPROVED`·`approved_at` 기록 + **재고가 0인 vendorItem에만 재고 설정** → `displayable=true` |

- **이미 재고가 있는 상품은 건드리지 않는다.** 재고는 stock-sync 크론 소관이라 덮어쓰면 품절 처리된 상품이 되살아난다. 강제로 덮어쓰려면 `--force-stock`.
- `--source` 기본값은 `wellroot`. 전 공급처를 돌리려면 `--source=all` 을 명시해야 한다.
- 기존 `bio77-retry-approvals.mjs`·`coupang-bulk-approve-stock.mjs` 는 임시저장 건만 다루고 검수 통과분 재고를 넣지 않는다.

---

## 9. 수수료율 — 카테고리별 (2026-09-18)

초기 구현은 `10.6%` 고정이었다. 실제로는 **등록 카테고리마다 다르고**, 그 차이가 마진 순위를 뒤집는다
(웰루트 119건 기준 15% 이상이 48건 → 57건으로 바뀐다).

**왜 사용자 제공 표를 바로 못 썼나** — `scripts/lib/coupang-commission.mjs`(사용자 제공, 2026-07)는
대분류 이름 기준 + 상품명 텍스트 매칭이다. 실제 등록은 말단 카테고리(루테인·건강분말)로 들어가므로
웰루트 128건 중 **95건이 기본값 10.8%로 빠졌고**, 카테고리명 기준과 상품명 기준이 서로 다른 답을 냈다.

**해결** — 쿠팡 카테고리 트리에서 전체 경로를 받아 경로 기준으로 판정한다.

```
GET /v2/providers/seller_api/apis/api/v1/marketplace/meta/display-categories/{code}
  → { name, child[] }   (부모는 안 주므로 루트에서 내려가며 경로를 만든다)
```

| 경로 | 수수료 |
|---|---|
| `식품 > 건강식품 > 건강식품 > *` (유산균·루테인·쏘팔메토·마카·아연·비타민) | **7.6%** |
| 그 외 식품 하위 (전통건강식품·환/분말·가루/조미료·다이어트식품·신선식품·차류) | **10.6%** |

사용자 확정(2026-09-18): 건강분말·건강환·가루류·다이어트식품은 전부 식품 10.6%.

- 적재: `node scripts/coupang-build-commission-table.mjs [--reuse] [--dry]` → `jimscanner_coupang_category_commission` (식품 하위 1,527개)
- 뷰가 `category_code` 로 조인해 `fee_rate`·`fee_category` 를 노출하고, 마진·손익분기가 계산에 쓴다
- 카테고리 코드 출처: ggsan `raw_payload.coupang_predicted_category.id` · bio77/wellroot `coupang_category_code` · upickb2b/beseller 없음(기본 10.6%)
- 손익분기가 유도: `margin = S - C - S·f - (S-C)/11 = 0` → `S = 0.909091·C / (0.909091 - f)`

**아직 확정 아님** — 쿠팡 OpenAPI 에는 카테고리별 수수료 조회가 없고(4개 경로 모두 404), 주문 테이블에도
정산 금액 컬럼이 없어 실측 검증이 불가능하다. **첫 정산 내역이 나오면 7.6%/10.6% 를 대조할 것.**
