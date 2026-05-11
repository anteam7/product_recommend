import { NextResponse } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { GOV_NEWS_QUERIES } from '@/lib/market-keywords'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SOURCES = [
  'google_suggest',
  'naver_news',
  'naver_blog',
  'clien_park',
  'quasarzone_sale',
  'kca_press',
] as const

async function requireAdmin() {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

type Row = {
  source: string
  captured_at: string
  title: string | null
  source_url: string | null
  query: string | null
  metadata: Record<string, unknown> | null
}

export async function GET() {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const now = Date.now()
  const since7d = new Date(now - 7 * 86400_000).toISOString()
  const since24h = new Date(now - 24 * 3600_000).toISOString()
  const since1h = new Date(now - 3600_000).toISOString()

  // 7일치 raw 행 모두 (표·차트·필터 공용)
  const { data: rows7d } = await admin
    .from('jimscanner_market_raw')
    .select('source, captured_at, title, source_url, query, metadata')
    .gte('captured_at', since7d)
    .order('captured_at', { ascending: false })
    .limit(5000)
  const rows = (rows7d ?? []) as Row[]

  // source 별 전체 누적 (head:true 로 빠르게)
  const totalsAll: Record<string, number> = {}
  await Promise.all(
    SOURCES.map(async (s) => {
      const { count } = await admin
        .from('jimscanner_market_raw')
        .select('id', { count: 'exact', head: true })
        .eq('source', s)
      totalsAll[s] = count ?? 0
    }),
  )

  // 카운터 누산
  const counters = new Map<
    string,
    { total7d: number; last24h: number; last1h: number }
  >()
  for (const s of SOURCES) counters.set(s, { total7d: 0, last24h: 0, last1h: 0 })

  for (const r of rows) {
    const c = counters.get(r.source)
    if (!c) continue
    c.total7d++
    if (r.captured_at >= since24h) c.last24h++
    if (r.captured_at >= since1h) c.last1h++
  }

  const stats = SOURCES.map((s) => ({
    source: s,
    total: totalsAll[s] ?? 0,
    last7d: counters.get(s)?.total7d ?? 0,
    last24h: counters.get(s)?.last24h ?? 0,
    last1h: counters.get(s)?.last1h ?? 0,
  }))

  // 7일 일별 추이 (소스별 분리)
  const trend: { day: string; counts: Record<string, number>; total: number }[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now - i * 86400_000)
    trend.push({ day: d.toISOString().slice(0, 10), counts: {}, total: 0 })
  }
  const dayIdx = new Map(trend.map((t, i) => [t.day, i]))
  for (const r of rows) {
    const day = r.captured_at.slice(0, 10)
    const i = dayIdx.get(day)
    if (i == null) continue
    trend[i].counts[r.source] = (trend[i].counts[r.source] ?? 0) + 1
    trend[i].total++
  }

  // 정부 공지 — kca_press 전부 + naver_news 의 query 가 GOV_NEWS_QUERIES 에 속한 것
  const govSet = new Set<string>(GOV_NEWS_QUERIES)
  const govRecent = rows
    .filter(
      (r) =>
        r.source === 'kca_press' ||
        (r.source === 'naver_news' && r.query && govSet.has(r.query)),
    )
    .slice(0, 12)
    .map((r) => ({
      source: r.source,
      title: r.title,
      url: r.source_url,
      query: r.query,
      captured_at: r.captured_at,
      pubDate: (r.metadata as { pubDate?: string } | null)?.pubDate ?? null,
    }))

  // 인기 자동완성 query (google_suggest 의 seed query 별 빈도)
  const queryFreq = new Map<string, number>()
  for (const r of rows) {
    if (r.source !== 'google_suggest' || !r.query) continue
    queryFreq.set(r.query, (queryFreq.get(r.query) ?? 0) + 1)
  }
  const topQueries = [...queryFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([query, count]) => ({ query, count }))

  // 최근 핫딜 (quasarzone)
  const recentDeals = rows
    .filter((r) => r.source === 'quasarzone_sale')
    .slice(0, 12)
    .map((r) => ({
      title: r.title,
      url: r.source_url,
      site_label:
        (r.metadata as { site_label?: string } | null)?.site_label ?? null,
      captured_at: r.captured_at,
    }))

  // 최근 블로그 후기 트렌드 (naver_blog)
  const recentBlogs = rows
    .filter((r) => r.source === 'naver_blog')
    .slice(0, 10)
    .map((r) => ({
      title: r.title,
      url: r.source_url,
      query: r.query,
      bloggername:
        (r.metadata as { bloggername?: string } | null)?.bloggername ?? null,
      captured_at: r.captured_at,
    }))

  return NextResponse.json({
    stats,
    trend,
    gov_recent: govRecent,
    top_queries: topQueries,
    recent_deals: recentDeals,
    recent_blogs: recentBlogs,
    generated_at: new Date().toISOString(),
  })
}
