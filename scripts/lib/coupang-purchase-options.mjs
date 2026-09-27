/**
 * 쿠팡 구매옵션(개당 캡슐/정·개당 중량·개당 용량 + 수량) — 규격 텍스트 → items[].attributes · itemName
 *
 * 쿠팡은 이 값으로 단위가격(1정당·10g당·10ml당)을 계산해 가격 옆에 보여준다. 틀리면 "2g 한 개에 32,800원"처럼 보여
 * 전환이 죽는다(2026-09-27 K홀세일 첫 등록: "2g x 30포"가 "2g 1개"·"30정 1개", "70ml x 30포"가 "70ml 1개"로 올라감).
 *
 * 쿠팡 표준 표기(경쟁 상품 norm):
 *   정·캡슐 제품            개당 캡슐/정 = 한 통 알 수,  수량 = 통 수          예) 루테인 "60정, 1개"
 *   포·스틱·병 낱개 포장     개당 중량/용량 = 낱개 하나,  수량 = 총 낱개 수     예) 락토핏 "2g, 50개" · 홍삼진액 "70ml, 30개"
 *   단일 용기(분말 200g 등)  개당 중량/용량 = 용기 하나,  수량 = 통 수
 * 값은 공백 없는 "숫자+단위", 0 은 무효, 그룹(개당 캡슐/정·중량·용량)은 하나만 채운다(coupang_put_attribute_formula).
 */

const TABLET = /^(정|캡슐|캡술|알|caps?|tabs?)$/i
const PIECE = /^(포|스틱|병|봉|팩|개입|입|환|매)$/
// 긴 단위를 먼저(mg 가 g 보다, 개입이 입보다 앞). 단위 뒤 영문·한글이 이어지면 다른 단어라 제외 — 단 "400mgx90캡슐"의 x 는 허용
const TOKEN = /(\d+(?:\.\d+)?)\s*(kg|mg|g|ml|l|정|캡슐|캡술|알|caps|cap|tabs|tab|포|스틱|병|봉|팩|개입|입|환|매)(?![a-wy-z가-힣])/gi

/**
 * 규격 텍스트 파싱. 숫자+단위가 하나도 없으면 null(호출부가 상품명으로 재시도).
 *   tablet  { perContainer: 한 통 알 수, containers: 통 수(예 "90정*2병" → 2) }
 *   piece   { pieces: 총 낱개 수(예 "20g*15포" → 15) }
 *   single  (용기 하나 — "200g")
 * weightG·volumeMl 은 첫 번째 값 = 낱개(또는 용기) 하나 기준. "(60g)" 같은 뒤쪽 총량은 무시한다.
 */
export function parseSpec(text) {
  const t = String(text || '').replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
  let weightG = null, volumeMl = null, tablet = null, found = false
  const pieces = []
  for (const m of t.matchAll(TOKEN)) {
    found = true
    const v = parseFloat(m[1]); const u = m[2].toLowerCase()
    if (u === 'kg' || u === 'g' || u === 'mg') { if (weightG == null) weightG = u === 'kg' ? v * 1000 : u === 'mg' ? v / 1000 : v }
    else if (u === 'ml' || u === 'l') { if (volumeMl == null) volumeMl = u === 'l' ? v * 1000 : v }
    else if (TABLET.test(u)) { if (tablet == null) tablet = v }
    else if (PIECE.test(u)) pieces.push(v)
  }
  if (!found) return null
  const multiplier = pieces.reduce((a, b) => a * b, 1)
  if (tablet != null) return { mode: 'tablet', weightG, volumeMl, perContainer: tablet, containers: multiplier }
  if (pieces.length) return { mode: 'piece', weightG, volumeMl, pieces: multiplier }
  return { mode: 'single', weightG, volumeMl }
}

function pickUnit(usableUnits, preferences) {
  if (!usableUnits || usableUnits.length === 0) return ''
  for (const p of preferences) if (usableUnits.includes(p)) return p
  return usableUnits[0]
}
const num = v => String(+Number(v).toFixed(2))

/**
 * 카테고리 메타 attributes + parseSpec 결과 → { attributes, itemName } | { error }
 * qty = 묶음 수(1·2·3개 변형). 수량 = (한 묶음의 통 수 또는 낱개 수) × qty.
 * sendEmpty=true 면 값 없는 선택 속성도 exposed NONE·빈 값으로 보낸다(신규 등록 POST 공식). PUT 은 false(빈 값 미전송).
 */
