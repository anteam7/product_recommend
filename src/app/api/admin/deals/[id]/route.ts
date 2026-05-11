import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { logAdminAction } from '@/lib/admin-log'
import { saleEventSlugify, type SaleEventInput, SALE_EVENT_STATUSES } from '@/lib/deals'

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

const EDITABLE_FIELDS: (keyof SaleEventInput)[] = [
  'name',
  'country',
  'start_at',
  'end_at',
  'categories',
  'description',
  'external_url',
  'recommended_forwarders',
  'related_blog_tags',
  'priority',
  'status',
]

type Ctx = { params: Promise<{ id: string }> }

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const body = (await request.json().catch(() => ({}))) as Partial<SaleEventInput>

  const update: Record<string, unknown> = {}
  for (const k of EDITABLE_FIELDS) {
    if (k in body) update[k as string] = body[k]
  }
  if (typeof body.name === 'string' && body.name.trim()) {
    update.slug = saleEventSlugify(body.name) || null
  }
  if (
    typeof body.status === 'string' &&
    !(SALE_EVENT_STATUSES as string[]).includes(body.status)
  ) {
    return NextResponse.json({ error: 'invalid status' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: before } = await admin
    .from('jimscanner_sale_events')
    .select('status, name')
    .eq('id', id)
    .maybeSingle<{ status: string; name: string }>()

  const { data, error } = await admin
    .from('jimscanner_sale_events')
    .update(update)
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const statusChanged = update.status && before && update.status !== before.status
  const summary = statusChanged
    ? `세일 상태 변경: ${data.name} · ${before!.status} → ${update.status}`
    : `세일 편집: ${data.name}`

  await logAdminAction({
    actor: user.email,
    action: statusChanged ? `deal_status_${update.status}` : 'deal_update',
    target_type: 'sale_event',
    target_id: id,
    summary,
    metadata: statusChanged ? { from: before!.status, to: update.status } : undefined,
  })

  // active로 진입하거나 active였다가 바뀐 경우 프론트 퍼지
  if (data.status === 'active' || before?.status === 'active') {
    revalidatePath('/deals', 'layout')
    revalidatePath('/', 'layout')
  }

  return NextResponse.json({ ok: true, event: data })
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const admin = createAdminClient()

  const { data: before } = await admin
    .from('jimscanner_sale_events')
    .select('name, status')
    .eq('id', id)
    .maybeSingle<{ name: string; status: string }>()

  const { error } = await admin.from('jimscanner_sale_events').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await logAdminAction({
    actor: user.email,
    action: 'deal_delete',
    target_type: 'sale_event',
    target_id: id,
    summary: `세일 이벤트 삭제: ${before?.name ?? id}`,
    metadata: before ? { previous_status: before.status } : undefined,
  })

  if (before?.status === 'active') {
    revalidatePath('/deals', 'layout')
    revalidatePath('/', 'layout')
  }

  return NextResponse.json({ ok: true })
}
