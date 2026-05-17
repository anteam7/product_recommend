import { NextResponse } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface ApplyBody {
  product_id: string
  category_top?: string | null
  category_mid?: string | null
  intent_label?: string | null
  status: 'classified' | 'pinned' | 'rejected' | 'snoozed' | 'note'
  note?: string | null
  snooze_days?: number | null
}

const VALID_STATUS = new Set(['classified', 'pinned', 'rejected', 'snoozed', 'note'])

export async function POST(req: Request) {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: ApplyBody
  try {
    body = (await req.json()) as ApplyBody
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  if (!body.product_id || !VALID_STATUS.has(body.status)) {
    return NextResponse.json({ error: 'product_id + valid status required' }, { status: 400 })
  }

  const admin = createAdminClient()

  // RPC 는 DB(supabase/trends_v4_triage_inbox.sql)에 존재. 타입 미반영 — `npm run gen:types` 후 as never 제거.
  const { data, error } = await admin.rpc('jimscanner_classify_apply' as never, {
    p_product_id: body.product_id,
    p_category_top: body.category_top ?? null,
    p_category_mid: body.category_mid ?? null,
    p_intent_label: body.intent_label ?? null,
    p_status: body.status,
    p_note: body.note ?? null,
    p_actor: user.email ?? 'admin',
    p_snooze_days: body.snooze_days ?? (body.status === 'snoozed' ? 7 : null),
  } as never)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, result: data })
}
