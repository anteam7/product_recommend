import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { logAdminAction } from '@/lib/admin-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function requireAdmin() {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

const EDITABLE_COLUMNS = [
  'country',
  'center_name',
  'weight_min',
  'weight_max',
  'price_krw',
  'price_usd',
  'price_jpy',
  'price_cny',
  'service_label',
  'shipping_type',
  'member_grade',
  'grade_level',
]

const NUMERIC_COLUMNS = ['weight_min', 'weight_max', 'price_krw', 'price_usd', 'price_jpy', 'price_cny', 'grade_level']

function coerceValue(column: string, raw: unknown): number | string | null {
  if (raw === null || raw === undefined || raw === '') {
    return NUMERIC_COLUMNS.includes(column) ? null : null
  }
  if (NUMERIC_COLUMNS.includes(column)) {
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }
  return String(raw)
}

/**
 * 요금 행 일부 필드 업데이트.
 * body: { changes: Record<column, value>, slug?: string }
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const body = await request.json()
  const changes = body.changes as Record<string, unknown> | undefined
  if (!changes || Object.keys(changes).length === 0) {
    return NextResponse.json({ error: 'changes 비어 있음' }, { status: 400 })
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const [k, v] of Object.entries(changes)) {
    if (!EDITABLE_COLUMNS.includes(k)) continue
    update[k] = coerceValue(k, v)
  }

  const admin = createAdminClient()
  const { data, error } = await admin.from('shipping_rates').update(update).eq('id', id).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (body.slug) revalidatePath(`/forwarders/${body.slug}`)
  return NextResponse.json({ ok: true, rate: data })
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const slug = request.nextUrl.searchParams.get('slug')

  const admin = createAdminClient()
  const { error } = await admin.from('shipping_rates').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await logAdminAction({
    actor: user.email,
    action: 'rate_delete',
    target_type: 'rate_row',
    target_id: id,
    summary: `요금 행 삭제${slug ? ` (${slug})` : ''}`,
    metadata: slug ? { forwarder_slug: slug } : {},
  })

  if (slug) revalidatePath(`/forwarders/${slug}`)
  return NextResponse.json({ ok: true })
}
