import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { parseServicePrice } from '@/lib/service-price'

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

/**
 * 신규 부가서비스 행 추가.
 * body: { forwarder_id, category, service_name, price_text?, description?,
 *         display_order?, is_active?, slug? }
 */
export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  if (!body.forwarder_id || !body.category || !body.service_name) {
    return NextResponse.json(
      { error: 'forwarder_id, category, service_name 필수' },
      { status: 400 },
    )
  }

  const parsed = parseServicePrice(body.price_text ?? null)

  const admin = createAdminClient()
  const payload = {
    forwarder_id: body.forwarder_id,
    category: body.category,
    service_name: body.service_name,
    price_text: body.price_text ?? null,
    price_numeric: parsed.price_numeric,
    price_currency: parsed.price_currency,
    description: body.description ?? null,
    display_order: body.display_order ?? 0,
    is_active: body.is_active ?? true,
    source: 'manual' as const,
  }

  const { data, error } = await admin
    .from('forwarder_additional_services')
    .insert(payload)
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (body.slug) revalidatePath(`/forwarders/${body.slug}`)
  return NextResponse.json({ ok: true, service: data })
}
