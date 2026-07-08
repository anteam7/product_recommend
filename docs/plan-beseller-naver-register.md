# 비셀러 강력후보 → 네이버 스마트스토어 등록 (옵션 묶음) — 2026-07-09

## 목표
`jimscanner_beseller_price_compare.grade='strong'` 그룹을 네이버 스마트스토어에 등록.
같은 그룹의 변형(수량/무게)은 **하나의 상품에 옵션**으로. 판매가는 공급가+네이버수수료+내 마진 반영.

## 판매가 산정
- FEE=0.06(스마트스토어 매출연동+네이버페이 결제), MARGIN=0.25(기본, `--margin`)
- 옵션별 `sell = ceil(supply / (1 − FEE − MARGIN) / 100) × 100`, `sell = max(sell, min_sell_price)`
- 강력등급 정의상 이 sell ≤ 네이버 경쟁가대(P20) → 경쟁력 유지하며 25% 마진 확보
- base salePrice = 최저옵션 sell, 옵션 추가금액 = sell − base (≥0)

## 옵션
- `optionCombinationGroupNames.optionGroupName1` = 중량(무게변형)/수량/종류 자동판정
- `optionCombinations[]` = {optionName1: variant_label, stockQuantity: 5, price: 추가금액, usable: 재고여부}
- 옵션명↔branduid 매핑을 `jimscanner_naver_listings.request_payload.option_map` 에 보존(추후 비셀러 발주 자동화용)
- ⚠ 네이버 옵션 추가금액 범위 제약 가능 → 1그룹 검증에서 확인 후 대응(초과 변형은 제외/분리)

## 카테고리 (식품)
- 런타임 `/v1/categories` 조회(5,857개, last=leaf) → 식품 leaf 630개
- resolveCategory: ① 큐레이션 규칙(김치 파김치50002029·젓갈 새우젓50004728·게장50004734·반찬 장아찌50001916·어묵50001874·만두50001871·과일·채소·건강식품 등 실 leaf ID) ② 말단명 매칭(제목에 leaf 말단명 포함, 최장 우선) ③ 비셀러 cate_label 폴백
- 건강식품 그룹 → 건강식품 leaf(홍삼/즙/영양제/건강분말) + 고시 DIET_FOOD, 그 외 식품 → 고시 PROCESSED_FOOD(전부 상품상세참조), 필요 시 검증서 조정

## 등록 파라미터 (naver-register.mjs 재사용)
- SHIP_ADDR 106028428, RETURN_ADDR 200357454, BUNDLE_GROUP 54006647, CONTACT 010-4164-3802
- 배송 무료(FREE) + CJGLS, 반품 3000/교환 6000, statusType SALE + 채널 SUSPENSION(비노출 등록)
- 이미지: 비셀러 thumb→네이버 업로드, 상세 detail_images→네이버 업로드→detailContent HTML
- 원산지: originAreaCode + content=비셀러 origin. 세금 taxType(식품 대부분 면세 검토)

## 실행
1. `beseller-naver-register.mjs --limit=1` (SUSPENSION) → 네이버 응답 검증 → 카테고리/고시/옵션 제약 수정
2. 검증 통과 후 `--grade=strong` 배치 (SUSPENSION)
3. `jimscanner_naver_listings`(source='beseller') 추적, 커밋+푸시
4. 사용자 검토 후 노출(ON) 전환 — 카테고리 정확도 스팟체크 권장

## 한계/리스크
- 카테고리 자동매핑 정확도(126종 다양) → SUSPENSION로 리뷰 여지 확보
- 옵션↔branduid 다대일이라 발주 자동화는 별도(비셀러 order-server 미지원)
- 원산지/고시 정확성은 "상품상세참조" 위주 → 노출 전 확인 필요
