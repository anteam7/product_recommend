/**
 * 쿠팡 등록 상품의 ggsan 재고 상태를 주기적으로 확인 (cron: 시간당 1회)
 *
 * 흐름:
 *   1) jimscanner_coupang_listings 의 active 상품 가져오기 (status TEMPORARY_SAVE/APPROVED/SELLING)
 *   2) ggsan 로그인 → 각 상품 디테일 페이지 fetch
 *   3) "품절" 감지되면:
 *      - 쿠팡 vendor-item 판매중지 API 호출
 *      - stock_status='sold_out', auto_paused=true, coupang_sale_stopped_at=now
 *   4) 이전에 품절이었는데 재입고됐다면:
 *      - 쿠팡 vendor-item 판매재개 API
 *      - stock_status='in_stock', auto_paused=false
 *   5) 실행 로그를 jimscanner_coupang_stock_sync_runs 에 기록
 *
 * 인증: CRON_SECRET (Authorization: Bearer ...)
 */
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const COUPANG_HOST = 'https://api-gateway.coupang.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// ─── HMAC 서명 (쿠팡) ───
function signCoupang(method: string, urlPath: string) {
  const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  const secret = process.env.COUPANG_SECRET_KEY!
  const signature = crypto.createHmac('sha256', secret).update(dt + method + urlPath).digest('hex')
  return { datetime: dt, signature }
}

async function coupangApi(method: string, urlPath: string, body: unknown = null) {
  const { datetime, signature } = signCoupang(method, urlPath)
  const access = process.env.COUPANG_ACCESS_KEY!
  const res = await fetch(`${COUPANG_HOST}${urlPath}`, {
    method,
    headers: {
      Authorization: `CEA algorithm=HmacSHA256, access-key=${access}, signed-date=${datetime}, signature=${signature}`,
      'Content-Type': 'application/json;charset=UTF-8',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  try { return { status: res.status, body: JSON.parse(text) } } catch { return { status: res.status, body: text as unknown } }
}

// ─── ggsan 로그인 + 재고 확인 ───
const cookies = new Map<string, string>()
function setCookies(setCookieHeader: string | null) {
  if (!setCookieHeader) return
  for (const part of setCookieHeader.split(/,(?=[^;]+=)/)) {
    const [kv] = part.split(';')
    const [k, v] = kv.trim().split('=')
    if (k && v !== undefined) cookies.set(k, v)
  }
}
const cookieHeader = () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')

async function ggsanFetch(url: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    redirect: 'manual',
    ...init,
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Cookie: cookieHeader(), ...(init.headers || {}) },
  })
  setCookies(res.headers.get('set-cookie'))
  return res
}

async function ggsanLogin() {
  const BASE = process.env.GGSAN_BASE_URL || 'https://www.ggsan.com'
  const user = process.env.GGSAN_USER!
  const pass = process.env.GGSAN_PASS!
  cookies.clear()
  await ggsanFetch(`${BASE}/member/login.php`)
  const r = await ggsanFetch(`${BASE}/member/login_ps.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${BASE}/member/login.php` },
    body: new URLSearchParams({ loginId: user, loginPwd: pass, saveId: 'y', returnUrl: `${BASE}/main/index.php` }).toString(),
  })
  const html = await r.text()
  if (!/parent\.location\.href='https:\/\/www\.ggsan\.com\/main\/index\.php'/.test(html)) {
    throw new Error('ggsan login failed')
  }
}

async function checkStock(goodsNo: string): Promise<'in_stock' | 'sold_out' | 'unknown'> {
  const BASE = process.env.GGSAN_BASE_URL || 'https://www.ggsan.com'
  const r = await ggsanFetch(`${BASE}/goods/goods_view.php?goodsNo=${goodsNo}`)
  if (!r.ok) return 'unknown'
  const html = await r.text()
  // set_goods_price 양수 = 구매가능 = 재고 있음. 품절시 가격영역이 사라지므로(godo5) 가장 신뢰성 높은 신호 → 품절 마커보다 먼저 평가.
  const pm = /name=["']set_goods_price["'][^>]*value=["'](\d+)/.exec(html)
  if (pm && parseInt(pm[1], 10) > 0) return 'in_stock'
  // 가격 없음 → 품절 마커(재입고 알림 버튼 등). 단, 네비 "입고&품절제품" 게시판 링크의 "품절" 오탐 제거(ggsan 메뉴, 2026-05-31 추가).
  const body = html.replace(/입고\s*&[^<]{0,12}품절[^<]{0,8}/g, ' ')
  if (/재입고\s*알림|품절|매진|일시품절|판매\s*중지/.test(body.slice(0, 40000))) return 'sold_out'
  return 'unknown'
}

