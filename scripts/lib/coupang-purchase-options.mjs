/**
 * 쿠팡 구매옵션(개당 캡슐/정·개당 중량·개당 용량 + 수량) — 규격 텍스트 → items[].attributes · itemName
 *
 * 쿠팡은 이 값으로 단위가격(1정당·10g당·10ml당)을 계산해 가격 옆에 보여준다. 틀리면 "2g 한 개에 32,800원"처럼 보여
 * 전환이 죽는다(2026-09-27 K홀세일 첫 등록: "2g x 30포"가 "2g 1개"·"30정 1개", "70ml x 30포"가 "70ml 1개"로 올라감).
 * 옛 등록기(유픽·건강산·77바이오·웰루트)는 규격을 못 읽으면 30정·0g·0ml 같은 기본값을 채웠다 → 이 모듈은 지어내지 않고
 * { error } 를 돌려준다(호출부가 등록 보류).
 *
 * 쿠팡 표준 표기(경쟁 상품 norm):
 *   정·캡슐 제품            개당 캡슐/정 = 한 통 알 수,  수량 = 통 수          예) 루테인 "60정, 1개"
 *   포·스틱·병 낱개 포장     개당 중량/용량 = 낱개 하나,  수량 = 총 낱개 수     예) 락토핏 "2g, 50개" · 홍삼진액 "70ml, 30개"
 *   단일 용기(분말 200g 등)  개당 중량/용량 = 용기 하나,  수량 = 통 수
 *   차·분말 일부 카테고리   최소 중량/용량 = 낱개 하나, 개당 수량 = 한 박스 개입 수, 수량 = 박스 수   예) 티백 "1.2g, 100개입, 1개"
 * 값은 공백 없는 "숫자+단위", 0 은 무효, 그룹(개당 캡슐/정·중량·용량)은 하나만 채운다(coupang_put_attribute_formula).
 */

const TABLET = /^(정|캡슐|캡술|알|caps?|tabs?)$/i
const PIECE = /^(포|스틱|티백|병|봉지|봉|팩|개입|입|환|매)$/   // 낱개 포장 단위
const BOX = /^(박스|통|세트)$/                               // 묶음 배수 — "60정 x 6박스"는 6통, "2g x 30포 x 3박스"는 90포
// 긴 단위를 먼저(mg 가 g 보다, 개입이 입보다 앞). 단위 뒤 영문·한글이 이어지면 다른 단어라 제외 — 단 "400mgx90캡슐"의 x 는 허용
const TOKEN = /(\d+(?:\.\d+)?)\s*(kg|mg|g|ml|l|정|캡슐|캡술|알|caps|cap|tabs|tab|포|스틱|티백|병|봉지|봉|팩|개입|입|환|매|박스|통|세트)(?![a-wy-z가-힣])/gi

/**
 * 규격 텍스트 파싱. 숫자+단위가 하나도 없으면 null(호출부가 다른 출처로 재시도).
 *   tablet  { perContainer: 한 통 알 수(여러 개면 최댓값), containers: 통 수(예 "90정*2병" → 2, "60정 x 6박스" → 6) }
 *   piece   { pieces: 총 낱개 수, perPack: 한 박스 낱개 수, packs: 박스 수 (예 "20g x 14포 x 4박스" → 56 / 14 / 4) }
 *   single  { packs: 용기 수 } (용기 하나 — "200g")
 * weightG·volumeMl 은 첫 번째 값 = 낱개(또는 용기) 하나 기준. "(60g)" 같은 뒤쪽 총량은 무시한다.
 */