export function buildPurchaseOptions(categoryAttrs, spec, qty = 1, { sendEmpty = true } = {}) {
  const attrs = (categoryAttrs ?? []).filter(a => typeof a?.attributeTypeName === 'string')
  if (!spec) return { error: '규격(중량·용량·정 수)을 읽지 못함' }
  const qtyAttrs = attrs.filter(a => a.attributeTypeName === '수량' || a.attributeTypeName === '총 수량')
  const qtyName = (qtyAttrs.find(a => a.required === 'MANDATORY') ?? qtyAttrs.find(a => a.attributeTypeName === '수량') ?? qtyAttrs[0])?.attributeTypeName ?? '수량'

  // 채울 후보(우선순위순): 그 속성이 카테고리에 있고 값이 0보다 크면 채택. count = 한 묶음의 수량
  const vol = spec.volumeMl != null ? { name: '개당 용량', v: spec.volumeMl, units: ['ml', 'L'] } : null
  const wt = spec.weightG != null ? { name: '개당 중량', v: spec.weightG, units: ['g', 'kg'] } : null
  const plans = []
  if (spec.mode === 'tablet') {
    plans.push({ name: '개당 캡슐/정', v: spec.perContainer, units: ['정', '회분'], count: spec.containers })
    for (const m of [wt, vol]) if (m) plans.push({ ...m, count: spec.perContainer * spec.containers })
  } else if (spec.mode === 'piece') {
    for (const m of [vol, wt]) if (m) plans.push({ ...m, count: spec.pieces })
    // 낱개 중량·용량을 모를 때만: 한 통(묶음 1개)에 든 회분 수로 표기 — "30회분, 1개" (정·캡슐 제품의 "60정, 1개"와 같은 한 통 기준)
    plans.push({ name: '개당 캡슐/정', v: spec.pieces, units: ['회분'], count: 1 })
  } else {
    for (const m of [vol, wt]) if (m) plans.push({ ...m, count: 1 })
  }
  let chosen = null
  for (const p of plans) {
    const a = attrs.find(x => x.attributeTypeName === p.name)
    if (!a || !(p.v > 0)) continue
    const usable = a.usableUnits ?? []
    const unit = usable.length ? p.units.find(u => usable.includes(u)) : p.units[0]
    if (!unit) continue
    chosen = { ...p, attr: a, value: `${num(p.v)}${unit}` }
    break
  }
  if (!chosen) return { error: `규격에 맞는 구매옵션 없음(${spec.mode} · 중량 ${spec.weightG ?? '-'} · 용량 ${spec.volumeMl ?? '-'})` }
  const group = chosen.attr.groupNumber && chosen.attr.groupNumber !== 'NONE' ? chosen.attr.groupNumber : null
  const qtyAttr = attrs.find(a => a.attributeTypeName === qtyName)
  const qtyCount = Math.round(chosen.count * qty)   // 개수는 정수 — "2.5포" 같은 비정상 규격의 소수 오차 방지
  if (!(qtyCount > 0)) return { error: `수량 계산 불가(${chosen.count}×${qty})` }
  const qtyValue = `${qtyCount}${pickUnit(qtyAttr?.usableUnits, ['개', '박스', '세트', '팩']) || '개'}`

  const out = []
  for (const a of attrs) {
    const name = a.attributeTypeName
    if (a === chosen.attr) { out.push({ attributeTypeName: name, attributeValueName: chosen.value, exposed: 'EXPOSED' }); continue }
    if (group && a.groupNumber === group) continue            // 같은 그룹의 나머지는 미전송(하나만)
    if (name === qtyName) { out.push({ attributeTypeName: name, attributeValueName: qtyValue, exposed: 'EXPOSED' }); continue }
    if (name === '수량' || name === '총 수량') continue
    if (a.required === 'MANDATORY') return { error: `처리 못 하는 필수 구매옵션: ${name}` }
    if (sendEmpty) out.push({ attributeTypeName: name, attributeValueName: '', exposed: 'NONE' })
  }
  return { attributes: out, itemName: `${chosen.value} ${qtyValue}` }
}
