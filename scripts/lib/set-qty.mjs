/**
 * 쿠팡 상품명 → 매입수량 / 팩 내용물 파싱 (스카우트 소싱 전용 규칙).
 *
 * 도매 공급가는 1개 단가라 "N개" 묶음 리스팅은 N배로 매입해야 한다. 이걸 빼면
 * "수납정리함, 브라운, 8개"가 공급가 300원 하나로 계산돼 +11,288원 흑자로 둔갑한다.
 *
 * 핵심 구분 — 같은 숫자라도 의미가 다르다:
 *   매입 수량: "6개" "8개" "1세트" "1박스"   → 곱해야 함
 *   팩 내용물: "60개입" "3p" "60매" "15구"   → 이미 1개 안에 든 것. 곱하면 안 됨.
 * "물티슈, 6개, 60개입, 1박스"는 6팩을 사는 것이지 60배가 아니다(최댓값 규칙이면 60으로 오판).
 *
 * ⚠ 영양제용 lib/pack-normalize.mjs 의 parsePack 과 규칙이 다르다(그쪽은 "N개입"도 묶음으로 센다).
 *   섞어 쓰지 말 것. 화면 쪽 동일 규칙은 src/lib/sourcing/price-calc.ts 의 parseSetQty.
 */

/** 매입 수량 — 이 리스팅 하나를 만들려면 도매에서 몇 개를 사야 하는가 */
export function setQty(name) {
  const hits = (name || '').match(/(\d+)\s*(?:개(?!입)|세트|박스)(?![a-z가-힣])/g) || []
  let max = 1
  for (const h of hits) { const v = parseInt(h); if (v > max && v <= 200) max = v }
  return max
}

/** 팩 내용물 개수 — 곱하지 않는다. 도매 매칭이 같은 구성인지 사람이 확인하는 용도. */
export function packCount(name) {
  const hits = (name || '').match(/(\d+)\s*(?:개입|매|[pP])(?![a-z가-힣])/g) || []
  let max = 1
  for (const h of hits) { const v = parseInt(h); if (v > max && v <= 500) max = v }
  return max
}
