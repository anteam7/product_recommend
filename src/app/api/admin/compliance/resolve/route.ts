import { NextResponse, type NextRequest } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createClient, isAdminEmail } from '@/lib/auth/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** body { finding_id: string, resolution_note: string } */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => ({}))) as {
    finding_id?: string
    resolution_note?: string
  }
  if (!body.finding_id || !body.resolution_note?.trim()) {
    return NextResponse.json(
      { error: 'finding_id, resolution_note required' },
      { status: 400 },
    )
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'env missing' }, { status: 500 })
  const admin = createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // 신규 테이블 → types/supabase.ts 에 아직 없음. as any 캐스팅.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminAny = admin as any
  const { error } = await adminAny
    .from('jimscanner_compliance_findings')
    .update({
      resolved_at: new Date().toISOString(),
      resolved_by: user.email ?? 'admin',
      resolution_note: body.resolution_note.trim(),
    })
    .eq('id', body.finding_id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
