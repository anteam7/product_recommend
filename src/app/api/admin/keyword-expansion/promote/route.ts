import { NextResponse, type NextRequest } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createClient, isAdminEmail } from '@/lib/auth/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 키워드 확장 트리에서 '공백 후보' 노드를 핀(jimscanner_trends_pins)으로 승급.
 * body: { keyword: string, source: string }
 *   - source 는 자동완성 출처 ('google_suggest' / 'naver_suggest') — 핀에는 그대로 기록해
 *     어디서 발굴된 long-tail 인지 추적.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => ({}))) as {
    keyword?: string
    source?: string
  }
  if (!body.keyword || !body.source) {
    return NextResponse.json({ error: 'keyword, source required' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'env missing' }, { status: 500 })
  const admin = createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { error } = await admin.from('jimscanner_trends_pins').upsert(
    {
      keyword: body.keyword,
      source: body.source,
      notes: 'promoted from keyword-tree (long-tail gap)',
      pinned_at: new Date().toISOString(),
    },
    { onConflict: 'keyword,source' },
  )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
