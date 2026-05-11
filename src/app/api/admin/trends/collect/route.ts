import { NextResponse, type NextRequest } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { collectNaverSearchTrends, collectNaverShoppingTrends } from '@/lib/trends/collect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** 어드민 수동 트리거. body { source: 'naver_search_trend' | 'naver_shopping_insight' | 'all' } */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => ({}))) as { source?: string }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'env missing' }, { status: 500 })
  const admin = createSupabaseClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  if (body.source === 'naver_search_trend') {
    const r = await collectNaverSearchTrends(admin, 'admin')
    return NextResponse.json({ results: [r] })
  }
  if (body.source === 'naver_shopping_insight') {
    const r = await collectNaverShoppingTrends(admin, 'admin')
    return NextResponse.json({ results: [r] })
  }
  if (body.source === 'all' || !body.source) {
    const [a, b] = await Promise.all([
      collectNaverSearchTrends(admin, 'admin'),
      collectNaverShoppingTrends(admin, 'admin'),
    ])
    return NextResponse.json({ results: [a, b] })
  }
  return NextResponse.json({ error: `unknown source: ${body.source}` }, { status: 400 })
}