export function parseSpec(text) {
  const t = String(text || '').replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
  let weightG = null, volumeMl = null, tablet = null, found = false
  const pieces = [], boxes = []
  for (const m of t.matchAll(TOKEN)) {
    const v = parseFloat(m[1]); const u = m[2].toLowerCase()
    // 묶음 배수는 작은 수만 — "콘드로이친 1200 세트"의 1200은 제품명 숫자다(2026-09-27 전수점검 실측)
    if (BOX.test(u) && v > 20) continue
    found = true
    if (u === 'kg' || u === 'g' || u === 'mg') { if (weightG == null) weightG = u === 'kg' ? v * 1000 : u === 'mg' ? v / 1000 : v }
    else if (u === 'ml' || u === 'l') { if (volumeMl == null) volumeMl = u === 'l' ? v * 1000 : v }
    else if (TABLET.test(u)) { if (tablet == null || v > tablet) tablet = v }   // 상품명의 "1일 2정" 같은 복용량보다 통당 알 수(최댓값)
    else if (PIECE.test(u)) pieces.push(v)
    else if (BOX.test(u)) boxes.push(v)
  }
  if (!found) return null
  const prod = a => a.reduce((x, y) => x * y, 1)
  const perPack = prod(pieces), packs = prod(boxes)
  // "3박스 총90정" — 총 표기는 전체 알 수 → 통당 = 총 ÷ 통 수
  const total = /총\s*(\d+)\s*(?:정|캡슐|캡술|알)/.exec(t)
  const containers = perPack * packs
  if (tablet != null && total && +total[1] === tablet && containers > 1 && tablet % containers === 0) tablet = tablet / containers
  if (tablet != null) return { mode: 'tablet', weightG, volumeMl, perContainer: tablet, containers }
  if (pieces.length) return { mode: 'piece', weightG, volumeMl, pieces: perPack * packs, perPack, packs }
  if (boxes.length) return { mode: 'piece', weightG, volumeMl, pieces: packs, perPack: 1, packs }   // "240g 2통" = 용기 2개
  return { mode: 'single', weightG, volumeMl, packs: 1 }
}

function pickUnit(usableUnits, preferences) {
  if (!usableUnits || usableUnits.length === 0) return ''
  for (const p of preferences) if (usableUnits.includes(p)) return p
  return usableUnits[0]
}
const num = v => String(+Number(v).toFixed(2))
// 카테고리마다 같은 뜻의 속성 이름이 다르다(개당 중량 ↔ 최소 중량 등). 필수이거나 그룹에 속한 쪽을 쓴다
const WEIGHT_NAMES = ['개당 중량', '최소 중량']
const VOLUME_NAMES = ['개당 용량', '최소 용량']
const TAB_NAMES = ['개당 캡슐/정']

/**
 * 카테고리 메타 attributes + parseSpec 결과 → { attributes, itemName } | { error }
 * qty = 묶음 수(1·2·3개 변형). 수량 = (한 묶음의 통·박스 수 또는 낱개 수) × qty.
 * sendEmpty=true 면 값 없는 선택 속성도 exposed NONE·빈 값으로 보낸다(신규 등록 POST 공식). PUT 은 false(빈 값 미전송).
 * alsoTotalQty=true 면 '총 수량'도 수량과 같은 값으로 노출한다 — 옛 등록분 PUT 에서 요구된다(coupang_put_attribute_formula).
 */
