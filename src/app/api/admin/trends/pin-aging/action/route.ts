import { NextResponse, type NextRequest } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createClient, isAdminEmail } from '@/lib/auth/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Action = 'revive' | 'hold' | 'drop'

const PIN_AGING_URL = '/admin/trend-radar/pin-aging'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // form POST (multipart/form-encoded) 또는 JSON 둘 다 허용
  const contentType = request.headers.get('content-type') ?? ''
  let productId: string | null = null
  let action: Action | null = null

  if (contentType.includes('application/json')) {
    const body = (await request.json().catch(() => ({}))) as {
      product_id?: string
      action?: Action
    }
    productId = body.product_id ?? null
    action = body.action ?? null
  } else {
    const form = await request.formData()
    productId = (form.get('product_id') as string | null) ?? null
    action = (form.get('action') as Action | null) ?? null
  }

  if (!productId || !action || !['revive', 'hold', 'drop'].includes(action)) {
    return NextResponse.json({ error: 'product_id, action required' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'env missing' }, { status: 500 })
  const admin = createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const now = new Date().toISOString()
  // jimscanner_trends_products 컬럼은 supabase/trends_v4_pin_aging.sql 마이그레이션 후 추가됨 — 타입 미반영.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const productsTable = (admin as any).from('jimscanner_trends_products')

  if (action === 'drop') {
    const { error } = await productsTable
      .update({
        pinned: false,
        pin_action: 'drop',
        pin_action_at: now,
        pin_reason: 'stale-pin',
      })
      .eq('id', productId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else if (action === 'hold') {
    const holdUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    const { error } = await productsTable
      .update({
        pin_action: 'hold',
        pin_action_at: now,
        pin_hold_until: holdUntil,
        pin_reason: null,
      })
      .eq('id', productId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    // revive — 핀 유지, 발행 후보 마커
    const { error } = await productsTable
      .update({
        pin_action: 'revive',
        pin_action_at: now,
        pin_hold_until: null,
        pin_reason: 'publish-candidate',
      })
      .eq('id', productId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // form submit 인 경우 페이지로 redirect
  if (!contentType.includes('application/json')) {
    return NextResponse.redirect(new URL(PIN_AGING_URL, request.url), { status: 303 })
  }
  return NextResponse.json({ ok: true, action, product_id: productId })
}
