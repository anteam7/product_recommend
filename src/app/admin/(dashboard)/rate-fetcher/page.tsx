import { createAdminClient } from '@/lib/auth/admin-supabase'
import { ALL_FETCHER_SLUGS, PLAYWRIGHT_SLUGS } from '@/lib/rate-fetchers/run'
import RateFetcherPanel, { type SiteEntry } from './RateFetcherPanel'

export const dynamic = 'force-dynamic'

const PLAYWRIGHT_SET = new Set<string>(PLAYWRIGHT_SLUGS as readonly string[])

export default async function RateFetcherPage() {
  const supabase = createAdminClient()

  const { data: forwarders } = await supabase
    .from('forwarders')
    .select('id, slug, name')
    .in('slug', ALL_FETCHER_SLUGS)

  const fwdById = new Map<string, { slug: string; name: string }>()
  const fwdBySlug = new Map<string, string>()
  for (const f of forwarders ?? []) {
    fwdById.set(f.id, { slug: f.slug, name: f.name })
    fwdBySlug.set(f.slug, f.id)
  }

  const { data: sources } = await supabase
    .from('jimscanner_forwarder_info_sources')
    .select('forwarder_id, last_fetched_at, last_fetch_status, is_active')
    .eq('source_type', 'rates')
    .eq('is_active', true)

  type Meta = { count: number; last: string | null; status: string | null }
  const meta = new Map<string, Meta>()
  for (const s of sources ?? []) {
    const cur = meta.get(s.forwarder_id) ?? { count: 0, last: null, status: null }
    cur.count++
    if (s.last_fetched_at && (!cur.last || s.last_fetched_at > cur.last)) {
      cur.last = s.last_fetched_at
      cur.status = s.last_fetch_status
    }
    meta.set(s.forwarder_id, cur)
  }

  const sites: SiteEntry[] = ALL_FETCHER_SLUGS.map((slug) => {
    const fid = fwdBySlug.get(slug)
    const m = fid ? meta.get(fid) : null
    const f = fid ? fwdById.get(fid) : null
    return {
      slug,
      name: f?.name ?? slug,
      isPlaywright: PLAYWRIGHT_SET.has(slug),
      sourceCount: m?.count ?? 0,
      lastFetchedAt: m?.last ?? null,
      lastStatus: m?.status ?? null,
    }
  }).sort((a, b) => {
    // Playwright 사이트는 끝으로
    if (a.isPlaywright !== b.isPlaywright) return a.isPlaywright ? 1 : -1
    return a.slug.localeCompare(b.slug)
  })

  return (
    <div className="max-w-5xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">요금 자동 갱신</h1>
        <p className="mt-1 text-sm text-gray-500">
          사이트별 요금표를 직접 페치해서 <code>shipping_rates</code> 에 반영합니다. <code>(forwarder, country)</code> 단위 wipe-and-replace.
        </p>
        <p className="mt-1 text-xs text-gray-400">
          Vercel cron 매일 KST 05시 자동 실행 (비-Playwright 21개). Playwright 사이트 4개는 CLI 에서 실행.
        </p>
      </header>
      <RateFetcherPanel sites={sites} />
    </div>
  )
}
