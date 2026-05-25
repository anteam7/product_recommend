import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface ClusterRow {
  cluster_id: string
  label: string | null
  confidence: number
  signal_features: Record<string, unknown> | null
  member_brands: string[] | null
  member_skus: string[] | null
  min_wholesale_krw: number | null
  max_retail_krw: number | null
  margin_headroom: number | null
  channel_mix: Record<string, number> | null
  first_seen_at: string
  last_seen_at: string
}

interface MemberRow {
  sku_source: string
  sku_id: string
  brand: string | null
  channel: string | null
  price_krw: number | null
  url: string | null
  image_url: string | null
  match_signals: Record<string, unknown> | null
  added_at: string
}

function formatKrw(n: number | null | undefined): string {
  if (n == null) return '—'
  return n.toLocaleString('ko-KR') + '원'
}

async function fetchCluster(clusterId: string) {
  const sb = createAdminClient()
  const [clusterRes, memberRes] = await Promise.all([
    (sb as any)
      .from('jimscanner_factory_clusters')
      .select('*')
      .eq('cluster_id', clusterId)
      .maybeSingle(),
    (sb as any)
      .from('jimscanner_factory_cluster_members')
      .select('*')
      .eq('cluster_id', clusterId)
      .order('price_krw', { ascending: true, nullsFirst: false }),
  ])

  if (clusterRes.error || !clusterRes.data) return null
  return {
    cluster: clusterRes.data as ClusterRow,
    members: (memberRes.data ?? []) as MemberRow[],
  }
}

export default async function FactoryClusterDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id: rawId } = await params
  const id = decodeURIComponent(rawId)
  const data = await fetchCluster(id)
  if (!data) notFound()
  const { cluster, members } = data

  const wholesale = members.filter((m) => m.channel === 'wholesale')
  const retail = members.filter((m) => m.channel === 'retail')
  const other = members.filter((m) => m.channel !== 'wholesale' && m.channel !== 'retail')

  const sig = cluster.signal_features ?? {}

  return (
    <div className="space-y-6 p-6">
      <header>
        <Link
          href="/admin/trend-radar/factory-clusters"
          className="text-sm text-gray-500 hover:text-black"
        >
          ← OEM 공유공장 클러스터
        </Link>
        <h1 className="text-2xl font-bold mt-1">
          {cluster.label ?? <span className="font-mono">{cluster.cluster_id}</span>}
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          신뢰도 {(cluster.confidence * 100).toFixed(0)}% · SKU{' '}
          {cluster.member_skus?.length ?? 0} · 브랜드 {cluster.member_brands?.length ?? 0}
        </p>
      </header>

      <section className="grid grid-cols-3 gap-3">
        <div className="rounded border border-gray-200 p-4">
          <div className="text-xs text-gray-500">최저 도매 lane</div>
          <div className="text-xl font-semibold text-emerald-700 mt-1">
            {formatKrw(cluster.min_wholesale_krw)}
          </div>
        </div>
        <div className="rounded border border-gray-200 p-4">
          <div className="text-xs text-gray-500">최고 리테일 lane</div>
          <div className="text-xl font-semibold text-rose-700 mt-1">
            {formatKrw(cluster.max_retail_krw)}
          </div>
        </div>
        <div className="rounded border border-gray-200 p-4">
          <div className="text-xs text-gray-500">마진 헤드룸</div>
          <div className="text-xl font-bold mt-1">
            {formatKrw(cluster.margin_headroom)}
          </div>
        </div>
      </section>

      <section className="rounded border border-gray-200 p-4">
        <h2 className="text-sm font-semibold text-gray-700">매칭 신호</h2>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {Object.entries(sig).length === 0 && (
            <div className="text-xs text-gray-400 col-span-2">신호 메타 없음</div>
          )}
          {Object.entries(sig).map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="text-gray-500 min-w-[7rem]">{k}</dt>
              <dd className="text-gray-900 font-mono text-xs break-all">
                {typeof v === 'string' ? v : JSON.stringify(v)}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <MemberSection title="도매 lane (wholesale)" rows={wholesale} highlight="cheapest" />
      <MemberSection title="리테일 lane (retail)" rows={retail} highlight="expensive" />
      {other.length > 0 && <MemberSection title="기타 / 미분류" rows={other} highlight={null} />}
    </div>
  )
}

function MemberSection({
  title,
  rows,
  highlight,
}: {
  title: string
  rows: MemberRow[]
  highlight: 'cheapest' | 'expensive' | null
}) {
  if (rows.length === 0) {
    return (
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">{title}</h2>
        <div className="rounded border border-dashed border-gray-300 text-xs text-gray-400 px-4 py-6 text-center">
          매핑된 SKU 없음
        </div>
      </section>
    )
  }

  const sorted =
    highlight === 'expensive'
      ? [...rows].sort((a, b) => (b.price_krw ?? -1) - (a.price_krw ?? -1))
      : [...rows].sort((a, b) => (a.price_krw ?? Infinity) - (b.price_krw ?? Infinity))

  const flagIdx = 0

  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-700 mb-2">{title}</h2>
      <div className="rounded border border-gray-200 divide-y divide-gray-100">
        {sorted.map((m, i) => (
          <div
            key={`${m.sku_source}::${m.sku_id}`}
            className={`px-4 py-2 grid grid-cols-12 items-center text-sm ${
              i === flagIdx && highlight ? 'bg-yellow-50' : ''
            }`}
          >
            <div className="col-span-2 text-xs text-gray-500 font-mono">{m.sku_source}</div>
            <div className="col-span-3 text-gray-800">{m.brand ?? <i className="text-gray-400">brand 미상</i>}</div>
            <div className="col-span-3 text-xs font-mono text-gray-500 truncate">{m.sku_id}</div>
            <div className="col-span-2 text-right font-mono">{formatKrw(m.price_krw)}</div>
            <div className="col-span-2 text-right">
              {m.url ? (
                <a
                  href={m.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-700 hover:underline"
                >
                  원문 →
                </a>
              ) : (
                <span className="text-xs text-gray-400">—</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
