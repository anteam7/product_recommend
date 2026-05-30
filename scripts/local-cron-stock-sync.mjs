/**
 * 로컬 cron — 쿠팡 등록 상품 재고 동기화 + 승인완료 폴링
 * Windows 작업 스케줄러 / WSL cron 으로 시간당 실행
 *
 * 동작:
 *   1) PENDING_APPROVAL 상품 폴링 → 승인완료 감지 시 재고 5개
 *   2) APPROVED 상품의 ggsan 재고 상태 확인 → 품절 감지 시 쿠팡 판매중지
 *   3) 재입고 감지 시 판매재개
 *
 * 실행 로그 → jimscanner_coupang_stock_sync_runs
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
    .map((l) => {
      const i = l.indexOf('=')
      let v = l.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return [l.slice(0, i).trim(), v]
    }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const ACCESS_KEY = env.COUPANG_ACCESS_KEY
const SECRET_KEY = env.COUPANG_SECRET_KEY
const HOST = env.COUPANG_API_HOST
const BASE = env.GGSAN_BASE_URL || 'https://www.ggsan.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function signCoupang(method, urlPath) {
  const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  return { datetime: dt, signature: crypto.createHmac('sha256', SECRET_KEY).update(dt + method + urlPath).digest('hex') }
}
async function coupangApi(method, urlPath) {
  const { datetime, signature } = signCoupang(method, urlPath)
  const res = await fetch(`${HOST}${urlPath}`, {
    method,
    headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`, 'Content-Type': 'application/json;charset=UTF-8' },
  })
  const t = await res.text()
  try { return { status: res.status, body: JSON.parse(t) } } catch { return { status: res.status, body: t } }
}

// ggsan
const cookies = new Map()
function setCookies(h) {
  if (!h) return
  for (const part of h.split(/,(?=[^;]+=)/)) {
    const [kv] = part.split(';')
    const [k, v] = kv.trim().split('=')
    if (k && v !== undefined) cookies.set(k, v)
  }
}
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
async function ggsanFetch(url, init = {}) {
  const res = await fetch(url, { redirect: 'manual', ...init, headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Cookie: cookieHeader(), ...(init.headers || {}) } })
  setCookies(res.headers.get('set-cookie'))
  return res
}
async function ggsanLogin() {
  cookies.clear()
  await ggsanFetch(`${BASE}/member/login.php`)
  await ggsanFetch(`${BASE}/member/login_ps.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${BASE}/member/login.php` },
    body: new URLSearchParams({ loginId: env.GGSAN_USER, loginPwd: env.GGSAN_PASS, saveId: 'y', returnUrl: `${BASE}/main/index.php` }).toString(),
  })
}
async function checkStock(goodsNo) {
  const r = await ggsanFetch(`${BASE}/goods/goods_view.php?goodsNo=${goodsNo}`)
  if (!r.ok) return 'unknown'
  const html = await r.text()
  // 정확한 판정: 가격 input이 존재하고 값이 0보다 크면 in_stock (다른 상품의 품절 마커가 HTML에 섞여 있어서 텍스트 매칭은 부정확)
  const priceMatch = html.match(/name=["']set_goods_price["'][^>]*value=["']?(\d+(?:\.\d+)?)/)
  if (priceMatch && parseFloat(priceMatch[1]) > 0) return 'in_stock'
  // 가격이 없거나 0이면 메인 상품 영역만 검사 (HTML 앞부분 5KB)
  if (/품절|매진|일시품절|재입고\s*알림/.test(html.slice(0, 5000))) return 'sold_out'
  return 'unknown'
}

const { data: runRow } = await sb
  .from('jimscanner_coupang_stock_sync_runs')
  .insert({ status: 'running', triggered_by: 'local' })
  .select('id')
  .single()
const runId = runRow?.id
const t0 = Date.now()
let total = 0, soldOut = 0, resumed = 0, errors = 0, approvedNew = 0

try {
  // 1. PENDING_APPROVAL 폴링 → 승인완료 감지 + 재고 5개
  const { data: pending } = await sb
    .from('jimscanner_coupang_listings')
    .select('id, seller_product_id')
    .eq('status', 'PENDING_APPROVAL')
  for (const p of pending ?? []) {
    if (!p.seller_product_id) continue
    const detail = await coupangApi('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${p.seller_product_id}`)
    const d = detail.body?.data
    const statusName = d?.statusName
    if (statusName === '승인완료') {
      for (const it of (d.items ?? [])) {
        if (it.vendorItemId) {
          await coupangApi('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${it.vendorItemId}/quantities/5`)
        }
      }
      await sb.from('jimscanner_coupang_listings').update({
        status: 'APPROVED', approval_status_name: statusName,
        approved_at: new Date().toISOString(), displayable: true, auto_paused: false,
        stock_status: 'in_stock', last_synced_at: new Date().toISOString(),
      }).eq('id', p.id)
      approvedNew++
    } else if (/거절/.test(statusName ?? '')) {
      await sb.from('jimscanner_coupang_listings').update({
        status: 'REJECTED', approval_status_name: statusName,
        rejection_reason: 'Wing에서 사유 확인 필요',
        last_synced_at: new Date().toISOString(),
      }).eq('id', p.id)
    } else {
      await sb.from('jimscanner_coupang_listings').update({
        approval_status_name: statusName ?? null,
        last_synced_at: new Date().toISOString(),
      }).eq('id', p.id)
    }
    await new Promise((s) => setTimeout(s, 200))
  }

  // 2. APPROVED 상품 재고 추적 — vendor-item 단위 sales/stop (상품 단위 API는 PRECONDITION_FAILED)
  const { data: listings } = await sb
    .from('jimscanner_coupang_listings')
    .select('id, seller_product_id, source_goods_no, stock_status, auto_paused')
    .in('status', ['APPROVED', 'SELLING', 'STOPPED'])
  if ((listings ?? []).length > 0) {
    await ggsanLogin()
    const errorSamples = []
    for (const row of listings) {
      total++
      try {
        const status = await checkStock(row.source_goods_no)
        const wasPaused = !!row.auto_paused
        const updates = { stock_status: status, last_stock_check: new Date().toISOString() }
        if (status === 'sold_out' && !wasPaused && row.seller_product_id) {
          // vendor-item 단위로 sales/stop (상품 단위는 PRECONDITION_FAILED)
          const detail = await coupangApi('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${row.seller_product_id}`)
          const items = (detail.body?.data?.items ?? []).filter((it) => it.vendorItemId)
          let allOk = items.length > 0
          for (const it of items) {
            const stop = await coupangApi('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${it.vendorItemId}/sales/stop`)
            if (stop.status !== 200) { allOk = false; errorSamples.push(`stop ${it.vendorItemId}: ${JSON.stringify(stop.body).slice(0, 100)}`); break }
          }
          if (allOk) {
            Object.assign(updates, { auto_paused: true, coupang_sale_stopped_at: new Date().toISOString(), stock_sold_out_at: new Date().toISOString(), status: 'STOPPED' })
            soldOut++
          } else errors++
        } else if (status === 'in_stock' && wasPaused && row.seller_product_id) {
          const detail = await coupangApi('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${row.seller_product_id}`)
          const items = (detail.body?.data?.items ?? []).filter((it) => it.vendorItemId)
          let allOk = items.length > 0
          for (const it of items) {
            const resume = await coupangApi('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${it.vendorItemId}/sales/resume`)
            if (resume.status !== 200) { allOk = false; errorSamples.push(`resume ${it.vendorItemId}: ${JSON.stringify(resume.body).slice(0, 100)}`); break }
          }
          if (allOk) {
            Object.assign(updates, { auto_paused: false, coupang_sale_stopped_at: null, stock_sold_out_at: null, status: 'APPROVED' })
            resumed++
          } else errors++
        }
        const { error: updErr } = await sb.from('jimscanner_coupang_listings').update(updates).eq('id', row.id)
        if (updErr) { errors++; errorSamples.push(`update ${row.id}: ${updErr.message}`) }

        // 셀스루 회전율 보드(jimscanner_ggsan_sellthrough_rpc)용 status 전이 기록.
        // 상태가 바뀐 경우에만 price_history 에 적재(노이즈 방지). in_stock→active, sold_out→sold_out.
        if (row.source_goods_no && (status === 'in_stock' || status === 'sold_out') && status !== row.stock_status) {
          const histStatus = status === 'in_stock' ? 'active' : 'sold_out'
          const { error: histErr } = await sb
            .from('jimscanner_ggsan_price_history')
            .insert({ goods_no: row.source_goods_no, status: histStatus })
          if (histErr) errorSamples.push(`history ${row.source_goods_no}: ${histErr.message}`)
        }
      } catch (e) {
        errors++
        errorSamples.push(`exception ${row.source_goods_no}: ${e.message}`)
      }
      await new Promise((s) => setTimeout(s, 200))
    }
    if (errorSamples.length) {
      console.log('=== 에러 샘플 (최대 5개) ===')
      errorSamples.slice(0, 5).forEach((s) => console.log('  ' + s))
    }
  }

  await sb.from('jimscanner_coupang_stock_sync_runs').update({
    finished_at: new Date().toISOString(),
    total_checked: total, sold_out_count: soldOut, resumed_count: resumed, error_count: errors,
    duration_ms: Date.now() - t0, status: 'success',
  }).eq('id', runId)
  console.log(`[local-cron-stock] total=${total} newly_approved=${approvedNew} sold_out=${soldOut} resumed=${resumed} errors=${errors} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
} catch (e) {
  await sb.from('jimscanner_coupang_stock_sync_runs').update({
    finished_at: new Date().toISOString(), status: 'error',
    error_message: e.message, duration_ms: Date.now() - t0,
  }).eq('id', runId)
  console.error('ERROR:', e.message)
  process.exit(1)
}
