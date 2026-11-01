#!/usr/bin/env node
/**
 * 네이버 스마트스토어 상품 일괄 삭제 — 판매 상품 종류 교체용(사장님 2026-10-30 "유픽·건강산 전부 삭제, 비셀러는 유지").
 *   node scripts/naver-delete-products.mjs --keep-source=beseller [--dry] [--limit=N]
 *   node scripts/naver-delete-products.mjs --all [--dry]          (전부 삭제 — 둘 중 하나는 반드시 줘야 한다)
 *
 *  - 대상 = 네이버 실제 목록(/v1/products/search) 중 jimscanner_naver_listings 에서 keep-source 가 아닌 상품.
 *    DB 추적행이 없는 상품(2026-06-11 유픽 등록분 177건처럼 추적행이 사라진 것)도 대상 — DB 기준으로만 고르면 남는다.
 *  - 진행 중 주문(NAVER_FINAL_STATUSES 밖)이 걸린 상품은 건너뛴다.
 *  - 삭제 전에 원상품 JSON 을 _workspace/naver-backup-<날짜>/<원상품번호>.json 에 저장 — 백업 못 하면 그 상품은 삭제하지 않는다(되돌릴 수 없어서).
 *  - 삭제 후 jimscanner_naver_listings 추적행 제거. 주문 기록(jimscanner_naver_orders)은 그대로 둔다.
 *    네이버엔 없고 DB 에만 남은 keep 밖 추적행도 함께 지운다(재고싱크가 "네이버 목록에 없음"으로 매번 건너뛰지 않게).
 *  비셀러만 지우던 beseller-naver-delete-all.mjs 의 일반화(DB 기준 → 네이버 실제 목록 기준).
 */
import { naverApi } from './lib/naver-api.mjs'
import { NAVER_FINAL_STATUSES } from './lib/naver-order-ops.mjs'
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const args = process.argv.slice(2)
const argOf = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')
const DRY = args.includes('--dry'), ALL = args.includes('--all')
const KEEP = (argOf('keep-source') || '').split(',').map((s) => s.trim()).filter(Boolean)
const LIMIT = +(argOf('limit') || 0) || 0
if (!ALL && !KEEP.length) { console.error('--keep-source=<source,…> 또는 --all 중 하나는 필요(실수로 전부 지우지 않게)'); process.exit(64) }
if (ALL && KEEP.length) { console.error('--all 과 --keep-source 는 함께 쓸 수 없음'); process.exit(64) }
const sleep = (ms) => new Promise((s) => setTimeout(s, ms))
const PAUSE = 350 // 호출 사이 간격(beseller-naver-delete-all.mjs 와 같음)

async function call(method, p, body) {
  for (let t = 1; ; t++) {
    const r = await naverApi(method, p, body)
    if (r.status !== 429 || t >= 4) return r
    await sleep(2000 * t)
  }
}
async function fetchAll(build) { const out = []; for (let from = 0; ; from += 1000) { const { data, error } = await build().range(from, from + 999); if (error) throw new Error(error.message); out.push(...data); if (data.length < 1000) return out } }

// ── 네이버 실제 목록 ──
const live = []
for (let page = 1; ; page++) {
  const r = await call('POST', '/v1/products/search', { page, size: 500 })
  if (r.status !== 200) { console.error(`상품목록 HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`); process.exit(1) }
  const c = r.body?.contents || []
  for (const x of c) live.push({ no: Number(x.originProductNo), name: x.channelProducts?.[0]?.name || '' })
  if (c.length < 500) break
  if (page >= 40) { console.error('상품목록 40페이지(20,000건) 초과 — 중단'); process.exit(1) }
  await sleep(PAUSE)
}

// ── DB 추적행·진행 중 주문 ──
const tracked = await fetchAll(() => sb.from('jimscanner_naver_listings').select('origin_product_no, source').order('origin_product_no'))
const keepNos = new Set(tracked.filter((t) => KEEP.includes(t.source)).map((t) => Number(t.origin_product_no)))
if (KEEP.length && !keepNos.size) { console.error(`keep-source(${KEEP.join(',')}) 추적행이 0건 — 출처 이름 확인(전부 지워질 수 있어 중단)`); process.exit(1) }
const orders = await fetchAll(() => sb.from('jimscanner_naver_orders').select('product_order_id, origin_product_no, product_order_status').order('product_order_id'))
const openNos = new Set(orders.filter((o) => !NAVER_FINAL_STATUSES.has(o.product_order_status)).map((o) => Number(o.origin_product_no)))
const sourceOf = new Map(tracked.map((t) => [Number(t.origin_product_no), t.source]))
const liveNos = new Set(live.map((x) => x.no))

