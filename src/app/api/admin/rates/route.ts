import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

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
 * 신규 요금 행 추가.
 * body: { forwarder_id, country, center_name?, weight_min, weight_max,
 *         price_krw?, price_usd?, price_jpy?, shipping_type?, member_grade?, grade_level? }
 */
export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  if (!body.forwarder_id || !body.country) {
    return NextResponse.json({ error: 'forwarder_id, country 필수' }, { status: 400 })
  }

  const admin = createAdminClient()
  const payload = {
    forwarder_id: body.forwarder_id,
    country: body.country,
    center_name: body.center_name ?? null,
    weight_min: Number(body.weight_min ?? 0),
    weight_max: Number(body.weight_max ?? 0),
    price_krw: body.price_krw != null && body.price_krw !== '' ? Number(body.price_krw) : null,
    price_usd: body.price_usd != null && body.price_usd !== '' ? Number(body.price_usd) : null,
    price_jpy: body.price_jpy != null && body.price_jpy !== '' ? Number(body.price_jpy) : null,
    shipping_type: body.shipping_type ?? 'air',
    member_grade: body.member_grade ?? '일반',
    grade_level: Number(body.grade_level ?? 1),
  }

  const { data, error } = await admin.from('shipping_rates').insert(payload).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (body.slug) revalidatePath(`/forwarders/${body.slug}`)
  return NextResponse.json({ ok: true, rate: data })
}
