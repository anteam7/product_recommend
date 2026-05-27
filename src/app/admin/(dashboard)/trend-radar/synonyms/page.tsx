import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface ClusterRow {
  id: string
  canonical_label: string
  member_terms: string[]
  category_hint: string | null
  member_count: number
  source_count: number
  total_frequency: number
  refreshed_at: string
}

interface MapRow {
  cluster_id: string
  signal_kind: string
  surface_term: string
  source: string | null
  observed_at: string
}

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string | null
}

const CATEGORIES = ['all', 'health', 'living', 'digital', 'other'] as const
type Category = (typeof CATEGORIES)[number]

const CATEGORY_LABEL: Record<Category, string> = {
  all: '전체',
  health: '건강식품',
  living: '생활/리빙',
  digital: '디지털/가전',
  other: '기타',
}

const WINDOW_DAYS = 28

async function fetchData(category: Category) {
  const sb = createAdminClient()
  const since = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString()

  // 1) 클러스터
  const cq = sb
    .from('jimscanner_synonym_clusters' as never)
    .select('id, canonical_label, member_terms, category_hint, member_count, source_count, total_frequency, refreshed_at')
    .order('total_frequency', { ascending: false })
    .limit(200)
  if (category !== 'all') cq.eq('category_hint', category)
  const { data: clustersRaw } = (await cq) as { data: ClusterRow[] | null }
  const clusters = (clustersRaw ?? []) as ClusterRow[]

  if (clusters.length === 0) {
    return { clusters: [], mapByCluster: new Map<string, MapRow[]>(), productByName: new Map<string, ProductRow>(), kpis: { clusters: 0, signals: 0, multiSource: 0 } }
  }

  // 2) 매핑 (28일 윈도우)
  const ids = clusters.map((c) => c.id)
  const { data: mapRowsRaw } = (await sb
    .from('jimscanner_signal_cluster_map' as never)
    .select('cluster_id, signal_kind, surface_term, source, observed_at')
    .in('cluster_id', ids)
    .gte('observed_at', since)
    .limit(20000)) as { data: MapRow[] | null }
  const mapRows = (mapRowsRaw ?? []) as MapRow[]

  const mapByCluster = new Map<string, MapRow[]>()
  for (const r of mapRows) {
    const arr = mapByCluster.get(r.cluster_id) ?? []
    arr.push(r)
    mapByCluster.set(r.cluster_id, arr)
  }

  // 3) 자기SKU (trends_products) 후보 매칭 — surface_term 이 trends_products.canonical_name 과 매치되면 표시
  const productNames = new Set<string>()
  for (const c of clusters) for (const t of c.member_terms) productNames.add(t)
  const { data: prodsRaw } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('canonical_name', [...productNames].slice(0, 500))
  const productByName = new Map<string, ProductRow>()
  for (const p of (prodsRaw ?? []) as ProductRow[]) productByName.set(p.canonical_name, p)

  // KPIs
  const totalSignals = clusters.reduce((s, c) => s + c.total_frequency, 0)
  const multiSource = clusters.filter((c) => c.source_count >= 2).length

  return {
    clusters,
    mapByCluster,
    productByName,
    kpis: { clusters: clusters.length, signals: totalSignals, multiSource },
  }
}

function sparkline(map: MapRow[]): { bars: number[]; max: number } {
  // 28일 일별 카운트
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const bins = new Array(WINDOW_DAYS).fill(0)
  for (const r of map) {
    const t = new Date(r.observed_at)
    const dayDiff = Math.floor((today.getTime() - t.getTime()) / 86400_000)
    if (dayDiff < 0 || dayDiff >= WINDOW_DAYS) continue
    bins[WINDOW_DAYS - 1 - dayDiff]++
  }
  return { bars: bins, max: Math.max(1, ...bins) }
}

