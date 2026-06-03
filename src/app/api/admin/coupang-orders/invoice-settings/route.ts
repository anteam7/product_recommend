import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { logAdminAction } from '@/lib/admin-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SETTINGS_TABLE = 'jimscanner_coupang_invoice_settings'
const SETTINGS_ID = 1

async function requireAdmin() {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

/**
 * ggsan↔쿠팡 송장 자동등록 토글.
 * jimscanner_coupang_invoice_settings(id=1) 단일행 — auto_upload(bool, 기본 false).
 *   false = 반자동(cron은 발송감지·검증·pending까지, 사람이 UI에서 [확인·등록])
 *   true  = 자동(cron이 register-invoice 즉시 호출)
 */

// GET: 현재 auto_upload 반환. 행 없으면 false.
export async function GET() {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: '권한 없음' }, { status: 401 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any
  const { data, error } = await admin
    .from(SETTINGS_TABLE)
    .select('auto_upload, updated_at')
    .eq('id', SETTINGS_ID)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    ok: true,
    auto_upload: data?.auto_upload === true,
    updated_at: data?.updated_at ?? null,
  })
}

// POST: { auto_upload: boolean } → id=1 upsert + updated_at.
export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: '권한 없음' }, { status: 401 })

  let body: { auto_upload?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ error: '잘못된 요청' }, { status: 400 }) }
  if (typeof body.auto_upload !== 'boolean') {
    return NextResponse.json({ error: 'auto_upload(boolean) 누락' }, { status: 400 })
  }
  const auto_upload = body.auto_upload

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any
  const now = new Date().toISOString()
  const { data, error } = await admin
    .from(SETTINGS_TABLE)
    .upsert({ id: SETTINGS_ID, auto_upload, updated_at: now }, { onConflict: 'id' })
    .select('auto_upload, updated_at')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await logAdminAction({
    actor: user.email,
    action: 'coupang_invoice_settings_update',
    target_type: 'coupang_invoice_settings',
    target_id: String(SETTINGS_ID),
    summary: `송장 자동등록 ${auto_upload ? 'ON(자동)' : 'OFF(반자동)'}`,
    metadata: { auto_upload },
  })
  revalidatePath('/admin/coupang-orders')

  return NextResponse.json({
    ok: true,
    auto_upload: data?.auto_upload === true,
    updated_at: data?.updated_at ?? now,
  })
}
