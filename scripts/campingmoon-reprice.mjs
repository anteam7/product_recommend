#!/usr/bin/env node
/**
 * 캠핑문 등록 상품 가격 재계산 — 캠핑문 가격 변동(인상 공지 잦음)·쿠팡 시세 변동을 쿠팡 vendorItem·토스 stock 가격에 반영. docs/plan-campingmoon.md P6 (2026-10-14)
 *   node scripts/campingmoon-reprice.mjs --dry            # 변경 대상만 출력
 *   node scripts/campingmoon-reprice.mjs [--only=4385,…] [--collect]   # --collect: campingmoon-collect.mjs 먼저 실행(가격·품절 최신화)
 *
 * 규칙: 옵션(jimscanner_listing_items)마다 decide(옵션가, market_low)[pack_qty] → 새 가격. 하한(floor) 아래로는 절대 내리지 않는다(MSP 하한 정책과 같은 취지).
 *       시세가 하한 아래(STRUCTURAL)면 가격을 건드리지 않고 보고만(판매중지는 사람이 판단). 변동 ±10원 이내는 무시.
 *       쿠팡: PUT /vendor-items/{id}/prices/{price}?forceSalePriceAddUp=true (리스팅 강등 없음). 토스: origin ≥ sale 제약 → origin 먼저 올리고 sale.
 *       DB: listing_items.sale_price·cost_price, coupang_listings(첫 item 기준 list_price_krw·msp_price_krw=floor·dome_price_krw), toss_listings.sale_price.
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import { decide, DISCOUNT_BASE, COUPANG_FEE } from './lib/campingmoon-price.mjs'
import { tossPriceFromCoupang } from './lib/toss-price.mjs'
import { tossSetSalePrice, tossSetOriginPrice } from './lib/toss-api.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const has = (k) => process.argv.includes(`--${k}`)
const DRY = has('dry')
const ONLY = new Set(arg('only', '').split(',').map((s) => s.trim()).filter(Boolean))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (has('collect')) { console.log('▶ campingmoon-collect.mjs'); execFileSync(process.execPath, [path.join(__dirname, 'campingmoon-collect.mjs')], { stdio: 'inherit', cwd: path.join(__dirname, '..') }) }

function sign(method, urlPath, query = '') { const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'; return { datetime: dt, signature: crypto.createHmac('sha256', env.COUPANG_SECRET_KEY).update(dt + method + urlPath + query).digest('hex') } }
async function coupangApi(method, urlPath, query = '') {
  const { datetime, signature } = sign(method, urlPath, query)
  const res = await fetch(`${env.COUPANG_API_HOST}${urlPath}${query ? '?' + query : ''}`, { method, headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${env.COUPANG_ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`, 'Content-Type': 'application/json;charset=UTF-8' }, signal: AbortSignal.timeout(60_000) })
  const t = await res.text(); try { return { status: res.status, body: JSON.parse(t) } } catch { return { status: res.status, body: t } }
}
async function fetchAll(build) { const PAGE = 1000, out = []; for (let from = 0; ; from += PAGE) { const { data, error } = await build().range(from, from + PAGE - 1); if (error) throw new Error(error.message); out.push(...(data ?? [])); if ((data ?? []).length < PAGE) return out } }

const items = await fetchAll(() => sb.from('jimscanner_listing_items').select('*').eq('source', 'campingmoon').neq('status', 'REMOVED').not('market_item_id', 'is', null).order('id'))
const goods = [...new Set(items.map((i) => i.goods_no))].filter((g) => !ONLY.size || ONLY.has(g))
if (!env.COUPANG_SECRET_KEY || !env.COUPANG_ACCESS_KEY || !env.COUPANG_API_HOST) { console.error('COUPANG_* 환경변수 없음'); process.exit(1) }
// .in() 은 URL 길이 한계 → 200개씩
const inChunks = async (table, sel, col, vals, order) => { const out = []; for (let i = 0; i < vals.length; i += 200) out.push(...await fetchAll(() => sb.from(table).select(sel).in(col, vals.slice(i, i + 200)).order(order))); return out }
const products = new Map((await inChunks('jimscanner_campingmoon_products', 'product_no, name_clean, sale_price, soldout, status, market_low, market_count', 'product_no', goods, 'product_no')).map((p) => [p.product_no, p]))
const cmItems = new Map((await inChunks('jimscanner_campingmoon_items', 'item_code, product_no, option_price, add_price, is_selling', 'product_no', goods, 'item_code')).map((i) => [i.item_code, i]))
console.log(`${DRY ? '[DRY] ' : ''}대상 옵션 ${items.filter((i) => goods.includes(i.goods_no)).length}건 (상품 ${goods.length}) · 할인기준 ${DISCOUNT_BASE} · 수수료 ${(COUPANG_FEE * 100).toFixed(1)}%`)

let changed = 0, same = 0, structural = 0, skipped = 0, failed = 0
const touchedListings = new Map() // listing_key → { list_price, floor, cost } (첫 item 기준)
for (const li of items) {
  if (!goods.includes(li.goods_no)) continue
  const p = products.get(li.goods_no), ci = li.item_code ? cmItems.get(li.item_code) : null
  const label = `${li.market} ${li.goods_no}:${li.item_code || '-'} x${li.pack_qty} ${(p?.name_clean || '').slice(0, 22)}`
  if (!p || p.status !== 'active') { skipped++; console.log(`  - ${label} | 상품 없음/gone`); continue }
  const unit = ci?.option_price || ((p.sale_price || 0) + (ci?.add_price || 0))
  if (!unit) { skipped++; console.log(`  - ${label} | 옵션가 없음`); continue }
  const d = decide(unit, p.market_low)[li.pack_qty - 1]
  if (!d) { skipped++; continue }
  if (d.verdict === 'STRUCTURAL') { structural++; console.log(`  ⚠ ${label} | 시세 ${p.market_low} < 하한 ${d.floor} (현재 ${li.sale_price}) — 가격 유지, 판매 유지 여부는 사람이`); continue }
  const target = li.market === 'toss' ? tossPriceFromCoupang(d.price, 'campingmoon') : d.price
  const floor = li.market === 'toss' ? tossPriceFromCoupang(d.floor, 'campingmoon') : d.floor
  const current = li.sale_price || 0
  if (Math.abs(target - current) < 10) { same++; continue }
  const line = `${label} ${String(current).padStart(7)} → ${String(target).padStart(7)} (캠핑문 ${unit}, 원가 ${d.cost}, 하한 ${floor}, 시세 ${p.market_low ?? '-'})`
  if (target < floor) { skipped++; console.log(`  ✗ ${line} | 목표가가 하한 아래(계산 오류) — 건너뜀`); continue }
  if (DRY) { console.log('  ' + line); changed++; continue }
  try {
    if (li.market === 'coupang') {
      const r = await coupangApi('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${li.market_item_id}/prices/${target}`, 'forceSalePriceAddUp=true')
      if (!(r.status === 200 && r.body?.code === 'SUCCESS')) { failed++; console.log(`  ✗ ${line} | 쿠팡 ${JSON.stringify(r.body).slice(0, 100)}`); continue }
      if (li.pack_qty === 1 && !touchedListings.has(li.listing_key)) touchedListings.set(li.listing_key, { list_price_krw: target, msp_price_krw: d.floor, dome_price_krw: d.cost })
    } else {
      const { data: tl } = await sb.from('jimscanner_toss_listings').select('origin_price').eq('toss_product_id', Number(li.listing_key)).maybeSingle()
      if (!tl) { skipped++; console.log(`  - ${line} | toss_listings 행 없음`); continue }
      const prevOrigin = tl.origin_price || 0, origin = Math.max(prevOrigin, target)
      if (origin !== prevOrigin) { const ro = await tossSetOriginPrice(Number(li.listing_key), Number(li.market_item_id), origin); if (!ro.ok) { failed++; console.log(`  ✗ ${line} | 토스 origin ${JSON.stringify(ro.error).slice(0, 80)}`); continue } }
      let rs
      try { rs = await tossSetSalePrice(Number(li.listing_key), Number(li.market_item_id), target) } catch (e) { rs = { ok: false, error: String(e.message) } }
      if (!rs.ok) { // 정가는 올렸는데 판매가 실패(응답 오류·예외 모두) → 정가 되돌려 토스·DB 불일치 방지(toss-reprice 와 동일)
        failed++; console.log(`  ✗ ${line} | 토스 sale ${JSON.stringify(rs.error).slice(0, 80)}`)
        if (origin !== prevOrigin && prevOrigin) { const back = await tossSetOriginPrice(Number(li.listing_key), Number(li.market_item_id), prevOrigin).catch(() => ({ ok: false })); console.log(`    ↩ origin 되돌림 ${prevOrigin}: ${back.ok ? 'OK' : '실패'}`) }
        continue
      }
      const { error: te } = await sb.from('jimscanner_toss_listings').update({ sale_price: target, origin_price: origin, updated_at: new Date().toISOString() }).eq('toss_product_id', Number(li.listing_key))
      if (te) console.log(`    ⚠ toss_listings 갱신 실패: ${te.message}`)
    }
    const { error: ue } = await sb.from('jimscanner_listing_items').update({ sale_price: target, cost_price: d.cost, updated_at: new Date().toISOString() }).eq('id', li.id)
    if (ue) { failed++; console.log(`  ⚠ ${line} | 마켓 반영됨, listing_items 갱신 실패: ${ue.message}`); continue }
    changed++; console.log('  ✓ ' + line)
  } catch (e) { failed++; console.log(`  ✗ ${line} | 예외 ${String(e.message).slice(0, 100)}`) }
  await sleep(200)
}
if (!DRY) for (const [spid, u] of touchedListings) { const { error } = await sb.from('jimscanner_coupang_listings').update({ ...u, updated_at: new Date().toISOString() }).eq('seller_product_id', Number(spid)); if (error) { failed++; console.log(`  ⚠ listings ${spid} 대표가 갱신 실패: ${error.message}`) } }
console.log(`\n변경 ${changed} · 동일 ${same} · STRUCTURAL ${structural} · 건너뜀 ${skipped} · 실패 ${failed}`)
if (failed) process.exitCode = 1
