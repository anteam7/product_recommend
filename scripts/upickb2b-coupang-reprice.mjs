/**
 * 유픽 매입가·최저판매가(MSP) 변동 → 쿠팡 판매가 반영 (전체 점검·수동 반영용 CLI).
 *   node scripts/upickb2b-coupang-reprice.mjs [--apply] [--lower] [--only=4046,4112] [--fresh-hours=24]
 *
 * 평소엔 재고싱크 크론(local-cron-stock-sync.mjs 5단계)이 매시 인상분을 자동 반영한다 — 이 CLI 는 전수 점검·인하 검토용.
 * 선행: upickb2b-collect.mjs 로 카탈로그 최신화. last_seen_at 이 fresh-hours 보다 오래된 상품은 STALE 로 건너뛴다
 *       (수집기는 품절 상품을 건너뛰므로 품절 리스팅은 `upickb2b-collect.mjs --only=<no,...>` 로 따로 갱신).
 * 가격 규칙·분류는 lib/upick-price-sync.mjs:
 *   RAISE   라이브 < MSP 또는 손익분기 → --apply 시 목표가(max(MSP,손익분기))로 인상
 *   LOWER   라이브 > 목표 (공급가·MSP 인하) → --apply --lower 일 때만 인하
 *   OK      그 사이 — --apply 시 DB 매입가·MSP만 최신화
 *   BANNED  유픽이 오픈마켓·쿠팡 판매금지로 전환 → 가격 안 건드림(판매중지 대상, 보고만)
 *   REVIEW  옵션 여러 개·MSP 사라짐·(수동 리스팅) 수량 파싱 불가·묶음 → 자동 반영 안 함
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { coupangClient, repriceCoupangListing, loadUpickProducts } from './lib/upick-price-sync.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const api = coupangClient({ host: env.COUPANG_API_HOST || 'https://api-gateway.coupang.com', accessKey: env.COUPANG_ACCESS_KEY, secretKey: env.COUPANG_SECRET_KEY })

const APPLY = process.argv.includes('--apply')
const LOWER = process.argv.includes('--lower')
const ONLY = (process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] || '').split(',').map((s) => s.trim()).filter(Boolean)
const FRESH_HOURS = +(process.argv.find((a) => a.startsWith('--fresh-hours='))?.split('=')[1] || 24)

// ── 대상 로드 ──
let q = sb.from('jimscanner_coupang_listings')
  .select('id, seller_product_id, source_goods_no, registered_title, status, stock_status, dome_price_krw, msp_price_krw, list_price_krw, reg_name:request_payload->>sellerProductName')
  .eq('source', 'upickb2b').in('status', ['APPROVED', 'SELLING', 'STOPPED'])
if (ONLY.length) q = q.in('source_goods_no', ONLY)
const { data: listings, error: e1 } = await q
if (e1) { console.error('listings 조회 오류:', e1.message); process.exit(1) }
const products = await loadUpickProducts(sb, listings.map((l) => l.source_goods_no))
console.log(`유픽 쿠팡 리스팅 ${listings.length}건 (상품 ${products.size}종) ${APPLY ? `[APPLY${LOWER ? '+LOWER' : ''}]` : '[DRY-RUN]'}\n`)

const freshSince = Date.now() - FRESH_HOURS * 3600e3
const buckets = { RAISE: [], LOWER: [], OK: [], BANNED: [], REVIEW: [], STALE: [], ERROR: [] }
let applied = 0, failed = 0
for (const l of listings) {
  const p = products.get(l.source_goods_no)
  const name = (l.registered_title || p?.title || '').slice(0, 30)
  if (!p || !p.last_seen_at || Date.parse(p.last_seen_at) < freshSince) {
    buckets.STALE.push({ l, name, why: p ? `last_seen ${p.last_seen_at?.slice(0, 10)}` : '카탈로그 없음' }); continue
  }
  try {
    const r = await repriceCoupangListing(api, sb, l, p, { apply: APPLY, lower: LOWER })
    buckets[r.kind].push({ ...r, l, name })
    if (r.done) applied++
    if (r.err) failed++
  } catch (e) { buckets.ERROR.push({ l, name, why: e.message }); if (APPLY) failed++ }
}

// ── 보고 ──
const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString())
const chg = (a, b) => (a === b ? fmt(b) : `${fmt(a)}→${fmt(b)}`)
for (const kind of ['RAISE', 'LOWER']) {
  const rows = buckets[kind]
  console.log(`\n■ ${kind === 'RAISE' ? '인상 필요(MSP 위반·손익분기 미달)' : `인하 가능(공급가·MSP 인하)${LOWER ? '' : ' — --lower 없으면 미적용'}`} ${rows.length}건`)
  for (const r of rows) {
    const mark = [r.done ? '✓' : '', r.err ? `✗ ${r.err}` : ''].filter(Boolean).join(' ')
    console.log(`  ${r.l.source_goods_no.padEnd(5)} ${r.name.padEnd(30)} 쿠팡 ${fmt(r.live).padStart(7)}→${fmt(r.target).padStart(7)} | 매입 ${chg(r.oldDome, r.dome)} · MSP ${chg(r.oldMsp, r.msp)} | 마진 ${fmt(r.mNow)}→${fmt(r.mNew)} ${r.l.status === 'STOPPED' ? '(판매중지)' : ''} ${mark}`)
  }
}
const okChanged = buckets.OK.filter((r) => r.oldDome !== r.dome || r.oldMsp !== r.msp)
console.log(`\n■ 가격 유지(OK) ${buckets.OK.length}건 — 이 중 DB 매입가/MSP 변동 ${okChanged.length}건`)
for (const r of okChanged) console.log(`  ${r.l.source_goods_no.padEnd(5)} ${r.name.padEnd(30)} 쿠팡 ${fmt(r.live)} | 매입 ${chg(r.oldDome, r.dome)} · MSP ${chg(r.oldMsp, r.msp)} | 마진 ${fmt(r.mNow)}`)
for (const kind of ['BANNED', 'REVIEW', 'STALE', 'ERROR']) {
  if (!buckets[kind].length) continue
  console.log(`\n■ ${kind} ${buckets[kind].length}건`)
  for (const r of buckets[kind]) console.log(`  ${r.l.source_goods_no.padEnd(5)} ${r.name.padEnd(30)} ${r.l.status} ${r.live ? `쿠팡 ${fmt(r.live)} ` : ''}| ${r.why}`)
}
console.log(`\n=== RAISE ${buckets.RAISE.length} / LOWER ${buckets.LOWER.length} / OK ${buckets.OK.length} / BANNED ${buckets.BANNED.length} / REVIEW ${buckets.REVIEW.length} / STALE ${buckets.STALE.length} / ERROR ${buckets.ERROR.length}` +
  (APPLY ? ` | 가격변경 성공 ${applied} · 실패 ${failed}` : ' | DRY-RUN — --apply 로 반영') + ' ===')
