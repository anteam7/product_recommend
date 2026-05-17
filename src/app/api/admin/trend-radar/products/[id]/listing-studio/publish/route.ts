/**
 * 운영자가 외부 채널(스마트스토어 등)에 업로드 완료 후 토글하는 엔드포인트.
 *  body: { status: 'drafted' | 'published' }
 *  매칭 핀(jimscanner_trends_pins.listing_product_id 또는 alias 일치)의
 *  listing_status 를 갱신.
 */
import { NextResponse } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: productId } = await params
  const userSb = await createClient()
  const {
    data: { user },
  } = await userSb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as { status?: string }
  const status = body.status
  if (status !== 'drafted' && status !== 'published') {
    return NextResponse.json({ error: 'invalid_status' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: prod } = await admin
    .from('jimscanner_trends_products')
    .select('canonical_name')
    .eq('id', productId)
    .single()

  const { data: aliasRows } = await admin
    .from('jimscanner_trends_aliases')
    .select('alias')
    .eq('product_id', productId)

  const aliasKeywords = Array.from(
    new Set(
      [prod?.canonical_name, ...(aliasRows ?? []).map((a) => a.alias)].filter(
        Boolean,
      ) as string[],
    ),
  )

  const { error: err1 } = await (admin as any)
    .from('jimscanner_trends_pins')
    .update({ listing_status: status, listing_product_id: productId })
    .in('keyword', aliasKeywords.length ? aliasKeywords : ['__none__'])

  const { error: err2 } = await (admin as any)
    .from('jimscanner_trends_pins')
    .update({ listing_status: status })
    .eq('listing_product_id', productId)

  if (err1 || err2) {
    return NextResponse.json(
      { error: (err1 ?? err2)?.message ?? 'update_failed' },
      { status: 500 },
    )
  }

  return NextResponse.json({ ok: true, status })
}
