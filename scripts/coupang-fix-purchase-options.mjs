/**
 * 판매중 쿠팡 상품의 구매옵션을 쿠팡 표기 norm 으로 정정 — 공통 모듈(lib/coupang-purchase-options.mjs)로 다시 만든다.
 *   node scripts/coupang-fix-purchase-options.mjs --ids=16260122625,16226365212 [--spec=16206188152:150g] [--apply]
 *   node scripts/coupang-fix-purchase-options.mjs --audit=<점검 json> --verdicts=HIGH,QTY [--skip-orders-over=5] [--exclude=..] [--limit=N] [--apply]
 *
 * 기본은 dry-run(쿠팡·DB 변경 없음). --apply 면 full PUT → 8초 후 승인요청 → 상태 확인 → listings 동기화.
 * full PUT 은 판매중 상품을 임시저장으로 내린다(재승인까지 잠시 판매 중단 — 2026-09-27 실측 2건은 즉시 재승인).
 * 규격: --spec 지정값 > 상품명 > 판매자 옵션명(0g 같은 가짜 값 제외). 규격을 못 읽으면 건너뛴다(지어내지 않음).
 * 묶음 수: externalVendorSku "-N" 접미사(웰루트·K홀세일 묶음) > unitCount > 1.
 * 옵션 외 속성(검색용 속성 등)은 값이 있으면 그대로 보존한다. 적용 기록: _tmp_fix_options_log.jsonl
 * 점검 json: scripts/_coupang-option-audit.mjs 결과(판정 HIGH 수정필요 · QTY 수량불일치 …).
 */
