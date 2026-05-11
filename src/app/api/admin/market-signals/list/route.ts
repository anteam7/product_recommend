import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_SOURCES = new Set([
  'google_suggest',
  'naver_news',
  'naver_blog',
  'clien_park',
  'quasarzone_sale',
  'kca_press',
])

async function requireAdmin() {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

export async function GET(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const source = searchParams.get('source')
  const q = (searchParams.get('q') ?? '').trim()
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1)
  const limit = Math.min(
    200,
    Math.max(10, parseInt(searchParams.get('limit') ?? '50', 10) || 50),
  )
  const offset = (page - 1) * limit

  const admin = createAdminClient()
  let query = admin
    .from('jimscanner_market_raw')
    .select('id, source, title, source_url, query, metadata, captured_at', {
      count: 'exact',
    })
    .order('captured_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (source && ALLOWED_SOURCES.has(source)) {
    query = query.eq('source', source)
  }
  if (q) {
    // PostgREST or 필터 깨지지 않도록 일부 특수문자 제거
    const safe = q.replace(/[,()]/g, ' ').trim()
    if (safe) query = query.ilike('title', `%${safe}%`)
  }
  if (from) query = query.gte('captured_at', from)
  if (to) query = query.lte('captured_at', to)

  const { data, count, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    items: data ?? [],
    total: count ?? 0,
    page,
    limit,
    has_more: (count ?? 0) > offset + (data?.length ?? 0),
  })
}
