/**
 * 속성 피벗 leaf 키워드를 핀 후보로 승격.
 *  body: { pivotId: string }
 *  - jimscanner_trends_pins 에 keyword=derived_query / source='niche_pivot' 으로 upsert
 *  - jimscanner_trends_niche_pivots.promoted_to_pin = true / promoted_at 갱신
 */
import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => ({}))) as { pivotId?: string }
  if (!body.pivotId) {
    return NextResponse.json({ error: 'pivotId required' }, { status: 400 })
  }

  const admin = createAdminClient()

  const { data: pivot, error: pivotErr } = await admin
    .from('jimscanner_trends_niche_pivots' as any)
    .select('id, derived_query, pivot_axis, pivot_value, parent_product_id')
    .eq('id', body.pivotId)
    .maybeSingle()
  if (pivotErr || !pivot) {
    return NextResponse.json({ error: pivotErr?.message ?? 'pivot not found' }, { status: 404 })
  }

  const p = pivot as any
  const notes = `niche-pivot ${p.pivot_axis}:${p.pivot_value} (parent=${p.parent_product_id})`

  const { error: pinErr } = await admin.from('jimscanner_trends_pins').upsert(
    {
      keyword: p.derived_query,
      source: 'niche_pivot',
      notes,
      pinned_at: new Date().toISOString(),
    },
    { onConflict: 'keyword,source' },
  )
  if (pinErr) {
    return NextResponse.json({ error: pinErr.message }, { status: 500 })
  }

  const { error: updErr } = await admin
    .from('jimscanner_trends_niche_pivots' as any)
    .update({ promoted_to_pin: true, promoted_at: new Date().toISOString() })
    .eq('id', body.pivotId)
  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, keyword: p.derived_query })
}
