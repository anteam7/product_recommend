import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { logAdminAction } from '@/lib/admin-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 매입 카탈로그(/admin/purchase-catalog)에서 체크한 상품을 쿠팡 등록 큐에 넣는다.
// 실제 등록은 집 PC의 scripts/register-agent.mjs 가 폴링해 공급처별 등록 스크립트를 --only= 로 실행한다.
const TABLE = 'jimscanner_register_jobs'
// 쿠팡 등록 스크립트가 있는 매입처만 허용 — register-agent.mjs SOURCE_SCRIPTS 와 동기화 지점.
// beseller(네이버 전용)는 여기에 넣지 않는다.
const SUPPORTED_SOURCES = new Set(['wellroot', 'bio77', 'upickb2b', 'ggsan'])
const MAX_ITEMS = 100

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function admin(): any { return createAdminClient() }

async function requireAdmin() {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

interface Item { source: string; goods_no: string }

export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: '권한 없음' }, { status: 401 })

  let body: { items?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ error: '잘못된 요청' }, { status: 400 }) }

  const raw = Array.isArray(body.items) ? body.items : []
  if (!raw.length) return NextResponse.json({ error: '선택된 상품이 없습니다' }, { status: 400 })
  if (raw.length > MAX_ITEMS) return NextResponse.json({ error: `한 번에 ${MAX_ITEMS}건까지만 등록할 수 있습니다 (요청 ${raw.length}건)` }, { status: 400 })

  const items: Item[] = []
  const rejected: { goods_no: string; reason: string }[] = []
  for (const it of raw) {
    const source = String((it as Item)?.source ?? '').trim()
    const goodsNo = String((it as Item)?.goods_no ?? '').trim()
    if (!goodsNo || !/^[A-Za-z0-9_-]{1,40}$/.test(goodsNo)) { rejected.push({ goods_no: goodsNo || '(빈값)', reason: '상품번호 형식 오류' }); continue }
    if (!SUPPORTED_SOURCES.has(source)) { rejected.push({ goods_no: goodsNo, reason: `쿠팡 등록기가 없는 매입처(${source || '미상'})` }); continue }
    items.push({ source, goods_no: goodsNo })
  }
  if (!items.length) return NextResponse.json({ error: '등록 가능한 상품이 없습니다', rejected }, { status: 400 })

  const sb = admin()

  // 이미 쿠팡에 등록된 건은 큐에 넣지 않는다 (등록 스크립트도 막지만, 여기서 걸러야 사용자에게 이유가 보인다)
  const { data: listed } = await sb.from('jimscanner_coupang_listings')
    .select('source, source_goods_no, status')
    .in('source', [...new Set(items.map(i => i.source))])
    .in('source_goods_no', items.map(i => i.goods_no))
  const listedSet = new Set((listed ?? [])
    .filter((l: { status: string }) => l.status !== 'FAILED')
    .map((l: { source: string; source_goods_no: string }) => `${l.source}:${l.source_goods_no}`))

  // 대기/실행 중인 잡 중복 제거
  const { data: pending } = await sb.from(TABLE)
    .select('source, goods_no')
    .in('status', ['QUEUED', 'RUNNING'])
    .in('goods_no', items.map(i => i.goods_no))
  const pendingSet = new Set((pending ?? []).map((p: { source: string; goods_no: string }) => `${p.source}:${p.goods_no}`))

  const toInsert = items.filter(i => {
    const key = `${i.source}:${i.goods_no}`
    if (listedSet.has(key)) { rejected.push({ goods_no: i.goods_no, reason: '이미 쿠팡에 등록됨' }); return false }
    if (pendingSet.has(key)) { rejected.push({ goods_no: i.goods_no, reason: '이미 등록 대기 중' }); return false }
    return true
  })
  if (!toInsert.length) return NextResponse.json({ ok: true, queued: 0, rejected })

  const { data: inserted, error } = await sb.from(TABLE)
    .insert(toInsert.map(i => ({ source: i.source, goods_no: i.goods_no, requested_by: user.email })))
    .select('id, source, goods_no')
  if (error) return NextResponse.json({ error: error.message, rejected }, { status: 500 })

  const bySource = toInsert.reduce<Record<string, number>>((m, i) => { m[i.source] = (m[i.source] ?? 0) + 1; return m }, {})
  await logAdminAction({
    actor: user.email,
    action: 'register_jobs_enqueue',
    target_type: 'purchase_catalog',
    target_id: Object.keys(bySource).join(','),
    summary: `쿠팡 일괄등록 큐 ${inserted?.length ?? 0}건 (${Object.entries(bySource).map(([s, n]) => `${s} ${n}`).join(' · ')})${rejected.length ? ` · 제외 ${rejected.length}건` : ''}`,
    metadata: { items: toInsert, rejected },
  })
  revalidatePath('/admin/purchase-catalog')

  return NextResponse.json({ ok: true, queued: inserted?.length ?? 0, ids: (inserted ?? []).map((r: { id: string }) => r.id), rejected })
}

/** 큐 진행 상황 폴링 — ?ids=a,b,c 또는 최근 잡 목록 */
export async function GET(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: '권한 없음' }, { status: 401 })

  const ids = (request.nextUrl.searchParams.get('ids') ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const sb = admin()
  let query = sb.from(TABLE).select('id, source, goods_no, status, error, seller_product_id, requested_at, finished_at')
  query = ids.length
    ? query.in('id', ids.slice(0, 200))
    : query.order('requested_at', { ascending: false }).limit(50)
  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = (data ?? []) as { status: string }[]
  const counts = rows.reduce<Record<string, number>>((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m }, {})
  const active = (counts.QUEUED ?? 0) + (counts.RUNNING ?? 0)
  return NextResponse.json({ ok: true, jobs: data ?? [], counts, active })
}
