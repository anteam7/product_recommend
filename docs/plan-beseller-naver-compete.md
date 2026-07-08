# 비셀러 ↔ 네이버 스마트스토어 가격경쟁력 태깅 (2026-07-08)

## 목적
수집한 비셀러 4,466상품(2,000그룹)을 네이버 쇼핑에서 가격비교 → 경쟁력 있는 상품에 뱃지/태그 → 관리페이지에서 그것만 필터 조회.

## 핵심 규칙 (사용자 지정)
네이버 검색결과는 **한 상품의 옵션 중 최저가 옵션**이 노출됨 (수미감자 1/3/5kg → 1kg 가격 표시).
→ 우리도 **그룹의 최저옵션(공급가 최저 활성변형)** 으로 비교한다.

## 비교 산식
- `our_supply` = 그룹 내 active 변형 중 최저 공급가
- 검색어 = 그 최저옵션의 제목(정제) → 네이버 쇼핑 OpenAPI `sort=sim` display=40
- 동일 SKU 필터: 우리 제목 vs 네이버 title bigram 유사도 ≥ 0.40 → 그 중 **최저 lprice** (네이버 노출 방식과 동일)
- `fee` = 0.06 (스마트스토어 매출연동 2% + 네이버페이 결제 ~3.6%), 식품 **면세**라 VAT 미차감, 배송 중립(고객부담)
- `margin_at_low` = round(market_low × (1−fee)) − our_supply
- `margin_rate` = margin_at_low / market_low
- MSP(min_sell_price) 있고 `market_low < MSP` → 구조적 열위(못 맞춤) → 등급 하향

## 등급
| grade | 조건 |
|---|---|
| 🏆 strong | margin_rate ≥ 0.25 · 표본 ≥ 3 · MSP 위반 아님 |
| ✅ ok | margin_rate ≥ 0.12 · 표본 ≥ 3 · MSP 위반 아님 |
| 🟡 weak | margin_rate ≥ 0 (얇거나 표본<3 or 저신뢰) |
| none | 적자 / 무매칭 |

## 산출물
1. `supabase/beseller_price_compare.sql` → `jimscanner_beseller_price_compare` (group_key PK, rep_branduid, our_supply, market_low, market_mall, market_count, margin_at_low, margin_rate, grade, query, low_confidence, checked_at)
2. `scripts/beseller-naver-compete.mjs` — `--limit --grade-min --sleep --dry`. run-crons 주간 스텝 후보(초기엔 수동/버튼).
3. 관리페이지 `/admin/trend-radar/beseller` — 그룹 시작행에 경쟁력 뱃지(🏆/✅/🟡 + 마진율 + 네이버최저 vs 공급가), 상단 필터 `compete=win|strong` + KPI.

## 한계
- 네이버 SKU 매칭이 이름기반이라 중량/규격 불일치 가능 → low_confidence 플래그 + 표본수 노출로 완화(도매매 스크리너 [[domemedb_coupang_margin]] 동일 접근).
- 네이버 OpenAPI 25,000회/일 한도 내(2,000그룹 << 한도).
