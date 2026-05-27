/**
 * ggsan 도매 SKU 재고 일일 스냅샷 cron.
 *
 * 목적: jimscanner_ggsan_products(active) 의 stock 상태를 매일 캡처해
 *       jimscanner_ggsan_stock_history 에 적재 → burn-rate / DoS / z-score
 *       (pre-trend leading indicator) 분석 RPC 의 원천 데이터로 사용.
 *
 * stock_qty 매핑:
 *   in_stock  = 1
 *   sold_out  = 0
 *   unknown   = NULL (RPC 에서 제외)
 *
 * 호출 빈도: 매일 KST 02:30 1회 권장 (run-crons.mjs 또는 vercel cron).
 * idempotent: 같은 SKU·같은 KST 날짜에 한 row만 (unique(goods_no, snapshot_date)).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { isAuthorizedCron } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'

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
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'ko-KR,ko;q=0.9',
      Cookie: cookieHeader(),
      ...(init.headers || {}),
    },
  })
  setCookies(res.headers.get('set-cookie'))
  return res
}

async function ggsanLogin(): Promise<boolean> {
  const BASE = process.env.GGSAN_BASE_URL || 'https://www.ggsan.com'
  const user = process.env.GGSAN_USER
  const pass = process.env.GGSAN_PASS
  if (!user || !pass) return false
  cookies.clear()
  await ggsanFetch(`${BASE}/member/login.php`)
  const r = await ggsanFetch(`${BASE}/member/login_ps.php`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${BASE}/member/login.php`,
    },
    body: new URLSearchParams({
      loginId: user,
      loginPwd: pass,
      saveId: 'y',
      returnUrl: `${BASE}/main/index.php`,
    }).toString(),
  })
  const html = await r.text()
  return /parent\.location\.href='https:\/\/www\.ggsan\.com\/main\/index\.php'/.test(html)
}

async function checkStock(goodsNo: string): Promise<'in_stock' | 'sold_out' | 'unknown'> {
  const BASE = process.env.GGSAN_BASE_URL || 'https://www.ggsan.com'
  try {
    const r = await ggsanFetch(`${BASE}/goods/goods_view.php?goodsNo=${goodsNo}`)
    if (!r.ok) return 'unknown'
    const html = await r.text()
    if (/재입고\s*알림|품절|매진|일시품절|판매\s*중지/.test(html.slice(0, 30000))) return 'sold_out'
    if (/name=["']set_goods_price["'][^>]*value=["'](\d+)/.test(html)) return 'in_stock'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

const statusToQty: Record<string, number | null> = {
  in_stock: 1,
  sold_out: 0,
  unknown: null,
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const limit = Math.max(1, Math.min(2000, parseInt(url.searchParams.get('limit') ?? '500', 10) || 500))
  const t0 = Date.now()

  // generated types 에 새 테이블이 없어 service-role + any 캐스팅
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any

  // active SKU 만 — last_seen_at 최신순 (= 카탈로그에 실제로 살아있는 것)
  const { data: products, error: prodErr } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no')
    .eq('status', 'active')
    .order('last_seen_at', { ascending: false })
    .limit(limit)

  if (prodErr) {
    return NextResponse.json({ ok: false, error: `products query: ${prodErr.message}` }, { status: 500 })
  }

  const list = (products ?? []) as Array<{ goods_no: string }>
  if (list.length === 0) {
    return NextResponse.json({ ok: true, total: 0, message: 'no active products' })
  }

  const loggedIn = await ggsanLogin()
  if (!loggedIn) {
    return NextResponse.json({ ok: false, error: 'ggsan login failed (check GGSAN_USER/GGSAN_PASS)' }, { status: 500 })
  }

  const snapshotAt = new Date().toISOString()
  const rows: Array<{ goods_no: string; stock_qty: number | null; stock_status: string; snapshot_at: string }> = []
  let inStock = 0
  let soldOut = 0
  let unknown = 0

  for (const p of list) {
    const status = await checkStock(p.goods_no)
    if (status === 'in_stock') inStock++
    else if (status === 'sold_out') soldOut++
    else unknown++
    rows.push({
      goods_no: p.goods_no,
      stock_qty: statusToQty[status],
      stock_status: status,
      snapshot_at: snapshotAt,
    })
    // 간단한 throttle — ggsan 측 차단 회피
    await new Promise((r) => setTimeout(r, 120))
  }

  // 같은 KST 날짜의 중복 row 를 upsert 로 처리 (unique(goods_no, snapshot_date))
  let inserted = 0
  let upsertErr: string | null = null
  const chunkSize = 200
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize)
    const { error } = await sb
      .from('jimscanner_ggsan_stock_history')
      .upsert(chunk, { onConflict: 'goods_no,snapshot_date' })
    if (error) {
      upsertErr = error.message
      break
    }
    inserted += chunk.length
  }

  // 감사 로그 — 기존 jimscanner_trends_runs 사용 (source='ggsan_stock_snapshot')
  try {
    await sb.from('jimscanner_trends_runs').insert({
      source: 'ggsan_stock_snapshot',
      status: upsertErr ? 'error' : 'ok',
      fetched_count: list.length,
      inserted_count: inserted,
      duration_ms: Date.now() - t0,
      error_message: upsertErr,
      triggered_by: 'vercel_cron',
      finished_at: new Date().toISOString(),
    })
  } catch {
    /* ignore audit log failures */
  }

  return NextResponse.json({
    ok: !upsertErr,
    total: list.length,
    in_stock: inStock,
    sold_out: soldOut,
    unknown,
    inserted,
    error: upsertErr,
    duration_ms: Date.now() - t0,
  })
}
