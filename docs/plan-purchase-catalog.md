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
