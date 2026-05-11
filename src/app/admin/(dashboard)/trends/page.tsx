import { createAdminClient } from '@/lib/auth/admin-supabase'
import TrendsPanel, { type TrendItem, type RunRow } from './TrendsPanel'

export const dynamic = 'force-dynamic'

type KeywordRow = {
  keyword: string
  source: string
  category: string | null
  category_top: string | null
  volume_relative: number | null
  collected_at: string
}

type PinRow = {
  keyword: string
  source: string
  pinned_at: string
  notes: string | null
}

export default async function TrendsPage() {
  const supabase = createAdminClient()

  const since = new Date(Date.now() - 14 * 86400_000).toISOString()

  const [kwRes, pinRes, runRes] = await Promise.all([
    supabase
      .from('jimscanner_trends_keywords')
      .select('keyword, source, category, category_top, volume_relative, collected_at')
      .gte('collected_at', since)
      .order('collected_at', { ascending: false })
      .limit(2000),
    supabase
      .from('jimscanner_trends_pins')
      .select('keyword, source, pinned_at, notes'),
    supabase
      .from('jimscanner_trends_runs')
      .select('source, status, fetched_count, inserted_count, duration_ms, error_message, started_at, triggered_by')
      .order('started_at', { ascending: false })
      .limit(20),
  ])

  const allKw = (kwRes.data ?? []) as KeywordRow[]
  const pins = (pinRes.data ?? []) as PinRow[]
  const pinSet = new Set(pins.map((p) => `${p.keyword}|${p.source}`))
  const pinNotes = new Map(pins.map((p) => [`${p.keyword}|${p.source}`, p.notes ?? '']))

  // (keyword, source) 별 그룹화 — latest 1개 + 시계열
  type Bucket = { rows: KeywordRow[] }
  const groups = new Map<string, Bucket>()
  for (const r of allKw) {
    const k = `${r.keyword}|${r.source}`
    if (!groups.has(k)) groups.set(k, { rows: [] })
    groups.get(k)!.rows.push(r)
  }

  const items: TrendItem[] = []
  for (const [k, b] of groups) {
    const sorted = b.rows.slice().sort((a, b) => a.collected_at.localeCompare(b.collected_at))
    const latest = sorted[sorted.length - 1]
    const sparkline = sorted.slice(-7).map((r) => r.volume_relative ?? 0)
    const prev7 = sorted.slice(-14, -7).map((r) => r.volume_relative ?? 0)
    const avgLast = sparkline.length > 0 ? sparkline.reduce((a, b) => a + b, 0) / sparkline.length : 0
    const avgPrev = prev7.length > 0 ? prev7.reduce((a, b) => a + b, 0) / prev7.length : 0
    const velocity = avgPrev > 0 ? (avgLast - avgPrev) / avgPrev : null
    items.push({
      keyword: latest.keyword,
      source: latest.source,
      category: latest.category,
      categoryTop: latest.category_top,
      volume: latest.volume_relative,
      lastAt: latest.collected_at,
      sparkline,
      velocity,
      pinned: pinSet.has(k),
      notes: pinNotes.get(k) ?? '',
      sampleCount: sorted.length,
    })
  }
  items.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return (b.volume ?? 0) - (a.volume ?? 0)
  })

  const runs: RunRow[] = (runRes.data ?? []).map((r) => ({
    source: r.source,
    status: r.status,
    fetched: r.fetched_count,
    inserted: r.inserted_count,
    durationMs: r.duration_ms,
    error: r.error_message,
    startedAt: r.started_at,
    triggeredBy: r.triggered_by,
  }))

  return (
    <div className="max-w-6xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">트렌드 레이더</h1>
        <p className="mt-1 text-sm text-gray-500">
          Naver DataLab 검색어 트렌드 + 쇼핑 카테고리 인기도. 글감 후보를 핀해두면 블로그 초안 워크플로에 연결.
        </p>
        <p className="mt-1 text-xs text-gray-400">
          매일 자동 수집 (검색어 KST 06시 / 쇼핑 KST 06:10). 절대 검색량이 아닌 0~100 상대 ratio.
        </p>
      </header>
      <TrendsPanel items={items} runs={runs} />
    </div>
  )
}