// ─── 쿠팡 판매 중지/재개 (vendor-item 레벨만 유효 — seller-products/{id}/sales/stop 은 404 미존재 엔드포인트) ───
async function setVendorSale(sellerProductId: number, action: 'stop' | 'resume') {
  const d = (await coupangApi('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}`)).body?.data
  const items = ((d?.items ?? []) as Array<{ vendorItemId?: number }>).filter((it) => it.vendorItemId)
  if (!items.length) return { status: 500 }
  let ok = true
  for (const it of items) {
    const r = await coupangApi('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${it.vendorItemId}/sales/${action}`)
    if (r.status !== 200) ok = false
    await new Promise((s) => setTimeout(s, 150))
  }
  return { status: ok ? 200 : 500 }
}
async function stopCoupangSale(sellerProductId: number) { return await setVendorSale(sellerProductId, 'stop') }
async function resumeCoupangSale(sellerProductId: number) { return await setVendorSale(sellerProductId, 'resume') }

// ─── upickb2b 재고 (Cafe24 카테고리 리스트 품절 신호; upickb2b-collect.mjs 패턴) ───
// checkStock 은 ggsan 전용이라 source='upickb2b' 리스팅은 추적 못 했음. 유픽 상세는 품절 마커가 템플릿에 상존 → 카테고리 리스트 ico_product_soldout 로 판정.
const UP_BASE = process.env.UPICKB2B_BASE_URL || 'https://upickb2b.com'
const upCookies = new Map<string, string>()
function upSetCookies(h: string | null) { if (!h) return; for (const part of h.split(/,(?=[^;]+=)/)) { const kv = part.split(';')[0]; const eq = kv.indexOf('='); if (eq < 0) continue; upCookies.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim()) } }
const upCookieHeader = () => [...upCookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
async function upFetch(url: string, init: RequestInit = {}) { const res = await fetch(url, { redirect: 'manual', ...init, headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Cookie: upCookieHeader(), ...(init.headers || {}) } }); upSetCookies(res.headers.get('set-cookie')); return res }
async function upickLogin() {
  const user = process.env.UPICKB2B_USER!, pass = process.env.UPICKB2B_PASS!
  await upFetch(`${UP_BASE}/member/login.html`)
  await upFetch(`${UP_BASE}/exec/front/Member/login/`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${UP_BASE}/member/login.html` }, body: new URLSearchParams({ member_id: user, member_passwd: pass, returnUrl: '/' }).toString() })
  if (!upCookies.has('ECSESSID')) throw new Error('upickb2b login failed')
}
async function upickBuildStockMap(cates: string[]): Promise<Map<string, 'in_stock' | 'sold_out'>> {
  const map = new Map<string, 'in_stock' | 'sold_out'>()
  for (const cate of cates) {
    const seen = new Set<string>()
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
      await new Promise((s) => setTimeout(s, 250))
    }
  }
  return map
}

// ─── 메인 핸들러 ───
export async function GET(req: NextRequest) {
  // 인증: Vercel cron은 Authorization 헤더에 Bearer CRON_SECRET 전달
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // generated types에 신규 테이블 없어 any로 캐스팅 (service-role 사용)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any

  // 실행 로그 시작
  const { data: runRow } = await sb
    .from('jimscanner_coupang_stock_sync_runs')
    .insert({ status: 'running', triggered_by: 'cron' })
    .select('id')
    .single() as { data: { id: string } | null }
  const runId = runRow?.id
  const startedAt = Date.now()

  let total = 0, soldOut = 0, resumed = 0, errors = 0

  try {
    // 0단계: PENDING_APPROVAL 상품의 승인 상태 폴링 → 승인완료시 재고 5개 자동 적용
    const { data: pending } = await sb
      .from('jimscanner_coupang_listings')
      .select('id, seller_product_id')
      .eq('status', 'PENDING_APPROVAL')
    for (const p of ((pending ?? []) as unknown as Array<{ id: string; seller_product_id: number | null }>)) {
      if (!p.seller_product_id) continue
      const detail = await coupangApi('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${p.seller_product_id}`)
      const d = (detail.body as { data?: { statusName?: string; items?: Array<{ vendorItemId?: number; itemName?: string }> } })?.data
      const statusName = d?.statusName
      if (statusName === '승인완료') {
        // 승인완료 감지 → 재고 5개 (판매중지 안 함, 정상 판매중 유지)
        for (const it of (d?.items ?? [])) {
          if (it.vendorItemId) {
            await coupangApi('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${it.vendorItemId}/quantities/5`)
          }
        }
        await sb.from('jimscanner_coupang_listings').update({
          status: 'APPROVED',
          approval_status_name: statusName,
          approved_at: new Date().toISOString(),
          displayable: true,
          auto_paused: false,
          stock_status: 'in_stock',
          last_synced_at: new Date().toISOString(),
        }).eq('id', p.id)
      } else if (statusName === '승인거절' || statusName === '거절') {
        await sb.from('jimscanner_coupang_listings').update({
          status: 'REJECTED',
          approval_status_name: statusName,
          rejection_reason: '쿠팡 검수 거절 (Wing에서 사유 확인 필요)',
          last_synced_at: new Date().toISOString(),
        }).eq('id', p.id)
      } else {
        // 심사중 등 - status 유지
        await sb.from('jimscanner_coupang_listings').update({
          approval_status_name: statusName ?? null,
          last_synced_at: new Date().toISOString(),
        }).eq('id', p.id)
      }
      await new Promise((s) => setTimeout(s, 200))
    }

    // 활성 등록 상품 — 재고 추적 대상 (APPROVED, SELLING)
    const { data: listings } = await sb
      .from('jimscanner_coupang_listings')
      .select('id, seller_product_id, source, source_goods_no, stock_status, auto_paused')
      .in('status', ['APPROVED', 'SELLING'])
    const rows = (listings ?? []) as unknown as Array<{
      id: string
      seller_product_id: number | null
      source: string
      source_goods_no: string
      stock_status: string | null
      auto_paused: boolean | null
    }>

    if (rows.length === 0) {
      await sb.from('jimscanner_coupang_stock_sync_runs').update({
        finished_at: new Date().toISOString(),
        total_checked: 0,
        status: 'success',
        duration_ms: Date.now() - startedAt,
      }).eq('id', runId)
      return NextResponse.json({ ok: true, total: 0 })
    }

    await ggsanLogin()

    // upick 재고맵: source='upickb2b' 리스팅이 있을 때만 카테고리 품절 스캔(로그인 실패/미설정 시 유픽 skip)
    let upickStock = new Map<string, 'in_stock' | 'sold_out'>()
    const upickRows = rows.filter((r) => r.source === 'upickb2b' && r.source_goods_no)
    if (upickRows.length && process.env.UPICKB2B_USER) {
      try {
        const upNos = [...new Set(upickRows.map((r) => String(r.source_goods_no)))]
        const { data: catRows } = await sb.from('jimscanner_upickb2b_products').select('cate_no').in('product_no', upNos)
        const cates = [...new Set(((catRows ?? []) as Array<{ cate_no: string | null }>).map((r) => String(r.cate_no)).filter(Boolean))]
        await upickLogin()
        upickStock = await upickBuildStockMap(cates.length ? cates : ['24', '25', '92'])
      } catch (e) { console.log(`upick 스캔 실패(유픽 추적 skip): ${e instanceof Error ? e.message : e}`) }
    }

    for (const row of rows) {
      total++
      try {
        // ggsan 은 goods_view 라이브 조회, upickb2b 는 재고맵 룩업(미발견 unknown=조치 안 함)
        const status: 'in_stock' | 'sold_out' | 'unknown' = row.source === 'upickb2b'
          ? (upickStock.get(String(row.source_goods_no)) ?? 'unknown')
          : await checkStock(row.source_goods_no)
        const wasPaused = !!row.auto_paused

        const updates: Record<string, unknown> = {
          stock_status: status,
          last_stock_check: new Date().toISOString(),
        }

        if (status === 'sold_out' && !wasPaused && row.seller_product_id) {
          // 신규 품절 감지 → 쿠팡 판매 중지
          const stopResp = await stopCoupangSale(row.seller_product_id)
          const ok = stopResp.status === 200
          if (ok) {
            updates.auto_paused = true
            updates.coupang_sale_stopped_at = new Date().toISOString()
            updates.stock_sold_out_at = new Date().toISOString()
            updates.status = 'STOPPED'
            soldOut++
          } else {
            errors++
          }
        } else if (status === 'in_stock' && wasPaused && row.seller_product_id) {
          // 재입고 감지 → 쿠팡 판매 재개
          const resumeResp = await resumeCoupangSale(row.seller_product_id)
          const ok = resumeResp.status === 200
          if (ok) {
            updates.auto_paused = false
            updates.coupang_sale_stopped_at = null
            updates.stock_sold_out_at = null
            updates.status = 'TEMPORARY_SAVE'
            resumed++
          } else {
            errors++
          }
        }

        await sb.from('jimscanner_coupang_listings').update(updates).eq('id', row.id)
        await new Promise((r) => setTimeout(r, 200))
      } catch {
        errors++
      }
    }

    await sb.from('jimscanner_coupang_stock_sync_runs').update({
      finished_at: new Date().toISOString(),
      total_checked: total,
      sold_out_count: soldOut,
      resumed_count: resumed,
      error_count: errors,
      duration_ms: Date.now() - startedAt,
      status: 'success',
    }).eq('id', runId)

    return NextResponse.json({ ok: true, total, soldOut, resumed, errors })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    await sb.from('jimscanner_coupang_stock_sync_runs').update({
      finished_at: new Date().toISOString(),
      total_checked: total,
      sold_out_count: soldOut,
      resumed_count: resumed,
      error_count: errors,
      duration_ms: Date.now() - startedAt,
      status: 'error',
      error_message: msg,
    }).eq('id', runId)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
