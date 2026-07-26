import { NextResponse } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function admin(): any { return createAdminClient() }

const STATUSES = ['candidate', 'running', 'excluded', 'hold']

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

// 광고 상품 관리 — 가격경쟁 가능 + 마진여유 + 수요신호가 있어 광고를 붙이면 팔릴 후보.
export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const sb = admin()
  const { data, error } = await sb
    .from('jimscanner_coupang_ad_products')
    .select('*')
    .order('ad_score', { ascending: false, nullsFirst: false })
    .limit(500)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ rows: data ?? [] })
}

// 광고 상태/메모 변경
export async function POST(req: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  let body: { seller_product_id?: string; ad_status?: string; note?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }) }
  const spid = body.seller_product_id
  if (!spid) return NextResponse.json({ error: 'seller_product_id 필요' }, { status: 400 })
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.ad_status !== undefined) {
    if (!STATUSES.includes(body.ad_status)) return NextResponse.json({ error: '허용되지 않은 상태' }, { status: 400 })
    patch.ad_status = body.ad_status
  }
  if (body.note !== undefined) patch.note = String(body.note).slice(0, 500)
  const sb = admin()
  const { error } = await sb.from('jimscanner_coupang_ad_products').update(patch).eq('seller_product_id', spid)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
