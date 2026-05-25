import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface SummaryRow {
  cluster_id: string
  label: string | null
  confidence: number
  member_brands: string[] | null
  sku_count: number
  brand_count: number
  min_wholesale_krw: number | null
  max_retail_krw: number | null
  margin_headroom: number | null
  channel_mix: Record<string, number> | null
  signal_features: Record<string, unknown> | null
  first_seen_at: string
  last_seen_at: string
  source_diversity: number
}

const SORT_OPTIONS = [
  { v: 'margin', label: '마진 헤드룸 큰순' },
  { v: 'confidence', label: '신뢰도 높은순' },
  { v: 'brand_count', label: '브랜드 수 많은순' },
  { v: 'recent', label: '최근 갱신순' },
] as const
type SortKey = (typeof SORT_OPTIONS)[number]['v']

const PAGE_SIZE = 40

function formatKrw(n: number | null | undefined): string {
  if (n == null) return '—'
  return n.toLocaleString('ko-KR') + '원'
}

async function fetchClusters(opts: { sort: SortKey; q: string; minBrands: number }) {
  const sb = createAdminClient()

  // 마이그레이션 후 자동 생성된 view. 타입 미정의 → as any 캐스팅 허용.
  let q = (sb as any)
    .from('jimscanner_factory_clusters_summary')
    .select('*', { count: 'exact' })

  if (opts.minBrands > 1) q = q.gte('brand_count', opts.minBrands)
  if (opts.q) q = q.or(`label.ilike.%${opts.q}%,cluster_id.ilike.%${opts.q}%`)

  switch (opts.sort) {
    case 'margin':
      q = q.order('margin_headroom', { ascending: false, nullsFirst: false })
      break
    case 'confidence':
      q = q.order('confidence', { ascending: false })
      break
    case 'brand_count':
      q = q.order('brand_count', { ascending: false })
      break
    case 'recent':
    default:
      q = q.order('last_seen_at', { ascending: false })
  }

  q = q.limit(PAGE_SIZE)

  const { data, count, error } = await q
  if (error) {
    return { rows: [] as SummaryRow[], total: 0, error: error.message }
  }
  return { rows: (data ?? []) as SummaryRow[], total: count ?? 0, error: null as string | null }
}

export default async function FactoryClustersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const sort = (typeof sp.sort === 'string' ? sp.sort : 'margin') as SortKey
  const q = typeof sp.q === 'string' ? sp.q.trim() : ''
  const minBrands = Math.max(1, Number(typeof sp.brands === 'string' ? sp.brands : '2') || 2)

  const { rows, total, error } = await fetchClusters({ sort, q, minBrands })

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">🏭 OEM 공유공장 클러스터</h1>
          <p className="text-sm text-gray-500 mt-1">
            같은 공장(OEM/ODM)에서 다른 브랜드로 출고되는 동형 제품 그룹.
            <br />
            <span className="text-gray-400">
              이미지 유사도 cosine 0.82~0.95 밴드 + 사양·인증번호·제조원·원산지·박스·바코드 prefix
              매칭으로 클러스터링. 도매 ↔ 리테일 lane 교차로 마진 헤드룸 산출.
            </span>
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <form className="flex items-center gap-2 flex-wrap text-sm">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="라벨 / cluster_id 검색"
          className="border border-gray-300 rounded px-3 py-1.5 w-64"
        />
        <select
          name="sort"
          defaultValue={sort}
          className="border border-gray-300 rounded px-2 py-1.5"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.v} value={o.v}>
              {o.label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1">
          최소 브랜드
          <input
            type="number"
            name="brands"
            min={1}
            max={20}
            defaultValue={minBrands}
            className="border border-gray-300 rounded px-2 py-1 w-16"
          />
        </label>
        <button
          type="submit"
          className="bg-black text-white rounded px-3 py-1.5 hover:bg-gray-800"
        >
          적용
        </button>
        <span className="text-gray-500 ml-2">총 {total.toLocaleString('ko-KR')}개 클러스터</span>
      </form>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 text-red-700 text-sm p-4">
          <p className="font-medium">조회 실패</p>
          <p className="mt-1 font-mono text-xs whitespace-pre-wrap">{error}</p>
          <p className="mt-2 text-xs text-red-600">
            supabase/factory_clusters.sql 마이그레이션을 먼저 적용해야 합니다.
          </p>
        </div>
      )}

      {!error && rows.length === 0 && (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">클러스터 없음</p>
          <p className="text-sm mt-2">
            scripts/cluster-factory.mjs 배치 잡이 한 번도 실행되지 않았거나
            필터 조건에 매칭되는 클러스터가 없습니다.
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="space-y-3">
          {rows.map((c) => (
            <ClusterCard key={c.cluster_id} c={c} />
          ))}
        </div>
      )}
    </div>
  )
}

