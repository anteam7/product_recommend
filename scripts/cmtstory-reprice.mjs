/**
 * 화장품스토리 판매가 → 쿠팡 반영(인상만) — jimscanner_cmtstory_products.sale_prices[N].price 와 쿠팡 vendor item 의 현재 salePrice 를 비교해
 * 올라간 것만 vendor-item 가격변경 API(PUT /vendor-items/{id}/prices/{price}, 리스팅 강등 없음)로 반영한다.
 *   node scripts/cmtstory-reprice.mjs [--apply] [--qty=1,2,3] [--only=goods_no,…] [--limit=N]
 * - 기본 dry-run. --apply 로만 실제 호출. 기본 수량은 1(2026-10-09 1개 절대마진 하한 2,000원 도입분 반영용 — cmtstory-collect.mjs MIN_ABS_MARGIN).
 * - 인하는 하지 않는다(시세 대응은 pricewatch 소관). 목표가가 수량별 절대준수가(MSP) 아래면 중단([[price_msp_floor_policy]]).
 * - 변형 매칭은 등록 시 넣은 externalVendorSku `${goods_no}-${qty}` → 없으면 unitCount → 옵션명 끝 "N개/N세트" (cmtstory-register.mjs).
 *   승인완료(APPROVED)만 대상 — 심사중은 가격변경이 막히니 승인 후 다시 돌린다.
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const HOST = env.COUPANG_API_HOST || 'https://api-gateway.coupang.com', ACCESS_KEY = env.COUPANG_ACCESS_KEY, SECRET_KEY = env.COUPANG_SECRET_KEY
const PRODUCTS = 'jimscanner_cmtstory_products', LISTINGS = 'jimscanner_coupang_listings'

const args = process.argv.slice(2)
const argOf = k => args.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')
const APPLY = args.includes('--apply')
const QTYS = (argOf('qty') || '1').split(',').map(s => +s).filter(n => [1, 2, 3].includes(n))
if (!QTYS.length) { console.error('--qty 는 1,2,3 중에서'); process.exit(1) }
if (!ACCESS_KEY || !SECRET_KEY) { console.error('COUPANG_ACCESS_KEY/SECRET_KEY 없음'); process.exit(1) }
const ONLY = new Set((argOf('only') || '').split(',').map(s => s.trim()).filter(Boolean))
const LIMIT = +(argOf('limit') || 0) || 0
const sleep = ms => new Promise(s => setTimeout(s, ms))

function sign(method, urlPath, query = '') {
  const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  return { datetime: dt, signature: crypto.createHmac('sha256', SECRET_KEY).update(dt + method + urlPath + query).digest('hex') }
}
async function api(method, urlPath, query = '', retried = false) {
  const { datetime, signature } = sign(method, urlPath, query)
  const res = await fetch(`${HOST}${urlPath}${query ? `?${query}` : ''}`, { method, headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`, 'Content-Type': 'application/json;charset=UTF-8' } })
  if (res.status === 429 && !retried) { console.log('  ⏳ 429 — 10초 대기 후 재시도'); await sleep(10000); return api(method, urlPath, query, true) }
  const t = await res.text()
  try { return { status: res.status, body: JSON.parse(t) } } catch { return { status: res.status, body: t } }
}
const apiOk = r => r.status === 200 && (r.body?.code === 'SUCCESS' || r.body?.code === 200)

// 대상: 승인완료 cmtstory 리스팅 + 상품 판매가
let lq = sb.from(LISTINGS).select('id, seller_product_id, source_goods_no, list_price_krw, dome_price_krw, source_shipping_fee_krw').eq('source', 'cmtstory').eq('status', 'APPROVED')
if (ONLY.size) lq = lq.in('source_goods_no', [...ONLY])
const { data: listings, error: lErr } = await lq
if (lErr) { console.error(lErr.message); process.exit(1) }
const { data: products, error: pErr } = await sb.from(PRODUCTS).select('goods_no, title_clean, sale_prices, tiered_msp, msp_price_krw, coupang_fee_rate').in('goods_no', listings.map(l => l.source_goods_no))
if (pErr) { console.error(pErr.message); process.exit(1) }
const prodOf = new Map(products.map(p => [p.goods_no, p]))
const targets = LIMIT ? listings.slice(0, LIMIT) : listings
console.log(`=== 화장품스토리 가격 반영 ${APPLY ? '[APPLY]' : '[DRY-RUN]'} · 수량 ${QTYS.join(',')} · 리스팅 ${targets.length}건 ===\n`)

const stat = { up: 0, same: 0, down: 0, fail: 0, skip: 0 }
for (let i = 0; i < targets.length; i++) {
  const L = targets[i], P = prodOf.get(L.source_goods_no)
  const tag = `${L.source_goods_no} ${(P?.title_clean || '').slice(0, 24).padEnd(24)}`
  if (!P?.sale_prices) { console.log(`  ⏭ ${tag} 판매가 없음`); stat.skip++; continue }
  const g = await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${L.seller_product_id}`)
  const items = g.body?.data?.items
  if (!items?.length) { console.log(`  ✗ ${tag} GET 실패 ${JSON.stringify(g.body).slice(0, 100)}`); stat.fail++; continue }
  for (const qty of QTYS) {
    const sp = P.sale_prices[String(qty)]
    // 변형 매칭: 등록 시 넣은 externalVendorSku `${goods_no}-${qty}` → 없으면 unitCount → 옵션명 끝 "N개/N세트"
    const it = items.find(x => String(x.externalVendorSku ?? x.externalVendorSkuCode ?? '') === `${L.source_goods_no}-${qty}`)
      ?? items.find(x => +x.unitCount === qty)
      ?? items.find(x => +(/(\d+)\s*(개|세트)\s*$/.exec(String(x.itemName || ''))?.[1] ?? 0) === qty)
    if (!sp || !it?.vendorItemId) { console.log(`  ⏭ ${tag} ${qty}개 변형 없음`); stat.skip++; continue }
    const cur = +it.salePrice, target = +sp.price
    const mspN = P.tiered_msp?.[String(qty)] ?? (P.msp_price_krw ? P.msp_price_krw * qty : 0)
    if (target < mspN) { console.log(`  ⛔ ${tag} ${qty}개 목표 ${target} < MSP ${mspN} — 중단`); stat.fail++; continue }
    if (target === cur) { stat.same++; continue }
    if (target < cur) { console.log(`  = ${tag} ${qty}개 ${cur.toLocaleString()} → ${target.toLocaleString()} 인하는 안 함`); stat.down++; continue }
    const line = `${tag} ${qty}개 ${cur.toLocaleString()} → ${target.toLocaleString()} (+${Math.round((target - cur) / cur * 100)}%, 마진 ${sp.margin?.toLocaleString()} ${sp.pct}%, ${sp.basis})`
    if (!APPLY) { console.log(`  [dry] ${line}`); stat.up++; continue }
    const r = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${it.vendorItemId}/prices/${target}`, 'forceSalePriceAddUp=true')
    if (!apiOk(r)) { console.log(`  ✗ ${line} | ${JSON.stringify(r.body).slice(0, 140)}`); stat.fail++; await sleep(400); continue }
    stat.up++
    console.log(`  ✓ ${line}`)
    if (qty === 1) {
      // 리스팅 기록은 1개 기준(list_price_krw = 1개 판매가)
      const fee = Math.round(target * (P.coupang_fee_rate || 0.096))
      const { error: uErr } = await sb.from(LISTINGS).update({ list_price_krw: target, estimated_fee_krw: fee, estimated_margin_krw: sp.margin, estimated_margin_pct: sp.pct, last_synced_at: new Date().toISOString() }).eq('id', L.id)
      if (uErr) console.log(`    ⚠ listings 기록 실패(쿠팡엔 반영됨): ${uErr.message}`)
    }
    await sleep(400)
  }
  await sleep(250)
}
console.log(`\n=== ${APPLY ? '반영' : 'dry'} 인상 ${stat.up} · 동일 ${stat.same} · 인하보류 ${stat.down} · 실패 ${stat.fail} · 건너뜀 ${stat.skip} ===`)
if (!APPLY && stat.up) console.log('실제 반영은 --apply')