import crypto from 'node:crypto'
import { readFileSync, appendFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { parseSpec, buildPurchaseOptions } from './lib/coupang-purchase-options.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const { COUPANG_ACCESS_KEY: AK, COUPANG_SECRET_KEY: SK, COUPANG_API_HOST: HOST } = env
if (!AK || !SK || !HOST) { console.error('.env.local 에 COUPANG_ACCESS_KEY·COUPANG_SECRET_KEY·COUPANG_API_HOST 필요'); process.exit(1) }
const args = process.argv.slice(2)
const argOf = k => args.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')
const APPLY = args.includes('--apply')
const LIMIT = +(argOf('limit') || 0) || 0
const SKIP_ORDERS_OVER = argOf('skip-orders-over') != null ? +argOf('skip-orders-over') : null
const EXCLUDE = new Set((argOf('exclude') || '').split(',').map(s => s.trim()).filter(Boolean))
const SPEC = new Map(args.filter(a => a.startsWith('--spec=')).map(a => { const v = a.slice(7); const i = v.indexOf(':'); return [v.slice(0, i).trim(), v.slice(i + 1).trim()] }))
const LOG = path.join(__dirname, '..', '_tmp_fix_options_log.jsonl')
const P = '/v2/providers/seller_api/apis/api/v1/marketplace'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const okCode = b => b?.code === 'SUCCESS' || b?.code === 200

async function api(m, p, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
    const sig = crypto.createHmac('sha256', SK).update(dt + m + p).digest('hex')
    const r = await fetch(`${HOST}${p}`, { method: m, headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${AK}, signed-date=${dt}, signature=${sig}`, 'Content-Type': 'application/json;charset=UTF-8' }, body: body ? JSON.stringify(body) : undefined })
    if (r.status === 429 && attempt === 0) { await sleep(10000); continue }
    const t = await r.text()
    try { return { status: r.status, body: JSON.parse(t) } } catch { return { status: r.status, body: t } }
  }
}
const metaCache = new Map()
async function categoryAttrs(code) {
  if (metaCache.has(code)) return metaCache.get(code)
  let attrs = null
  const f = path.join(__dirname, '..', '_tmp_meta_cache', `${Number(code)}_raw.json`)
  if (existsSync(f)) { try { attrs = JSON.parse(readFileSync(f, 'utf8')).attributes ?? null } catch { attrs = null } }
  if (!attrs) attrs = (await api('GET', `${P}/meta/category-related-metas/display-category-codes/${Number(code)}`)).body?.data?.attributes ?? []
  metaCache.set(code, attrs)
  return attrs
}

// 이 도구가 다시 만드는 구매옵션 속성 — 나머지(검색용 속성 등)는 값이 있으면 보존
const MANAGED = new Set(['개당 캡슐/정', '개당 중량', '개당 용량', '최소 중량', '최소 용량', '개당 수량', '수량', '총 수량'])
const GROUP_ALL = ['개당 캡슐/정', '개당 중량', '개당 용량', '최소 중량', '최소 용량']
const shownLabel = attrs => (attrs ?? []).filter(a => a.exposed === 'EXPOSED' && String(a.attributeValueName ?? '').trim()).map(a => String(a.attributeValueName).trim()).join(' · ')
const bundleN = it => { const m = /-(\d+)$/.exec(String(it.externalVendorSku ?? '')); return m ? +m[1] : (+it.unitCount > 0 ? +it.unitCount : 1) }

// ── 대상 ──
let ids = (argOf('ids') || '').split(',').map(s => s.trim()).filter(Boolean)
const auditOrders = new Map()
if (argOf('audit')) {
  const verdicts = new Set((argOf('verdicts') || 'HIGH').split(','))
  let rows
  try { rows = JSON.parse(readFileSync(argOf('audit'), 'utf8')) } catch (e) { console.error(`점검 json 읽기 실패: ${e.message}`); process.exit(1) }
  for (const r of rows) auditOrders.set(String(r.sellerProductId), r.orders90d ?? 0)
  ids.push(...rows.filter(r => verdicts.has(r.verdict)).map(r => String(r.sellerProductId)))
}
ids = [...new Set(ids)].filter(id => !EXCLUDE.has(id))
if (LIMIT) ids = ids.slice(0, LIMIT)
if (!ids.length) { console.error('대상 없음 — --ids= 또는 --audit= 필요'); process.exit(1) }

console.log(`=== 구매옵션 정정 ${APPLY ? 'APPLY' : 'DRY'} · ${ids.length}건${SKIP_ORDERS_OVER != null ? ` · 90일 주문 ${SKIP_ORDERS_OVER}건 초과 보류` : ''} ===`)
const sum = { fixed: 0, approved: 0, pending: 0, rejected: 0, same: 0, skip: 0, fail: 0 }
const held = []
const rebuildNeeded = []   // 옛 옵션 구조라 수정으로 못 고치는 상품 — 재등록 대상
for (const id of ids) {
  const got = await api('GET', `${P}/seller-products/${id}`)
  const d = got.body?.data
  if (!d) { console.log(`${id} ✗ 조회 실패 HTTP ${got.status}`); sum.fail++; continue }
  const tag = `${id} ${String(d.sellerProductName).slice(0, 34)}`
  if (!/승인완료/.test(d.statusName ?? '')) { console.log(`${tag} ⏭ 판매중(승인완료) 아님 — ${d.statusName}`); sum.skip++; continue }
  if (SKIP_ORDERS_OVER != null && (auditOrders.get(id) ?? 0) > SKIP_ORDERS_OVER) { console.log(`${tag} ⏸ 90일 주문 ${auditOrders.get(id)}건 — 보류(판매 상품은 사람 확인 후)`); held.push(id); sum.skip++; continue }

  const attrs = await categoryAttrs(d.displayCategoryCode)
  const itemSpec = it => parseSpec(String(it.itemName ?? '').replace(/(^|\s)0\s*(g|ml)(?![a-z])/gi, '$1'))
  // 상품명 규격이 우선. 상품명에 낱개 중량·용량이 없으면(예 "…, 30포") 판매자 옵션명("2g 1박스")의 값을 보충한다
  const specFor = it => {
    if (SPEC.has(id)) return parseSpec(SPEC.get(id))
    const byName = parseSpec(d.sellerProductName), byItem = itemSpec(it)
    if (byName && byName.weightG == null && byName.volumeMl == null && byItem) return { ...byName, weightG: byItem.weightG, volumeMl: byItem.volumeMl }
    return byName ?? byItem
  }
  // 쿠팡은 이미 노출된 옵션 축을 빼는 수정을 거부하고("필수 옵션(개당 캡슐/정) 입력되지 않았습니다"), 새 축을 더하는 건 받는다
  // (2026-09-27 실측). → 노출 중인 그룹 축이 하나면 그 축으로만 표현, 없으면 규격에 맞는 축을 더한다, 둘 이상이면 수정 불가.
  const buildFor = (it, alsoTotalQty) => {
    const shownAxes = (it.attributes ?? []).filter(a => a.exposed === 'EXPOSED' && String(a.attributeValueName ?? '').trim()).map(a => a.attributeTypeName)
    const shownGroup = shownAxes.filter(n => GROUP_ALL.includes(n))
    if (!specFor(it)) return { error: '규격 모름 — 상세페이지에서 실제 정 수·중량·용량 확인 후 --spec 으로 지정', rebuild: false }
    if (shownGroup.length > 1) return { error: `${shownGroup.join('·')} 축이 함께 노출된 옛 구조 — 쿠팡이 축 삭제를 막아 수정으로는 정확히 못 고침(재등록 필요)`, rebuild: true }
    const axisAttrs = shownGroup.length === 1 ? attrs.filter(a => !GROUP_ALL.includes(a.attributeTypeName) || a.attributeTypeName === shownGroup[0]) : attrs
    const opt = buildPurchaseOptions(axisAttrs, specFor(it), bundleN(it), { sendEmpty: false, alsoTotalQty: alsoTotalQty || shownAxes.includes('총 수량') })
    // 축이 하나면 그 축의 값(한 알 무게·총중량·회분 수 등)만 알면 고칠 수 있다 → 재등록이 아니라 규격 확인 대상
    if (opt.error) return { error: shownGroup.length === 1 ? `노출 중인 '${shownGroup[0]}' 축에 넣을 값 필요 — ${opt.error}` : opt.error, rebuild: false }
    // 노출 중이던 수량류 축이 빠지면 같은 값으로 채운다(수량·총 수량이 둘 다 노출된 옛 등록분)
    const names = new Set(opt.attributes.map(a => a.attributeTypeName))
    const qtyVal = opt.attributes.find(a => a.attributeTypeName === '수량' || a.attributeTypeName === '총 수량')?.attributeValueName
    const extra = []
    for (const n of shownAxes) {
      if (names.has(n) || !MANAGED.has(n)) continue
      if ((n === '수량' || n === '총 수량') && qtyVal) extra.push({ attributeTypeName: n, attributeValueName: qtyVal, exposed: 'EXPOSED' })
      else return { error: `노출 중인 '${n}' 축을 유지할 값이 없음`, rebuild: true }
    }
    const kept = (it.attributes ?? []).filter(a => !MANAGED.has(a.attributeTypeName) && String(a.attributeValueName ?? '').trim())
      .map(a => ({ attributeTypeName: a.attributeTypeName, attributeValueName: a.attributeValueName, exposed: a.exposed }))
    // 노출 여부는 기존 축 그대로 — 새로 넣은 축은 쿠팡이 NONE 으로 저장한다(2026-09-27 실측: 개당 중량 3g EXPOSED 로 보냈지만 NONE).
    // 숨은 값도 바로잡는 의미는 있다(옛 등록분의 "0 g"·"30 회분" → 실제 규격)
    const managed = [...opt.attributes, ...extra].map(a => ({ ...a, exposed: shownAxes.includes(a.attributeTypeName) ? 'EXPOSED' : 'NONE' }))
    return { attributes: [...managed, ...kept], itemName: opt.itemName }
  }
  const plan = []
  let err = null, rebuild = false
  for (const it of d.items ?? []) {
    const b = buildFor(it, false)
    if (b.error) { err = `${it.itemName}: ${b.error}`; rebuild = !!b.rebuild; break }
    plan.push({ it, attributes: b.attributes, itemName: b.itemName, before: shownLabel(it.attributes), after: shownLabel(b.attributes) })
  }
  if (err) { console.log(`${tag} ⏭ ${rebuild ? '수정 불가' : '규격 확인 필요'} — ${err}`); if (rebuild) rebuildNeeded.push(id); sum.skip++; continue }
  const changed = plan.filter(x => x.before !== x.after || x.it.itemName !== x.itemName)
  console.log(`${tag}\n    ${plan.map(x => `[${x.before || '(노출 없음)'}] → [${x.after}]`).join('  ·  ')}`)
  if (!changed.length) { console.log('    이미 정상 — 건너뜀'); sum.same++; continue }
  if (!APPLY) continue

  for (const x of plan) { x.it.attributes = x.attributes; x.it.itemName = x.itemName }
  d.sellerProductId = Number(id)
  let up = await api('PUT', `${P}/seller-products`, d)
  // 옛 등록분은 '총 수량'을 요구하는 경우가 있다(노출 여부와 무관) — 한 번만 넣어서 재시도
  if (!(up.status === 200 && okCode(up.body)) && /총 수량/.test(JSON.stringify(up.body))) {
    for (const x of plan) { const b = buildFor(x.it, true); if (!b.error) x.it.attributes = b.attributes }
    up = await api('PUT', `${P}/seller-products`, d)
  }
  const entry = { at: new Date().toISOString(), sellerProductId: id, name: d.sellerProductName, changes: plan.map(x => ({ vendorItemId: x.it.vendorItemId, before: x.before, after: x.after })), put: { status: up.status, body: typeof up.body === 'object' ? { code: up.body?.code, message: up.body?.message } : String(up.body).slice(0, 200) } }
  if (!(up.status === 200 && okCode(up.body))) {
    console.log(`    ✗ PUT 실패 ${up.status} ${JSON.stringify(up.body).slice(0, 200)}`)
    appendFileSync(LOG, JSON.stringify(entry) + '\n'); sum.fail++; continue
  }
  sum.fixed++
  await sleep(8000)
  // PUT 반영이 늦으면 "'임시저장' 상태의 상품만 승인 요청 가능합니다"로 거절된다 → 잠시 뒤 재시도(2026-09-27 알부민 6박스 실측 — 임시저장 방치)
  let ap
  for (let attempt = 0; attempt < 4; attempt++) {
    ap = await api('PUT', `${P}/seller-products/${id}/approvals`)
    if (!/임시저장.*상태.*상품만/.test(ap?.body?.message ?? '')) break
    await sleep(5000)
  }
  let st = ''
  for (let k = 0; k < 6; k++) {
    await sleep(k ? 10000 : 3000)
    st = (await api('GET', `${P}/seller-products/${id}`)).body?.data?.statusName ?? ''
    if (st === '승인완료' || /반려/.test(st)) break
    // 승인요청 시점엔 PUT 이 덜 반영돼 거절됐고 그 뒤 임시저장이 된 경우 — 지금 다시 요청(2026-09-27 복분자 70g 실측)
    if (/임시저장/.test(st)) ap = await api('PUT', `${P}/seller-products/${id}/approvals`)
  }
  const status = st === '승인완료' ? 'APPROVED' : /임시저장/.test(st) ? 'TEMPORARY_SAVE' : /반려/.test(st) ? 'REJECTED' : 'PENDING_APPROVAL'
  if (status === 'APPROVED') sum.approved++; else if (status === 'REJECTED') sum.rejected++; else sum.pending++
  entry.approval = { request: ap?.status === 200 && okCode(ap?.body) ? 'OK' : JSON.stringify(ap?.body).slice(0, 120), status: st }
  appendFileSync(LOG, JSON.stringify(entry) + '\n')
  const { error: dbErr } = await sb.from('jimscanner_coupang_listings').update({ status, approval_status_name: st || null, ...(status === 'REJECTED' ? { rejection_reason: `옵션 정정 후 재승인 반려(${st}) — Wing 사유 확인` } : {}), last_synced_at: new Date().toISOString() }).eq('seller_product_id', Number(id))
  console.log(`    ✓ PUT → 승인요청 ${entry.approval.request === 'OK' ? 'OK' : entry.approval.request} → 현재 '${st}'${dbErr ? ` (DB 반영 실패: ${dbErr.message})` : ''}`)
  await sleep(600)
}
console.log(`\n=== 완료 === 정정 ${sum.fixed}(재승인 ${sum.approved} · 심사중 ${sum.pending} · 반려 ${sum.rejected}) · 이미정상 ${sum.same} · 건너뜀 ${sum.skip} · 실패 ${sum.fail}${APPLY ? '' : ' (dry — 적용하려면 --apply)'}`)
if (held.length) console.log(`판매 실적 있어 보류: ${held.join(',')}`)
if (rebuildNeeded.length) console.log(`수정으로 못 고침(재등록 필요): ${rebuildNeeded.join(',')}`)