function ClusterCard({ c }: { c: SummaryRow }) {
  const channelMix = c.channel_mix ?? {}
  const channels = Object.entries(channelMix).sort((a, b) => b[1] - a[1])
  const cosineBand = (c.signal_features as Record<string, unknown> | null)?.image_cosine_band as
    | string
    | undefined
  const manufacturer = (c.signal_features as Record<string, unknown> | null)?.manufacturer as
    | string
    | undefined
  const certNo = (c.signal_features as Record<string, unknown> | null)?.cert_no as
    | string
    | undefined

  return (
    <div className="rounded border border-gray-200 hover:border-gray-400 transition-colors p-4 grid grid-cols-12 gap-4 text-sm">
      <div className="col-span-4">
        <div className="font-medium text-base">
          {c.label ?? <span className="text-gray-400 font-mono">{c.cluster_id.slice(0, 12)}…</span>}
        </div>
        <div className="text-xs text-gray-500 mt-1">
          신뢰도 <span className="font-mono">{(c.confidence * 100).toFixed(0)}%</span>
          {cosineBand && (
            <>
              {' · '}
              cosine {cosineBand}
            </>
          )}
        </div>
        {manufacturer && (
          <div className="text-xs text-gray-700 mt-1">
            제조원 <span className="font-medium">{manufacturer}</span>
          </div>
        )}
        {certNo && (
          <div className="text-xs text-gray-500 mt-0.5 font-mono">인증 {certNo}</div>
        )}
        <div className="mt-2 flex flex-wrap gap-1">
          {(c.member_brands ?? []).slice(0, 6).map((b) => (
            <span
              key={b}
              className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700"
            >
              {b}
            </span>
          ))}
          {c.member_brands && c.member_brands.length > 6 && (
            <span className="text-xs px-2 py-0.5 rounded bg-gray-200 text-gray-600">
              +{c.member_brands.length - 6}
            </span>
          )}
        </div>
      </div>

      <div className="col-span-3 border-l border-gray-100 pl-4">
        <div className="text-xs text-gray-500">최저 도매 lane</div>
        <div className="font-semibold text-emerald-700 text-base">
          {formatKrw(c.min_wholesale_krw)}
        </div>
        <div className="text-xs text-gray-500 mt-2">최고 리테일 lane</div>
        <div className="font-semibold text-rose-700 text-base">
          {formatKrw(c.max_retail_krw)}
        </div>
      </div>

      <div className="col-span-3 border-l border-gray-100 pl-4">
        <div className="text-xs text-gray-500">마진 헤드룸</div>
        <div className="font-bold text-xl text-black">
          {c.margin_headroom != null ? formatKrw(c.margin_headroom) : '—'}
        </div>
        {c.max_retail_krw && c.min_wholesale_krw && c.max_retail_krw > 0 && (
          <div className="text-xs text-gray-500 mt-1">
            마진율{' '}
            {(((c.max_retail_krw - c.min_wholesale_krw) / c.max_retail_krw) * 100).toFixed(0)}%
          </div>
        )}
        <div className="text-xs text-gray-500 mt-2">
          SKU {c.sku_count} · 브랜드 {c.brand_count} · 채널 {c.source_diversity}
        </div>
      </div>

      <div className="col-span-2 border-l border-gray-100 pl-4">
        <div className="text-xs text-gray-500">채널 점유</div>
        <div className="mt-1 space-y-0.5">
          {channels.length === 0 && <div className="text-xs text-gray-400">—</div>}
          {channels.slice(0, 4).map(([src, n]) => (
            <div key={src} className="flex items-center justify-between text-xs">
              <span className="text-gray-700">{src}</span>
              <span className="font-mono text-gray-600">{n}</span>
            </div>
          ))}
        </div>
        <Link
          href={`/admin/trend-radar/factory-clusters/${encodeURIComponent(c.cluster_id)}`}
          className="block mt-2 text-xs text-blue-700 hover:underline"
        >
          상세 →
        </Link>
      </div>
    </div>
  )
}
