import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import ClusterActions from './ClusterActions'

export const dynamic = 'force-dynamic'

interface ClusterRow {
  id: string
  label: string
  member_terms: string[]
  member_product_ids: string[]
  category_hint: string | null
  member_count: number
  source_count: number
  total_frequency: number
  nearest_canonical: string | null
  nearest_similarity: number | null
  first_seen_at: string | null
  last_seen_at: string | null
  status: string
}

const CATEGORY_BADGE: Record<string, string> = {
  health: 'bg-emerald-100 text-emerald-700',
  living: 'bg-amber-100 text-amber-700',
  digital: 'bg-sky-100 text-sky-700',
  other: 'bg-gray-100 text-gray-600',
}

async function fetchData() {
  const sb = createAdminClient()
  const { data } = (await sb
    .from('jimscanner_emerging_clusters' as never)
    .select(
      'id, label, member_terms, member_product_ids, category_hint, member_count, source_count, total_frequency, nearest_canonical, nearest_similarity, first_seen_at, last_seen_at, status',
    )
    .eq('status', 'open')
    .order('source_count', { ascending: false })
    .order('total_frequency', { ascending: false })
    .limit(120)) as { data: ClusterRow[] | null }
  const clusters = (data ?? []) as ClusterRow[]

  const kpis = {
    clusters: clusters.length,
    multiSource: clusters.filter((c) => c.source_count >= 2).length,
    products: clusters.reduce((s, c) => s + (c.member_product_ids?.length ?? 0), 0),
  }
  return { clusters, kpis }
}

function freshness(lastSeen: string | null): { label: string; cls: string } {
  if (!lastSeen) return { label: '—', cls: 'text-gray-400' }
  const days = Math.floor((Date.now() - new Date(lastSeen).getTime()) / 86400_000)
  if (days <= 1) return { label: '오늘', cls: 'text-emerald-600 font-medium' }
  if (days <= 3) return { label: `${days}일 전`, cls: 'text-emerald-600' }
  if (days <= 7) return { label: `${days}일 전`, cls: 'text-amber-600' }
  return { label: `${days}일 전`, cls: 'text-gray-400' }
}

export default async function EmergingPage() {
  const { clusters, kpis } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">신개념 광맥 ⛏</h1>
          <p className="text-sm text-gray-500 mt-1">
            분류기가 기존 택소노미에 못 붙인 미분류·기타 잔여 신호를 군집화 → 어디에도 안 붙는
            화이트스페이스. 1인 셀러 선점 가치가 가장 큰 풀.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <KpiCard label="열린 광맥 클러스터" value={kpis.clusters} hint="status=open" />
        <KpiCard label="다소스 클러스터" value={kpis.multiSource} hint="2+ 소스 = 신호 강함" />
        <KpiCard label="잔여 상품 흡수" value={kpis.products} hint="군집에 묶인 미분류 product" />
      </section>

      {clusters.length === 0 ? (
        <EmptyState />
      ) : (
        <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {clusters.map((c) => {
            const fr = freshness(c.last_seen_at)
            const cat = c.category_hint ?? 'other'
            const sim = c.nearest_similarity ?? 0
            return (
              <div
                key={c.id}
                className="rounded-lg border border-gray-200 p-4 flex flex-col gap-3 hover:shadow-sm transition-shadow"
              >
                <div className="flex items-start justify-between gap-2">
                  <h2 className="text-base font-semibold leading-snug">{c.label}</h2>
                  <span
                    className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full ${CATEGORY_BADGE[cat] ?? CATEGORY_BADGE.other}`}
                  >
                    {cat}
                  </span>
                </div>

                <div className="flex flex-wrap gap-1">
                  {c.member_terms.slice(0, 8).map((t) => (
                    <span
                      key={t}
                      className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-700"
                      title={t}
                    >
                      {t.length > 18 ? t.slice(0, 18) + '…' : t}
                    </span>
                  ))}
                  {c.member_terms.length > 8 && (
                    <span className="text-xs text-gray-400">+{c.member_terms.length - 8}</span>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <Stat value={c.member_count} label="멤버" />
                  <Stat value={c.source_count} label="소스폭" />
                  <Stat value={c.total_frequency} label="발화량" />
                </div>

                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span className={fr.cls}>🕑 {fr.label}</span>
                  <span title={`가장 가까운 기존 canonical 과의 유사도 (낮을수록 신개념)`}>
                    근접 {c.nearest_canonical ?? '∅'}{' '}
                    <span className={sim < 0.4 ? 'text-emerald-600 font-medium' : 'text-gray-500'}>
                      {(sim * 100).toFixed(0)}%
                    </span>
                  </span>
                </div>

                <div className="pt-1 border-t border-gray-100">
                  <ClusterActions clusterId={c.id} />
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

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded bg-gray-50 py-1.5">
      <div className="font-mono font-bold text-sm">{value}</div>
      <div className="text-[11px] text-gray-500">{label}</div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
      <p className="text-base font-medium">아직 광맥 클러스터가 없습니다</p>
      <p className="text-sm mt-2">
        cron <code className="px-1 bg-gray-100 rounded">scripts/cluster-unclassified.mjs</code> 가
        미분류·기타 잔여 신호를 묶어 화이트스페이스만 적재합니다.
      </p>
      <p className="text-xs mt-4 text-gray-400">
        수동 실행:{' '}
        <code className="px-1 bg-gray-100 rounded">
          node --env-file=.env.local scripts/cluster-unclassified.mjs
        </code>
      </p>
    </div>
  )
}
