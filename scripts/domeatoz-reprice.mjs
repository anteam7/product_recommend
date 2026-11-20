#!/usr/bin/env node
/**
 * 도매아토즈 등록 상품 가격을 시세 규칙으로 맞춤 — 사장님 2026-11-20 "10%는 최소마진, 더 높일 수 있으면 높여도 돼".
 *   node scripts/domeatoz-reprice.mjs --checked-since=2026-11-20 [--dry] [--allow-lower]
 *   node scripts/domeatoz-reprice.mjs --only=2833436,2559192 [--dry]
 *
 * 대상: jimscanner_domeatoz_products 중 시세(market_low)가 --checked-since 이후 기록된 것(또는 --only) × 쿠팡 리스팅(단일 item, 승인돼 vendorItemId 있음).
 * 새 가격 = lib/domeatoz-price decide(도매가, 배송비, [market_low]).price = 같은 규격 쿠팡 최저가 −1,000원(하한 = 순마진 10%·2,000원).
 *   - 기본은 올리기만(--allow-lower 로 내리기도) · ±10원 이내 무시 · STRUCTURAL(시세가 하한 밑)은 건드리지 않고 보고.
 *   - 옛 시세(2026-10-26 domeatoz-market.mjs)로 일괄 변경하지 않게 --checked-since 나 --only 가 꼭 있어야 한다.
 * 쿠팡: PUT /vendor-items/{id}/prices/{price}?forceSalePriceAddUp=true (가격만 — 판매중 상품 임시저장 강등 없음).
 * DB: coupang_listings.list_price_krw·msp_price_krw(=하한)·estimated_*.
 * 승인 전(vendorItemId 없음)은 건너뛰므로 매시 기동기(_workspace/sched/start-register-drip.ps1)에서 반복 실행해도 된다.
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { decide, COUPANG_FEE } from './lib/domeatoz-price.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const ACCESS_KEY = env.COUPANG_ACCESS_KEY, SECRET_KEY = env.COUPANG_SECRET_KEY, HOST = env.COUPANG_API_HOST
const P = '/v2/providers/seller_api/apis/api/v1/marketplace'
const argv = process.argv.slice(2)
const arg = (k) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null }
const DRY = argv.includes('--dry'), ALLOW_LOWER = argv.includes('--allow-lower')
const ONLY = (arg('only') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const SINCE = arg('checked-since')
if ((!ONLY.length && !SINCE) || (SINCE && Number.isNaN(Date.parse(SINCE))) || ONLY.some((s) => !/^\d{1,9}$/.test(s))) {
  console.error('사용법: --checked-since=YYYY-MM-DD 또는 --only=idx,… [--dry] [--allow-lower]'); process.exit(64)
}
if (!ACCESS_KEY || !SECRET_KEY || !HOST) { console.error('.env.local 에 COUPANG_ACCESS_KEY/SECRET_KEY/API_HOST 없음'); process.exit(1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function sign(method, urlPath, query) { const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'; return { dt, sig: crypto.createHmac('sha256', SECRET_KEY).update(dt + method + urlPath + query).digest('hex') } }
async function api(method, urlPath, query = '', retried = false) {
  const { dt, sig } = sign(method, urlPath, query)
  let res
  try {
    res = await fetch(`${HOST}${urlPath}${query ? `?${query}` : ''}`, { method, headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${dt}, signature=${sig}`, 'Content-Type': 'application/json;charset=UTF-8' }, signal: AbortSignal.timeout(60_000) })
  } catch (e) { return { status: 0, body: { message: e.message } } }
  if (res.status === 429 && !retried) { await sleep(10000); return api(method, urlPath, query, true) }
  const t = await res.text()
  try { return { status: res.status, body: JSON.parse(t) } } catch { return { status: res.status, body: t } }
}

// ── 대상 ──
let q = sb.from('jimscanner_domeatoz_products').select('idx, name_clean, wholesale_price, delivery_price, market_low, market_checked_at').not('market_low', 'is', null)
q = ONLY.length ? q.in('idx', ONLY) : q.gte('market_checked_at', new Date(SINCE).toISOString())
const { data: prods, error: pe } = await q
if (pe) { console.error('상품 조회 실패:', pe.message); process.exit(1) }
if (!prods.length) { console.log('대상 없음'); process.exit(0) }
const byIdx = new Map(prods.map((p) => [String(p.idx), p]))
const { data: lists, error: le } = await sb.from('jimscanner_coupang_listings').select('id, source_goods_no, seller_product_id, status, list_price_krw').eq('source', 'domeatoz').in('source_goods_no', [...byIdx.keys()]).not('seller_product_id', 'is', null)
if (le) { console.error('리스팅 조회 실패:', le.message); process.exit(1) }

console.log(`=== 도매아토즈 시세 가격 맞춤 ${DRY ? '[DRY] ' : ''}${ALLOW_LOWER ? '[내리기 포함] ' : '[올리기만] '}· 상품 ${prods.length} · 리스팅 ${lists.length} ===`)
const tally = { changed: 0, same: 0, lowerSkipped: 0, structural: 0, waiting: 0, multi: 0, failed: 0 }
for (const l of lists) {
  const p = byIdx.get(String(l.source_goods_no))
  if (['FAILED', 'STOPPED', 'DELETED'].includes(l.status)) continue
  const d = decide(p.wholesale_price, p.delivery_price, [p.market_low])
  const tag = `${l.source_goods_no} ${String(p.name_clean).slice(0, 28).padEnd(28)}`
  if (d.verdict !== 'OK') { tally.structural++; console.log(`  · ${tag} 시세 ${p.market_low} → ${d.verdict}(하한 ${d.floor}) — 그대로`); continue }
  const cur = Number(l.list_price_krw) || 0
  if (Math.abs(d.price - cur) <= 10) { tally.same++; continue }
  if (d.price < cur && !ALLOW_LOWER) { tally.lowerSkipped++; console.log(`  · ${tag} ${cur} → ${d.price} 내림 — 건너뜀(--allow-lower)`); continue }
  const g = await api('GET', `${P}/seller-products/${l.seller_product_id}`)
  const items = g.body?.data?.items ?? []
  if (g.status !== 200) { tally.failed++; console.log(`  ✗ ${tag} 상품 조회 HTTP ${g.status} ${JSON.stringify(g.body).slice(0, 100)}`); continue }
  if (items.length !== 1) { tally.multi++; console.log(`  · ${tag} item ${items.length}개 — 옵션 상품은 대상 아님`); continue }
  const vid = items[0].vendorItemId
  if (!vid) { tally.waiting++; continue } // 승인 전
  const net = Math.round(d.net), pct = +(d.margin * 100).toFixed(2)
  if (DRY) { tally.changed++; console.log(`  ↑ ${tag} ${cur} → ${d.price} (쿠팡 최저 ${p.market_low} · 순마진 ${pct}%) [dry]`); continue }
  const r = await api('PUT', `${P}/vendor-items/${vid}/prices/${d.price}`, 'forceSalePriceAddUp=true')
  if (r.status !== 200 || r.body?.code !== 'SUCCESS') { tally.failed++; console.log(`  ✗ ${tag} 가격 변경 실패 HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 140)}`); await sleep(1000); continue }
  const { error: ue } = await sb.from('jimscanner_coupang_listings').update({ list_price_krw: d.price, msp_price_krw: d.floor, estimated_fee_krw: Math.round(d.price * COUPANG_FEE), estimated_margin_krw: net, estimated_margin_pct: pct }).eq('id', l.id)
  tally.changed++
  console.log(`  ${d.price > cur ? '↑' : '↓'} ${tag} ${cur} → ${d.price} (쿠팡 최저 ${p.market_low} · 순마진 ${pct}%)${ue ? ` ⚠ DB 기록 실패: ${ue.message}` : ''}`)
  await sleep(1000)
}
console.log(`변경 ${tally.changed} · 그대로 ${tally.same} · 승인 대기 ${tally.waiting} · 내림 건너뜀 ${tally.lowerSkipped} · 시세가 하한 밑 ${tally.structural} · 옵션 상품 ${tally.multi} · 실패 ${tally.failed}`)
