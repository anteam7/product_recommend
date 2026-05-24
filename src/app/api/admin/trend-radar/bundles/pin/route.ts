/**
 * 묶음 후보 페어 핀 토글 — /admin/trend-radar/bundles 보드의 핀 액션 백엔드.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: { id?: string; pinned?: boolean; notes?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const id = body.id?.trim()
  if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 })
  const pinned = Boolean(body.pinned)

  const admin = createAdminClient()
  // 신규 테이블 — supabase types 재생성 전. as any 캐스팅.
  const update: Record<string, unknown> = {
    pinned,
    pinned_at: pinned ? new Date().toISOString() : null,
  }
  if (typeof body.notes === 'string') update.pinned_notes = body.notes

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawAdmin = admin as any
  const { error } = await rawAdmin
    .from('jimscanner_trends_bundle_candidates')
    .update(update)
    .eq('id', id) as { error: { message: string } | null }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, id, pinned })
}
