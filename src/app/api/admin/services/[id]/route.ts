import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { parseServicePrice } from '@/lib/service-price'
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

type RouteCtx = { params: Promise<{ id: string }> }

/**
 * 부가서비스 부분 수정.
 * body: { [col]: value, slug?: string }
 * price_text 변경 시 price_numeric/price_currency 자동 재파싱.
 */
export async function PATCH(request: NextRequest, ctx: RouteCtx) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const body = await request.json()

  const ALLOWED = new Set([
    'category',
    'service_name',
    'price_text',
    'description',
    'conditions',
    'display_order',
    'is_active',
  ])
  const patch: Record<string, unknown> = { source: 'manual' }
  for (const k of Object.keys(body)) {
    if (ALLOWED.has(k)) patch[k] = body[k]
  }

  // price_text 변경 시 숫자·통화 재파싱
  if ('price_text' in patch) {
    const parsed = parseServicePrice(patch.price_text as string | null)
    patch.price_numeric = parsed.price_numeric
    patch.price_currency = parsed.price_currency
  }

  if (Object.keys(patch).length === 1) {
    // source 만 바뀌는 건 의미 없음
    return NextResponse.json({ error: '수정할 필드 없음' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('forwarder_additional_services')
    .update(patch)
    .eq('id', id)
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (body.slug) revalidatePath(`/forwarders/${body.slug}`)
  return NextResponse.json({ ok: true, service: data })
}

export async function DELETE(request: NextRequest, ctx: RouteCtx) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const slug = request.nextUrl.searchParams.get('slug')

  const admin = createAdminClient()
  const { error } = await admin
    .from('forwarder_additional_services')
    .delete()
    .eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await logAdminAction({
    actor: user.email,
    action: 'service_delete',
    target_type: 'additional_service',
    target_id: id,
    summary: `부가서비스 삭제${slug ? ` (${slug})` : ''}`,
    metadata: slug ? { forwarder_slug: slug } : {},
  })

  if (slug) revalidatePath(`/forwarders/${slug}`)
  return NextResponse.json({ ok: true })
}
