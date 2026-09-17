/**
 * 쿠팡 등록 후 마무리 — 승인요청 누락분 재요청 · 검수 통과분 재고 설정 · 반려분 마킹.
 *   node scripts/coupang-followup-approvals.mjs [--source=wellroot] [--only=216,63] [--qty=30] [--limit=N] [--dry] [--force-stock]
 *
 * 왜 필요한가: 등록 직후에는 쿠팡 검수(수시간~1-2일) 전이라 vendorItemId가 없어 재고를 넣을 수 없다.
 * 재고가 0이면 검수를 통과해도 판매가 시작되지 않으므로, 검수 통과 시점에 이 스크립트로 마무리한다.
 *
 * 기존 스크립트와의 차이
 *   - bio77-retry-approvals.mjs : TEMPORARY_SAVE(승인요청 누락)만 처리
 *   - coupang-bulk-approve-stock.mjs : TEMPORARY_SAVE만 · 공급처 구분 없음 · 재고 5 고정
 *   - 이 스크립트 : PENDING_APPROVAL(검수 대기)까지 추적해 **검수 통과분에 재고를 넣는다**. 공급처별 실행.
 *
 * 안전장치
 *   - 이미 재고가 있는 상품은 건드리지 않는다(--force-stock 로만 덮어씀). 재고는 stock-sync 크론 소관이라
 *     임의로 덮어쓰면 품절 처리된 상품이 되살아난다.
 *   - --source 기본값은 wellroot. 전 공급처를 돌리려면 --source=all 을 명시해야 한다.
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const ACCESS_KEY = env.COUPANG_ACCESS_KEY, SECRET_KEY = env.COUPANG_SECRET_KEY, HOST = env.COUPANG_API_HOST

const args = process.argv.slice(2)
const argOf = k => args.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')
const SOURCE = argOf('source') || 'wellroot'
const ONLY = (argOf('only') || '').split(',').map(s => s.trim()).filter(Boolean)
const QTY = Math.max(1, +(argOf('qty') || 30))
const LIMIT = +(argOf('limit') || 0) || 0
const DRY = args.includes('--dry')
const FORCE_STOCK = args.includes('--force-stock')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function sign(m, p, q = '') { const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'; return { dt, sig: crypto.createHmac('sha256', SECRET_KEY).update(dt + m + p + q).digest('hex') } }
async function api(m, p) {
  const { dt, sig } = sign(m, p)
  const r = await fetch(`${HOST}${p}`, { method: m, headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${dt}, signature=${sig}`, 'Content-Type': 'application/json;charset=UTF-8' } })
  const t = await r.text()
  try { return { status: r.status, body: JSON.parse(t) } } catch { return { status: r.status, body: t } }
}
const P = '/v2/providers/seller_api/apis/api/v1/marketplace'

/** 현재 재고 조회 — 실패하면 null(모름) */
async function currentStock(vendorItemId) {
  const r = await api('GET', `${P}/vendor-items/${vendorItemId}/inventories`)
  const d = r.body?.data
  const v = d?.amountInStock ?? d?.quantity
  return typeof v === 'number' ? v : null
}

let query = sb.from('jimscanner_coupang_listings')
  .select('id, source, source_goods_no, seller_product_id, registered_title, status, list_price_krw')
  .in('status', ['TEMPORARY_SAVE', 'PENDING_APPROVAL', 'APPROVED'])
  .not('seller_product_id', 'is', null)
if (SOURCE !== 'all') query = query.eq('source', SOURCE)
if (ONLY.length) query = query.in('source_goods_no', ONLY)
const { data: all, error } = await query.order('registered_at', { ascending: true })
if (error) { console.error('조회 실패:', error.message); process.exit(1) }
const rows = LIMIT > 0 ? (all ?? []).slice(0, LIMIT) : (all ?? [])

console.log(`=== 쿠팡 등록 마무리 ${DRY ? '[DRY]' : ''} ===`)
console.log(`매입처 ${SOURCE} · 대상 ${rows.length}건 · 재고 ${QTY}개${FORCE_STOCK ? ' (기존 재고 덮어씀)' : ''}\n`)