let targets = live.filter((x) => !keepNos.has(x.no))
const blocked = targets.filter((x) => openNos.has(x.no))
targets = targets.filter((x) => !openNos.has(x.no))
if (LIMIT) targets = targets.slice(0, LIMIT)
const ghosts = tracked.filter((t) => !KEEP.includes(t.source) && !liveNos.has(Number(t.origin_product_no)))
const bySource = targets.reduce((m, x) => { const s = sourceOf.get(x.no) || '(추적행 없음)'; m[s] = (m[s] || 0) + 1; return m }, {})

console.log(`=== 네이버 상품 삭제 ${DRY ? '[DRY]' : ''} · ${ALL ? '전부' : `유지 ${KEEP.join(',')}`} ===`)
console.log(`스토어 ${live.length}건 · 유지 ${live.length - targets.length - blocked.length}건 · 삭제 대상 ${targets.length}건`, bySource)
if (blocked.length) console.log(`진행 중 주문으로 건너뜀 ${blocked.length}건: ${blocked.map((x) => x.no).join(',')}`)
console.log(`DB 에만 남은 추적행 정리 ${ghosts.length}건`)
if (DRY) { for (const x of targets.slice(0, 10)) console.log(`  ${x.no} [${sourceOf.get(x.no) || '-'}] ${x.name.slice(0, 40)}`); process.exit(0) }

const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '')
const backupDir = path.join(__dirname, '..', '_workspace', `naver-backup-${day}`)
if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true })
console.log(`백업 → ${backupDir}\n`)

const sum = { deleted: 0, gone: 0, fail: 0, dbFail: 0 }
for (let i = 0; i < targets.length; i++) {
  const x = targets[i], tag = `[${i + 1}/${targets.length}]`
  try {
    const g = await call('GET', `/v2/products/origin-products/${x.no}`)
    await sleep(PAUSE)
    if (g.status === 200) writeFileSync(path.join(backupDir, `${x.no}.json`), JSON.stringify({ source: sourceOf.get(x.no) || null, backedUpAt: new Date().toISOString(), ...g.body }))
    else if (g.status !== 404) { sum.fail++; console.log(`${tag} ✗ ${x.no} 백업 실패 HTTP ${g.status} — 삭제 안 함`); continue }
    const d = g.status === 404 ? g : await call('DELETE', `/v2/products/origin-products/${x.no}`)
    await sleep(PAUSE)
    if (![200, 204, 404].includes(d.status)) { sum.fail++; console.log(`${tag} ✗ ${x.no} 삭제 HTTP ${d.status} ${JSON.stringify(d.body).slice(0, 160)}`); continue }
    if (d.status === 404) sum.gone++; else sum.deleted++
    const { error } = await sb.from('jimscanner_naver_listings').delete().eq('origin_product_no', x.no)
    if (error) { sum.dbFail++; console.log(`${tag} ⚠ ${x.no} 추적행 삭제 실패: ${error.message}`) }
    console.log(`${tag} ✓ ${x.no} [${sourceOf.get(x.no) || '-'}] ${x.name.slice(0, 30)} HTTP ${d.status}`)
  } catch (e) { sum.fail++; console.log(`${tag} ✗ ${x.no} ERROR ${e.message}`) }
}
for (const t of ghosts) {
  const { error } = await sb.from('jimscanner_naver_listings').delete().eq('origin_product_no', t.origin_product_no)
  if (error) { sum.dbFail++; console.log(`⚠ 추적행 ${t.origin_product_no} 삭제 실패: ${error.message}`) }
}
console.log(`\n=== 삭제 ${sum.deleted} · 이미 없음 ${sum.gone} · 실패 ${sum.fail} · DB 실패 ${sum.dbFail} · 추적행 정리 ${ghosts.length} ===`)
if (sum.fail || sum.dbFail) process.exitCode = 1
