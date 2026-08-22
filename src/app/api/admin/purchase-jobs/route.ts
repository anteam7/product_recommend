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
 * 집 PC 실행 큐 — Vercel 이 직접 못 하는 일을 order-server 폴러가 집어 실행한다.
 *   mode full|stage           원격 결제진행(매입처 주문서 작성, Playwright) — 로컬 헬퍼에 닿지 않는 기기(모바일 등)의 릴레이
 *   mode coupang_ack          쿠팡 발주확인(결제완료→상품준비중)     ┐ Vercel IP 는 쿠팡 OpenAPI IP 접근제어 밖(403)이라
 *   mode coupang_invoice      쿠팡 송장등록(→배송지시, 발송완료)     ┘ 쿠팡 쓰기는 전부 집 PC 에서만 (2026-08-20)
 *   mode coupang_orders_sync  쿠팡 주문 즉시 수집(크론 전이라도) — order_key는 특정 주문이 아닌 고정 센티널
 * POST { order_key, mode? }  → 잡 등록 (같은 주문·같은 mode 가 대기/실행 중이면 409 + 그 id)
 * GET  ?id=N                 → 잡 상태 조회 (버튼이 폴링)
 */
const MODES = new Set(['full', 'stage', 'coupang_ack', 'coupang_invoice', 'coupang_orders_sync'])
export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: '권한 없음' }, { status: 401 })

  let body: { order_key?: string; mode?: string }
  try { body = await request.json() } catch { return NextResponse.json({ error: '잘못된 요청' }, { status: 400 }) }
  const orderKey = String(body.order_key ?? '').trim()
  if (!/^\d{6,24}$/.test(orderKey)) return NextResponse.json({ error: 'order_key 형식 오류' }, { status: 400 })
  const mode = body.mode && MODES.has(body.mode) ? body.mode : 'full'

  const sb = admin()
  // 중복 가드 — 같은 주문·같은 종류의 잡이 대기/실행 중이면 재등록 거부(409 + 기존 id → 클라이언트가 그 잡을 기다림)
  const { data: dup } = await sb.from('jimscanner_purchase_jobs')
    .select('id, status').eq('order_key', orderKey).eq('mode', mode).in('status', ['queued', 'running']).limit(1)
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
