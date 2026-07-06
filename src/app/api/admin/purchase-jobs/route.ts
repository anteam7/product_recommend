import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function admin(): any { return createAdminClient() }

async function requireAdmin() {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

/**
 * 원격 결제진행 큐 — 로컬 헬퍼(127.0.0.1:39201)에 닿지 않는 기기(모바일 등)의 릴레이.
 * POST { order_key, mode? }  → 잡 등록 (집 PC의 order-server 폴러가 4초 내 집어 실행)
 * GET  ?id=N                 → 잡 상태 조회 (버튼이 폴링)
 */
export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: '권한 없음' }, { status: 401 })

  let body: { order_key?: string; mode?: string }
  try { body = await request.json() } catch { return NextResponse.json({ error: '잘못된 요청' }, { status: 400 }) }
  const orderKey = String(body.order_key ?? '').trim()
  if (!/^\d{6,24}$/.test(orderKey)) return NextResponse.json({ error: 'order_key 형식 오류' }, { status: 400 })
  const mode = body.mode === 'stage' ? 'stage' : 'full'

  const sb = admin()
  // 중복 가드 — 같은 주문의 잡이 대기/실행 중이면 재등록 거부
  const { data: dup } = await sb.from('jimscanner_purchase_jobs')
    .select('id, status').eq('order_key', orderKey).in('status', ['queued', 'running']).limit(1)
  if (dup?.length) return NextResponse.json({ error: `이미 진행 중인 잡(#${dup[0].id}, ${dup[0].status})이 있습니다`, id: dup[0].id }, { status: 409 })

  const { data, error } = await sb.from('jimscanner_purchase_jobs')
    .insert({ order_key: orderKey, mode, requested_by: user.email })
    .select('id').single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, id: data.id })
}

export async function GET(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: '권한 없음' }, { status: 401 })
  const id = Number(request.nextUrl.searchParams.get('id'))
  if (!Number.isFinite(id) || id <= 0) return NextResponse.json({ error: 'id 누락' }, { status: 400 })
  const { data, error } = await admin().from('jimscanner_purchase_jobs')
    .select('id, order_key, mode, status, result_msg, order_no, created_at, finished_at').eq('id', id).single()
  if (error || !data) return NextResponse.json({ error: '잡 없음' }, { status: 404 })
  return NextResponse.json({ ok: true, job: data })
}
