/**
 * 로컬 cron — 쿠팡 등록상품의 ggsan 재고 동기화 (Windows 작업 스케줄러 "Coupang-Stock-Sync"가 시간당 실행)
 *
 * src/app/api/cron/coupang-stock-sync/route.ts 의 로직을 로컬에서 그대로 수행한다.
 * (Vercel 엔드포인트는 maxDuration=60인데 146개 점검에 ~118s 걸려 타임아웃 → 로컬 직접 실행 필수.)
 *
 * 흐름:
 *   0) PENDING_APPROVAL 폴링 → 승인완료시 재고 5개 적용 + status=APPROVED
 *   1) APPROVED/SELLING 상품의 ggsan 재고 확인
 *   2) 신규 품절 → 쿠팡 판매중지(STOPPED) / 재입고 → 판매재개(TEMPORARY_SAVE)
 *   3) 실행 로그를 jimscanner_coupang_stock_sync_runs 에 기록 (관리자 위젯 소스)
 *
 * 유실 주의: 이 파일이 없으면 작업이 "파일 없음"으로 exit 1 → 위젯 마지막성공 시점에서 멈춤. (2026-05-31 복구)
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const HOST = env.COUPANG_API_HOST || 'https://api-gateway.coupang.com'
const ACCESS = env.COUPANG_ACCESS_KEY
const SECRET = env.COUPANG_SECRET_KEY
const BASE = env.GGSAN_BASE_URL || 'https://www.ggsan.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const sleep = (ms) => new Promise((s) => setTimeout(s, ms))

function signCoupang(method, urlPath) {
  const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  return { datetime: dt, signature: crypto.createHmac('sha256', SECRET).update(dt + method + urlPath).digest('hex') }
}
async function coupangApi(method, urlPath, body = null) {
  const { datetime, signature } = signCoupang(method, urlPath)
  const res = await fetch(`${HOST}${urlPath}`, {
    method,
    headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS}, signed-date=${datetime}, signature=${signature}`, 'Content-Type': 'application/json;charset=UTF-8' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  try { return { status: res.status, body: JSON.parse(text) } } catch { return { status: res.status, body: text } }
}

const cookies = new Map()
function setCookies(h) { if (!h) return; for (const part of h.split(/,(?=[^;]+=)/)) { const [kv] = part.split(';'); const [k, v] = kv.trim().split('='); if (k && v !== undefined) cookies.set(k, v) } }
const cookieHeader = () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
async function ggsanFetch(url, init = {}) { const res = await fetch(url, { redirect: 'manual', ...init, headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Cookie: cookieHeader(), ...(init.headers || {}) } }); setCookies(res.headers.get('set-cookie')); return res }
async function ggsanLogin() {
  cookies.clear()
  await ggsanFetch(`${BASE}/member/login.php`)
  const r = await ggsanFetch(`${BASE}/member/login_ps.php`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${BASE}/member/login.php` }, body: new URLSearchParams({ loginId: env.GGSAN_USER, loginPwd: env.GGSAN_PASS, saveId: 'y', returnUrl: `${BASE}/main/index.php` }).toString() })
  if (!/parent\.location\.href='https:\/\/www\.ggsan\.com\/main\/index\.php'/.test(await r.text())) throw new Error('ggsan login failed')
}
async function checkStock(goodsNo) {
  const r = await ggsanFetch(`${BASE}/goods/goods_view.php?goodsNo=${goodsNo}`)
  if (!r.ok) return 'unknown'
  const html = await r.text()
  // 1) set_goods_price 양수 = 구매가능 = 재고 있음. 품절시 가격영역이 사라지므로 가장 신뢰성 높은 신호. (품절 마커보다 먼저 평가)
  const pm = /name=["']set_goods_price["'][^>]*value=["'](\d+)/.exec(html)
  if (pm && parseInt(pm[1], 10) > 0) return 'in_stock'
  // 2) 가격 없음 → 품절 마커. 단, 네비 "입고&품절제품" 게시판 링크의 "품절" 오탐 제거(ggsan 메뉴, 2026-05-31 추가).
  const body = html.replace(/입고\s*&[^<]{0,12}품절[^<]{0,8}/g, ' ')
  if (/재입고\s*알림|품절|매진|일시품절|판매\s*중지/.test(body.slice(0, 40000))) return 'sold_out'
  return 'unknown'
}
// 판매 중지/재개는 vendor-item 레벨만 유효 (seller-products/{id}/sales/stop 은 404 PRECONDITION_FAILED — 미존재 엔드포인트).
async function setVendorSale(spid, action) {
  const d = (await coupangApi('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${spid}`)).body?.data
  const items = (d?.items ?? []).filter((it) => it.vendorItemId)
  if (!items.length) return { status: 500 }
  let ok = true
  for (const it of items) {
    const r = await coupangApi('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${it.vendorItemId}/sales/${action}`)
    if (r.status !== 200) ok = false
    await sleep(150)
  }
  return { status: ok ? 200 : 500 }
}
const stopCoupangSale = (spid) => setVendorSale(spid, 'stop')
const resumeCoupangSale = (spid) => setVendorSale(spid, 'resume')

// ─── upickb2b 재고 (Cafe24 카테고리 리스트 품절 신호; upickb2b-collect.mjs 패턴) ───
// checkStock 은 ggsan 전용(goods_view 조회)이라 source='upickb2b' 리스팅은 추적 못 했음.
// 유픽 상세페이지는 품절 마커가 템플릿에 상존해 판별 불가 → 카테고리 리스트의 ico_product_soldout 로 판정.
const UP_BASE = env.UPICKB2B_BASE_URL || 'https://upickb2b.com'
const upCookies = new Map()
function upSetCookies(h) { if (!h) return; for (const part of h.split(/,(?=[^;]+=)/)) { const kv = part.split(';')[0]; const eq = kv.indexOf('='); if (eq < 0) continue; upCookies.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim()) } }
const upCookieHeader = () => [...upCookies].map(([k, v]) => `${k}=${v}`).join('; ')
async function upFetch(url, init = {}) { const res = await fetch(url, { redirect: 'manual', ...init, headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Cookie: upCookieHeader(), ...(init.headers || {}) } }); upSetCookies(res.headers.get('set-cookie')); return res }
async function upickLogin() {
  await upFetch(`${UP_BASE}/member/login.html`)
  await upFetch(`${UP_BASE}/exec/front/Member/login/`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${UP_BASE}/member/login.html` }, body: new URLSearchParams({ member_id: env.UPICKB2B_USER, member_passwd: env.UPICKB2B_PASS, returnUrl: '/' }).toString() })
  if (!upCookies.has('ECSESSID')) throw new Error('upickb2b login failed')
}
async function upickBuildStockMap(cates) {
  const map = new Map()
  for (const cate of cates) {
    const seen = new Set()
    for (let page = 1; page <= 30; page++) {
      const r = await upFetch(`${UP_BASE}/category/x/${cate}/?page=${page}`)
      if (!r.ok) break
      let html = await r.text()
      const cut = html.search(/class="[^"]*ec-base-paginate/); if (cut > 0) html = html.slice(0, cut)
      let fresh = 0
      for (const b of html.matchAll(/id=["']anchorBoxId_(\d+)["']([\s\S]*?)(?=id=["']anchorBoxId_|$)/g)) {
        if (seen.has(b[1])) continue
        seen.add(b[1]); fresh++
        map.set(b[1], /ico_product_soldout|alt=["']품절["']/i.test(b[2]) ? 'sold_out' : 'in_stock')
      }
      if (!fresh) break
      await sleep(250)
    }
  }
  return map
}

// ─── 메인 ───
const { data: runRow } = await sb.from('jimscanner_coupang_stock_sync_runs').insert({ status: 'running', triggered_by: 'local-cron' }).select('id').single()
const runId = runRow?.id
const startedAt = Date.now()
let total = 0, soldOut = 0, resumed = 0, errors = 0

try {
  // 0) PENDING_APPROVAL 폴링
  const { data: pending } = await sb.from('jimscanner_coupang_listings').select('id, seller_product_id').eq('status', 'PENDING_APPROVAL')
  for (const p of (pending ?? [])) {
    if (!p.seller_product_id) continue
    const detail = await coupangApi('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${p.seller_product_id}`)
    const d = detail.body?.data
    const statusName = d?.statusName
    if (statusName === '승인완료') {
      for (const it of (d?.items ?? [])) { if (it.vendorItemId) await coupangApi('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${it.vendorItemId}/quantities/5`) }
      await sb.from('jimscanner_coupang_listings').update({ status: 'APPROVED', approval_status_name: statusName, approved_at: new Date().toISOString(), displayable: true, auto_paused: false, stock_status: 'in_stock', last_synced_at: new Date().toISOString() }).eq('id', p.id)
    } else if (statusName === '승인거절' || statusName === '거절') {
      await sb.from('jimscanner_coupang_listings').update({ status: 'REJECTED', approval_status_name: statusName, rejection_reason: '쿠팡 검수 거절 (Wing에서 사유 확인 필요)', last_synced_at: new Date().toISOString() }).eq('id', p.id)
    } else {
      await sb.from('jimscanner_coupang_listings').update({ approval_status_name: statusName ?? null, last_synced_at: new Date().toISOString() }).eq('id', p.id)
    }
    await sleep(200)
  }

  // 1) 활성 상품 재고 추적
  const { data: listings } = await sb.from('jimscanner_coupang_listings').select('id, seller_product_id, source, source_goods_no, stock_status, auto_paused').in('status', ['APPROVED', 'SELLING'])
  const rows = listings ?? []
  if (rows.length === 0) {
    await sb.from('jimscanner_coupang_stock_sync_runs').update({ finished_at: new Date().toISOString(), total_checked: 0, status: 'success', duration_ms: Date.now() - startedAt }).eq('id', runId)
    console.log('[local-cron-stock] no active listings'); process.exit(0)
  }

  await ggsanLogin()

  // upick 재고맵: source='upickb2b' 리스팅이 있을 때만 카테고리 품절 스캔(로그인 실패/미설정 시 유픽은 skip)
  let upickStock = new Map()
  const upickRows = rows.filter((r) => r.source === 'upickb2b' && r.source_goods_no)
  if (upickRows.length && env.UPICKB2B_USER) {
    try {
      const upNos = [...new Set(upickRows.map((r) => String(r.source_goods_no)))]
      const { data: catRows } = await sb.from('jimscanner_upickb2b_products').select('cate_no').in('product_no', upNos)
      const cates = [...new Set((catRows ?? []).map((r) => String(r.cate_no)).filter(Boolean))]
      await upickLogin()
      upickStock = await upickBuildStockMap(cates.length ? cates : ['24', '25', '92'])
      const soldN = [...upickStock.values()].filter((v) => v === 'sold_out').length
      console.log(`[local-cron-stock] upick 재고맵 ${upickStock.size}건(품절 ${soldN})`)
    } catch (e) { console.log(`[local-cron-stock] upick 스캔 실패(유픽 추적 skip): ${e instanceof Error ? e.message : e}`) }
  }

  for (const row of rows) {
    total++
    try {
      // ggsan 은 goods_view 라이브 조회, upickb2b 는 재고맵 룩업(미발견 unknown=조치 안 함)
      const status = row.source === 'upickb2b'
        ? (upickStock.get(String(row.source_goods_no)) ?? 'unknown')
        : await checkStock(row.source_goods_no)
      const wasPaused = !!row.auto_paused
      const updates = { stock_status: status, last_stock_check: new Date().toISOString() }
      if (status === 'sold_out' && !wasPaused && row.seller_product_id) {
        if ((await stopCoupangSale(row.seller_product_id)).status === 200) { updates.auto_paused = true; updates.coupang_sale_stopped_at = new Date().toISOString(); updates.stock_sold_out_at = new Date().toISOString(); updates.status = 'STOPPED'; soldOut++ } else errors++
      } else if (status === 'in_stock' && wasPaused && row.seller_product_id) {
        if ((await resumeCoupangSale(row.seller_product_id)).status === 200) { updates.auto_paused = false; updates.coupang_sale_stopped_at = null; updates.stock_sold_out_at = null; updates.status = 'TEMPORARY_SAVE'; resumed++ } else errors++
      }
      await sb.from('jimscanner_coupang_listings').update(updates).eq('id', row.id)
      await sleep(200)
    } catch (e) { errors++; if (errors <= 3) console.log(`  row ${row.source_goods_no} error: ${e instanceof Error ? e.message : e}`) }
  }

  await sb.from('jimscanner_coupang_stock_sync_runs').update({ finished_at: new Date().toISOString(), total_checked: total, sold_out_count: soldOut, resumed_count: resumed, error_count: errors, duration_ms: Date.now() - startedAt, status: 'success' }).eq('id', runId)
  console.log(`[local-cron-stock] total=${total} soldOut=${soldOut} resumed=${resumed} errors=${errors} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`)
  process.exit(0)
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e)
  await sb.from('jimscanner_coupang_stock_sync_runs').update({ finished_at: new Date().toISOString(), total_checked: total, sold_out_count: soldOut, resumed_count: resumed, error_count: errors, duration_ms: Date.now() - startedAt, status: 'error', error_message: msg }).eq('id', runId)
  console.error(`[local-cron-stock] ERROR: ${msg}`)
  process.exit(1)
}