const sum = { approved: 0, requested: 0, stocked: 0, rejected: 0, waiting: 0, fail: 0 }
for (let i = 0; i < rows.length; i++) {
  const r = rows[i]
  const tag = `[${i + 1}/${rows.length}] ${r.source_goods_no} ${String(r.registered_title).slice(0, 26).padEnd(26)}`
  try {
    const detail = await api('GET', `${P}/seller-products/${r.seller_product_id}`)
    const d = detail.body?.data
    if (!d) { console.log(`${tag} | ✗ 상품 조회 실패 HTTP ${detail.status}`); sum.fail++; await sleep(400); continue }
    const statusName = d.statusName ?? ''
    const vendorItemIds = (d.items ?? []).map(it => it.vendorItemId).filter(Boolean)

    // ① 반려 — 재시도 불가, DB에 사유를 남긴다
    if (/반려|거절/.test(statusName)) {
      console.log(`${tag} | ⛔ ${statusName}`)
      if (!DRY) await sb.from('jimscanner_coupang_listings').update({ status: 'REJECTED', rejection_reason: `쿠팡 ${statusName}`, last_synced_at: new Date().toISOString() }).eq('id', r.id)
      sum.rejected++; await sleep(400); continue
    }

    // ② 임시저장 — 승인요청이 누락된 건
    if (/임시저장/.test(statusName)) {
      if (DRY) { console.log(`${tag} | (dry) 승인요청 필요`); sum.requested++; await sleep(300); continue }
      const appr = await api('PUT', `${P}/seller-products/${r.seller_product_id}/approvals`)
      const ok = appr.status === 200 && (appr.body?.code === 'SUCCESS' || appr.body?.code === 200)
      if (!ok) {
        console.log(`${tag} | ✗ 승인요청 실패: ${JSON.stringify(appr.body).slice(0, 110)}`)
        sum.fail++; await sleep(500); continue
      }
      await sb.from('jimscanner_coupang_listings').update({ status: 'PENDING_APPROVAL', last_synced_at: new Date().toISOString() }).eq('id', r.id)
      console.log(`${tag} | ✓ 승인요청 완료`)
      sum.requested++; await sleep(1200)
    }

    // ③ 검수 대기 — vendorItemId가 아직 없으면 할 수 있는 게 없다
    if (!vendorItemIds.length) {
      console.log(`${tag} | ⏳ ${statusName || '검수 대기'} — vendorItemId 미부여`)
      sum.waiting++; await sleep(400); continue
    }

    // ④ 승인 완료 — DB 상태 정정
    const approved = /승인완료/.test(statusName)
    if (approved && r.status !== 'APPROVED' && !DRY) {
      await sb.from('jimscanner_coupang_listings').update({
        status: 'APPROVED', approval_status_name: statusName, approved_at: new Date().toISOString(), last_synced_at: new Date().toISOString(),
      }).eq('id', r.id)
      sum.approved++
    }

    // ⑤ 재고 — 0인 것만 채운다(기존 재고는 stock-sync 크론 소관)
    const stocked = []
    for (const vid of vendorItemIds) {
      const cur = await currentStock(vid)
      if (!FORCE_STOCK && cur != null && cur > 0) { await sleep(250); continue }
      if (DRY) { stocked.push(`${vid}(현재 ${cur ?? '?'})`); await sleep(250); continue }
      const q = await api('PUT', `${P}/vendor-items/${vid}/quantities/${QTY}`)
      if (q.status === 200) stocked.push(String(vid))
      else console.log(`${tag} | ✗ 재고 설정 실패 ${vid}: ${JSON.stringify(q.body).slice(0, 90)}`)
      await sleep(300)
    }
    if (stocked.length) {
      if (!DRY) await sb.from('jimscanner_coupang_listings').update({ displayable: true, auto_paused: false, last_synced_at: new Date().toISOString() }).eq('id', r.id)
      console.log(`${tag} | ${approved ? '✓ 승인완료' : `· ${statusName}`} → 재고 ${QTY}개 설정 ${DRY ? '(dry) ' : ''}(${stocked.join(',')})`)
      sum.stocked++
    } else {
      console.log(`${tag} | ${approved ? '✓ 승인완료' : `· ${statusName}`} — 재고 이미 있음, 건너뜀`)
    }
  } catch (e) {
    console.log(`${tag} | ✗ ERROR: ${e.message}`)
    sum.fail++
  }
  await sleep(400)
}

console.log('\n=== 완료 ===')
console.log(`승인완료 기록 ${sum.approved} · 승인요청 ${sum.requested} · 재고설정 ${sum.stocked} · 검수대기 ${sum.waiting} · 반려 ${sum.rejected} · 실패 ${sum.fail}`)
if (sum.waiting) console.log('검수 대기분은 쿠팡 심사(수시간~1-2일) 후 이 스크립트를 다시 실행하면 재고가 들어갑니다.')
