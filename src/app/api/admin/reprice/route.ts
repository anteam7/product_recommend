import { NextResponse } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function admin(): any { return createAdminClient() }

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

// 가격수정 승인 대상 = REPRICE 판정 + 아직 미적용(repriced_at null). 승인분만 집PC 스크립트가 vendor-item API로 적용.
export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const sb = admin()
  const { data, error } = await sb
    .from('jimscanner_coupang_pricewatch')
    .select('seller_product_id, name, my_price, my_cost, msp_price_krw, market_low, market_median, match_count, best_match_title, reprice_target, margin_at_target, reprice_approved_at, sold_count, view_count, checked_at')
    .eq('price_verdict', 'REPRICE')
    .is('repriced_at', null)
    .order('reprice_target', { ascending: true, nullsFirst: false })
    .limit(300)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ rows: data ?? [] })
}

// 승인/승인취소 — DB 기록만(쿠팡 호출 없음, Vercel IP 허용목록과 무관). 적용은 집PC --reprice --apply.
export async function POST(req: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  let body: { seller_product_id?: string; approve?: boolean }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }) }
  const spid = body.seller_product_id
  if (!spid) return NextResponse.json({ error: 'seller_product_id 필요' }, { status: 400 })
  const sb = admin()
  const { error } = await sb
    .from('jimscanner_coupang_pricewatch')
    .update({ reprice_approved_at: body.approve ? new Date().toISOString() : null })
    .eq('seller_product_id', spid)
    .eq('price_verdict', 'REPRICE')       // REPRICE 판정 아닌 행 승인 방지
    .is('repriced_at', null)              // 이미 적용된 행 재승인 방지
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