export function buildPurchaseOptions(categoryAttrs, spec, qty = 1, { sendEmpty = true, alsoTotalQty = false } = {}) {
  const attrs = (categoryAttrs ?? []).filter(a => typeof a?.attributeTypeName === 'string')
  if (!spec) return { error: '규격(중량·용량·정 수)을 읽지 못함' }
  const pick = names => {
    for (const n of names) {
      const a = attrs.find(x => x.attributeTypeName === n && (x.required === 'MANDATORY' || (x.groupNumber && x.groupNumber !== 'NONE')))
      if (a) return a
    }
    return null
  }
  const weightAttr = pick(WEIGHT_NAMES), volumeAttr = pick(VOLUME_NAMES), tabAttr = pick(TAB_NAMES)
  // 차·분말 일부 카테고리: 최소 중량 · 개당 수량(N개입) · 수량 3단 구조
  const perPackAttr = attrs.find(a => a.attributeTypeName === '개당 수량' && a.required === 'MANDATORY') ?? null
  const qtyAttrs = attrs.filter(a => a.attributeTypeName === '수량' || a.attributeTypeName === '총 수량')
  const qtyName = (qtyAttrs.find(a => a.required === 'MANDATORY') ?? qtyAttrs.find(a => a.attributeTypeName === '수량') ?? qtyAttrs[0])?.attributeTypeName ?? '수량'

  // "900mg"처럼 한 알 무게만 있는 이름을 용기 중량으로 오인하지 않는다
  if (spec.mode === 'single' && spec.volumeMl == null && spec.weightG != null && spec.weightG < 5) return { error: `용기 규격 불명(한 알 무게 ${num(spec.weightG)}g만 있음)` }

  const vol = spec.volumeMl != null && volumeAttr ? { attr: volumeAttr, v: spec.volumeMl, units: ['ml', 'L'] } : null
  const wt = spec.weightG != null && weightAttr ? { attr: weightAttr, v: spec.weightG, units: ['g', 'kg'] } : null
  const tab = tabAttr ? { attr: tabAttr, units: ['정', '회분'] } : null
  // 후보(우선순위순): measure = 그룹 속성에 넣을 값, perPack = 개당 수량(3단 구조만), count = 한 묶음의 수량
  const plans = []
  if (perPackAttr) {
    if (spec.mode === 'tablet') { const m = wt ?? vol; if (m) plans.push({ ...m, perPack: spec.perContainer, count: spec.containers }) }
    else if (spec.mode === 'piece') { for (const m of [vol, wt]) if (m) plans.push({ ...m, perPack: spec.perPack, count: spec.packs }) }
    else for (const m of [vol, wt]) if (m) plans.push({ ...m, perPack: 1, count: 1 })
  } else if (spec.mode === 'tablet') {
    if (tab) plans.push({ ...tab, v: spec.perContainer, count: spec.containers })
    for (const m of [wt, vol]) if (m) plans.push({ ...m, count: spec.perContainer * spec.containers })
  } else if (spec.mode === 'piece') {
    for (const m of [vol, wt]) if (m) plans.push({ ...m, count: spec.pieces })
    // 낱개 중량·용량을 모를 때만: 한 박스에 든 회분 수 × 박스 수 — "30회분, 1개", "필름 30매 x 3박스" → "30회분, 3개"
    // (정·캡슐 제품의 "60정, 3개"와 같은 박스 기준 — 수량만 노출된 옛 등록분에서도 박스 수가 보인다)
    if (tab) plans.push({ ...tab, units: ['회분'], v: spec.perPack, count: spec.packs })
  } else {
    for (const m of [vol, wt]) if (m) plans.push({ ...m, count: 1 })
  }
  let chosen = null
  for (const p of plans) {
    if (!(p.v > 0)) continue
    const usable = p.attr.usableUnits ?? []
    const unit = usable.length ? p.units.find(u => usable.includes(u)) : p.units[0]
    if (!unit) continue
    chosen = { ...p, value: `${num(p.v)}${unit}` }
    break
  }
  if (!chosen) return { error: `규격에 맞는 구매옵션 없음(${spec.mode} · 중량 ${spec.weightG ?? '-'} · 용량 ${spec.volumeMl ?? '-'})` }
  const group = chosen.attr.groupNumber && chosen.attr.groupNumber !== 'NONE' ? chosen.attr.groupNumber : null
  const qtyAttr = attrs.find(a => a.attributeTypeName === qtyName)
  const qtyCount = Math.round(chosen.count * qty)   // 개수는 정수 — "2.5포" 같은 비정상 규격의 소수 오차 방지
  if (!(qtyCount > 0)) return { error: `수량 계산 불가(${chosen.count}×${qty})` }
  const qtyValue = `${qtyCount}${pickUnit(qtyAttr?.usableUnits, ['개', '박스', '세트', '팩']) || '개'}`
  let perPackValue = null
  if (perPackAttr) {
    const pp = Math.round(chosen.perPack ?? 0)
    if (!(pp > 0)) return { error: '개당 수량(개입) 계산 불가' }
    perPackValue = `${pp}${pickUnit(perPackAttr.usableUnits, ['개입', '입', '개']) || '개입'}`
  }

  const out = []
  for (const a of attrs) {
    const name = a.attributeTypeName
    if (a === chosen.attr) { out.push({ attributeTypeName: name, attributeValueName: chosen.value, exposed: 'EXPOSED' }); continue }
    if (group && a.groupNumber === group) continue            // 같은 그룹의 나머지는 미전송(하나만)
    if (a === perPackAttr) { out.push({ attributeTypeName: name, attributeValueName: perPackValue, exposed: 'EXPOSED' }); continue }
    if (name === qtyName) { out.push({ attributeTypeName: name, attributeValueName: qtyValue, exposed: 'EXPOSED' }); continue }
    if (name === '총 수량' && alsoTotalQty) { out.push({ attributeTypeName: name, attributeValueName: qtyValue, exposed: 'EXPOSED' }); continue }
    if (name === '수량' || name === '총 수량') continue
    if (a.required === 'MANDATORY') return { error: `처리 못 하는 필수 구매옵션: ${name}` }
    if (sendEmpty) out.push({ attributeTypeName: name, attributeValueName: '', exposed: 'NONE' })
  }
  return { attributes: out, itemName: [chosen.value, perPackValue, qtyValue].filter(Boolean).join(' ') }
}
