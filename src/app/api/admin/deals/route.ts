import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { logAdminAction } from '@/lib/admin-log'
import { saleEventSlugify, type SaleEventInput } from '@/lib/deals'
import type { TablesInsert } from '@/lib/supabase'

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

export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as Partial<SaleEventInput>
  if (!body.name || typeof body.name !== 'string') {
    return NextResponse.json({ error: 'name 필수' }, { status: 400 })
  }
  if (!body.country || typeof body.country !== 'string') {
    return NextResponse.json({ error: 'country 필수' }, { status: 400 })
  }

  const insert: Record<string, unknown> = {
    created_by: user.email,
    source: 'manual',
    status: body.status ?? 'active',
    slug: saleEventSlugify(body.name) || null,
  }
  for (const k of EDITABLE_FIELDS) {
    if (k in body) insert[k as string] = body[k]
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('jimscanner_sale_events')
    .insert(insert as TablesInsert<'jimscanner_sale_events'>)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await logAdminAction({
    actor: user.email,
    action: 'deal_create',
    target_type: 'sale_event',
    target_id: data.id,
    summary: `세일 이벤트 추가: ${data.name} (${data.country})`,
  })

  if (data.status === 'active') {
    revalidatePath('/deals', 'layout')
    revalidatePath('/', 'layout')
  }

  return NextResponse.json({ ok: true, event: data })
}