export default async function SynonymsPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string }>
}) {
  const sp = await searchParams
  const category = (CATEGORIES.includes(sp.cat as Category) ? sp.cat : 'all') as Category
  const { clusters, mapByCluster, productByName, kpis } = await fetchData(category)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">의미군 통합 수요</h1>
          <p className="text-sm text-gray-500 mt-1">
            동의어·줄임말·오타·영문/한글이 분산된 키워드를 합산해 진짜 수요를 본다 · {WINDOW_DAYS}일 윈도우
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <KpiCard label="의미군" value={kpis.clusters} hint={`category=${category}`} />
        <KpiCard label="합산 시그널 (28d)" value={kpis.signals} hint="멤버 시그널 누적" />
        <KpiCard label="다소스 클러스터" value={kpis.multiSource} hint="2+ 소스 등장" />
      </section>

      <nav className="flex gap-2 border-b border-gray-200">
        {CATEGORIES.map((c) => (
          <Link
            key={c}
            href={`/admin/trend-radar/synonyms?cat=${c}`}
            className={`px-3 py-2 text-sm ${
              category === c
                ? 'border-b-2 border-black font-semibold text-black'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {CATEGORY_LABEL[c]}
          </Link>
        ))}
      </nav>

      {clusters.length === 0 ? (
        <EmptyState />
      ) : (
        <section className="space-y-2">
          <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
            <div className="col-span-1">#</div>
            <div className="col-span-3">대표 라벨</div>
            <div className="col-span-1 text-right">합산</div>
            <div className="col-span-1 text-right">멤버</div>
            <div className="col-span-1 text-right">소스</div>
            <div className="col-span-2">28d 추세</div>
            <div className="col-span-2">멤버 (top 4)</div>
            <div className="col-span-1 text-right">SKU 매칭</div>
          </div>
          {clusters.map((c, i) => {
            const m = mapByCluster.get(c.id) ?? []
            const { bars, max } = sparkline(m)
            const surfaceFreq = new Map<string, number>()
            for (const r of m) surfaceFreq.set(r.surface_term, (surfaceFreq.get(r.surface_term) ?? 0) + 1)
            const ifSplitMax = Math.max(0, ...surfaceFreq.values())
            const memberPreview = [...surfaceFreq.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 4)
            const skuMatches = c.member_terms
              .map((t) => productByName.get(t))
              .filter(Boolean) as ProductRow[]
            return (
              <div
                key={c.id}
                className="grid grid-cols-12 px-3 py-2 rounded border border-gray-200 hover:bg-gray-50 transition-colors text-sm"
              >
                <div className="col-span-1 font-mono text-gray-400">{i + 1}</div>
                <div className="col-span-3">
                  <div className="font-medium">{c.canonical_label}</div>
                  <div className="text-xs text-gray-500">
                    {c.category_hint ?? '—'} · 분리됐을 때 최대 {ifSplitMax} → 통합 {c.total_frequency}
                  </div>
                </div>
                <div className="col-span-1 text-right font-mono font-bold">{c.total_frequency}</div>
                <div className="col-span-1 text-right font-mono text-gray-600">{c.member_count}</div>
                <div className="col-span-1 text-right font-mono text-gray-600">{c.source_count}</div>
                <div className="col-span-2">
                  <Sparkline bars={bars} max={max} />
                </div>
                <div className="col-span-2 flex flex-wrap gap-1">
                  {memberPreview.length === 0 ? (
                    <span className="text-xs text-gray-400">—</span>
                  ) : (
                    memberPreview.map(([term, n]) => (
                      <span
                        key={term}
                        className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-700"
                        title={`${term} · ${n}회`}
                      >
                        {term.length > 14 ? term.slice(0, 14) + '…' : term} · {n}
                      </span>
                    ))
                  )}
                </div>
                <div className="col-span-1 text-right">
                  {skuMatches.length > 0 ? (
                    <Link
                      href={`/admin/trend-radar/products/${skuMatches[0].id}`}
                      className="text-xs text-blue-600 hover:underline"
                      title={skuMatches.map((s) => s.canonical_name).join(', ')}
                    >
                      {skuMatches.length}개 →
                    </Link>
                  ) : (
                    <span className="text-xs text-gray-400">—</span>
                  )}
                </div>
              </div>
            )
          })}
        </section>
      )}
    </div>
  )
}

function KpiCard({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}

function Sparkline({ bars, max }: { bars: number[]; max: number }) {
  return (
    <div className="flex items-end gap-px h-8" aria-label="28일 추세">
      {bars.map((v, i) => {
        const h = Math.max(1, Math.round((v / max) * 28))
        return (
          <span
            key={i}
            className="w-1 bg-gray-300 hover:bg-gray-500"
            style={{ height: `${h}px` }}
            title={`day -${bars.length - 1 - i}: ${v}`}
          />
        )
      })}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
      <p className="text-base font-medium">아직 클러스터가 없습니다</p>
      <p className="text-sm mt-2">
        야간 cron <code className="px-1 bg-gray-100 rounded">scripts/synonym-cluster.mjs</code> 가
        market_raw + trends_keywords + trends_products 를 묶어 적재합니다.
      </p>
      <p className="text-xs mt-4 text-gray-400">
        수동 실행: <code className="px-1 bg-gray-100 rounded">node --env-file=.env.local scripts/synonym-cluster.mjs</code>
      </p>
    </div>
  )
}
