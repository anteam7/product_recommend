import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import LifecycleClient from './LifecycleClient'

export const dynamic = 'force-dynamic'

const LIFECYCLE_LABELS = ['pre_peak', 'sustained', 'seasonal', 'fad', 'episodic'] as const
type Lifecycle = (typeof LIFECYCLE_LABELS)[number]

export interface LifecycleRow {
  id: string
  keyword: string
  source: string
  category_top: string | null
  classified_category: string | null
  volume_relative: number | null
  lifecycle_label: Lifecycle | null
  lifecycle_confidence: number | null
  half_life_days: number | null
  peak_at: string | null
  peak_volume: number | null
  acf_year: number | null
  acf_month: number | null
  acf_week: number | null
  collected_at: string
  // 30일 sparkline (day → volume avg)
  series: { day: string; volume: number }[]
}

async function fetchData(): Promise<{ rows: LifecycleRow[] }> {
  const sb = createAdminClient() as any

  // 최신 (keyword, source) 단위로 1행만 — lifecycle_computed_at 가 채워진 row 우선
  const { data: latest } = await sb
    .from('jimscanner_trends_keywords')
    .select(
      'id, keyword, source, category_top, classified_category, volume_relative, ' +
        'lifecycle_label, lifecycle_confidence, half_life_days, peak_at, peak_volume, ' +
        'acf_year, acf_month, acf_week, collected_at',
    )
    .not('lifecycle_label', 'is', null)
    .order('collected_at', { ascending: false })
    .limit(500)

  const rows = (latest ?? []) as any[]
  if (rows.length === 0) return { rows: [] }

  // (keyword, source) 별 최신 1개만
  const seen = new Set<string>()
  const dedup: any[] = []
  for (const r of rows) {
    const k = `${r.keyword}::${r.source}`
    if (seen.has(k)) continue
    seen.add(k)
    dedup.push(r)
  }

  // 각 키워드별 30일 sparkline
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { data: history } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, source, volume_relative, collected_at')
    .gte('collected_at', since)
    .in(
      'keyword',
      dedup.map((r) => r.keyword),
    )
    .limit(20000)

  const seriesMap = new Map<string, Map<string, { sum: number; n: number }>>()
  for (const h of (history ?? []) as any[]) {
    if (h.volume_relative == null) continue
    const k = `${h.keyword}::${h.source}`
    const day = (h.collected_at as string).slice(0, 10)
    if (!seriesMap.has(k)) seriesMap.set(k, new Map())
    const days = seriesMap.get(k)!
    const cur = days.get(day) ?? { sum: 0, n: 0 }
    cur.sum += Number(h.volume_relative)
    cur.n += 1
    days.set(day, cur)
  }

  const out: LifecycleRow[] = dedup.map((r) => {
    const k = `${r.keyword}::${r.source}`
    const days = seriesMap.get(k)
    const series = days
      ? Array.from(days.entries())
          .map(([day, v]) => ({ day, volume: v.sum / v.n }))
          .sort((a, b) => a.day.localeCompare(b.day))
      : []
    return { ...r, series } as LifecycleRow
  })

  return { rows: out }
}

export default async function LifecyclePage() {
  const { rows } = await fetchData()

  // 카테고리 × lifecycle 도넛용 집계
  const byCategory = new Map<string, Record<Lifecycle, number>>()
  for (const r of rows) {
    const cat = r.classified_category ?? r.category_top ?? 'unknown'
    if (!byCategory.has(cat)) {
      byCategory.set(cat, {
        pre_peak: 0,
        sustained: 0,
        seasonal: 0,
        fad: 0,
        episodic: 0,
      })
    }
    if (r.lifecycle_label) byCategory.get(cat)![r.lifecycle_label] += 1
  }

  const categorySummary = Array.from(byCategory.entries())
    .map(([cat, counts]) => ({
      category: cat,
      counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => b.total - a.total)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">키워드 Lifecycle</h1>
          <p className="text-sm text-gray-500 mt-1">
            Pre-peak / Sustained / Seasonal / Fad / Episodic — 진입 게이트.
            Fad + post-peak 키워드는 핀 등록 시 confirm-gate.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 lifecycle 분류 결과 없음</p>
          <p className="text-sm mt-2">
            <code className="font-mono">SELECT jimscanner_trends_classify_lifecycle_all();</code> 실행 후 다시 방문.
          </p>
        </div>
      ) : (
        <LifecycleClient rows={rows} categorySummary={categorySummary} />
      )}
    </div>
  )
}
