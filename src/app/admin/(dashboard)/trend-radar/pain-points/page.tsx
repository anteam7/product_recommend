import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import PinToggle from './PinToggle'

export const dynamic = 'force-dynamic'

interface PainPointRow {
  id: string
  cluster_id: string
  cluster_label: string | null
  statement: string
  severity: number
  frequency: number
  mapped_product_id: string | null
  mapped_score: number | null
  ad_copy: string | null
  is_pinned: boolean
  raw_ids: string[] | null
  last_seen: string
}

interface ProductLite {
  id: string
  canonical_name: string
}

const FILTERS = ['all', 'unmet', 'mapped', 'pinned'] as const
type Filter = (typeof FILTERS)[number]

const FILTER_LABEL: Record<Filter, string> = {
  all: '전체',
  unmet: 'Unmet (SKU 없음)',
  mapped: '해결 후보 있음',
  pinned: '핀',
}

async function fetchData(filter: Filter) {
  const sb = createAdminClient() as any

  let q = sb
    .from('jimscanner_market_pain_points')
    .select(
      'id, cluster_id, cluster_label, statement, severity, frequency, mapped_product_id, mapped_score, ad_copy, is_pinned, raw_ids, last_seen',
    )
    .order('severity', { ascending: false })
    .order('frequency', { ascending: false })
    .limit(300)

  if (filter === 'unmet') q = q.is('mapped_product_id', null)
  if (filter === 'mapped') q = q.not('mapped_product_id', 'is', null)
  if (filter === 'pinned') q = q.eq('is_pinned', true)

  const { data: rows, error } = await q
  const list = (error ? [] : (rows ?? [])) as PainPointRow[]

  const mappedIds = Array.from(
    new Set(list.map((r) => r.mapped_product_id).filter((x): x is string => !!x)),
  )
  let products: Record<string, ProductLite> = {}
  if (mappedIds.length > 0) {
    const { data: prods } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name')
      .in('id', mappedIds)
    for (const p of (prods ?? []) as ProductLite[]) products[p.id] = p
  }

  // KPI
  const { count: totalCount } = await sb
    .from('jimscanner_market_pain_points')
    .select('*', { count: 'exact', head: true })
  const { count: unmetCount } = await sb
    .from('jimscanner_market_pain_points')
    .select('*', { count: 'exact', head: true })
    .is('mapped_product_id', null)
  const { count: pinnedCount } = await sb
    .from('jimscanner_market_pain_points')
    .select('*', { count: 'exact', head: true })
    .eq('is_pinned', true)
  const { count: rawPendingCount } = await sb
    .from('jimscanner_market_raw')
    .select('*', { count: 'exact', head: true })
    .in('source', ['naver_blog', 'naver_news', 'clien_park', 'quasarzone_sale'])
    .eq('processed', false)

  return {
    rows: list,
    products,
    kpis: {
      total: totalCount ?? 0,
      unmet: unmetCount ?? 0,
      pinned: pinnedCount ?? 0,
      pending: rawPendingCount ?? 0,
    },
  }
}

// 빈도(가로) × 심각도(세로) — 단순 grid 매트릭스
function FrequencySeverityMatrix({ rows }: { rows: PainPointRow[] }) {
  // 가로축: frequency bucket (1, 2-3, 4-7, 8+)
  // 세로축: severity bucket (0-3, 4-6, 7-8, 9-10)  ← 높을수록 위
  const freqBuckets = [
    { label: '1', test: (n: number) => n <= 1 },
    { label: '2-3', test: (n: number) => n >= 2 && n <= 3 },
    { label: '4-7', test: (n: number) => n >= 4 && n <= 7 },
    { label: '8+', test: (n: number) => n >= 8 },
  ]
  const sevBuckets = [
    { label: '9-10', test: (n: number) => n >= 9 },
    { label: '7-8', test: (n: number) => n >= 7 && n <= 8 },
    { label: '4-6', test: (n: number) => n >= 4 && n <= 6 },
    { label: '0-3', test: (n: number) => n <= 3 },
  ]
  const grid: PainPointRow[][][] = sevBuckets.map(() => freqBuckets.map(() => []))
  for (const r of rows) {
    const si = sevBuckets.findIndex((b) => b.test(r.severity))
    const fi = freqBuckets.findIndex((b) => b.test(r.frequency))
    if (si >= 0 && fi >= 0) grid[si][fi].push(r)
  }
  return (
    <div className="rounded border border-gray-200 p-3 bg-white">
      <div className="text-xs font-semibold text-gray-700 mb-2">
        빈도 × 심각도 매트릭스{' '}
        <span className="font-normal text-gray-500">(우측 상단 = 최우선 진입 후보)</span>
      </div>
      <div className="grid" style={{ gridTemplateColumns: `auto repeat(${freqBuckets.length}, 1fr)` }}>
        <div></div>
        {freqBuckets.map((b) => (
          <div key={b.label} className="text-[10px] text-gray-500 text-center pb-1">
            빈도 {b.label}
          </div>
        ))}
        {sevBuckets.map((sb, si) => (
          <div key={sb.label} className="contents">
            <div className="text-[10px] text-gray-500 pr-2 self-center">심각도 {sb.label}</div>
            {freqBuckets.map((_, fi) => {
              const cell = grid[si][fi]
              const intensity = Math.min(cell.length, 8) / 8
              const bg =
                cell.length === 0
                  ? 'bg-gray-50'
                  : intensity > 0.6
                    ? 'bg-red-200'
                    : intensity > 0.3
                      ? 'bg-amber-100'
                      : 'bg-yellow-50'
              return (
                <div
                  key={fi}
                  className={`border border-white text-center text-xs font-mono py-2 ${bg}`}
                  title={cell.map((c) => c.statement).join('\n')}
                >
                  {cell.length || ''}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

export default async function PainPointsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>
}) {
  const sp = await searchParams
  const filter = (FILTERS.includes(sp.filter as Filter) ? sp.filter : 'all') as Filter

  const { rows, products, kpis } = await fetchData(filter)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">🩹 Unmet Demand 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            market_raw 본문에서 추출한 사용자 페인포인트 클러스터.{' '}
            <strong>SKU 없는 페인 = 신규 진입 후보.</strong>
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="페인 클러스터" value={kpis.total} hint="누적" />
        <Kpi
          label="Unmet (SKU 없음)"
          value={kpis.unmet}
          hint={kpis.total > 0 ? `${Math.round((kpis.unmet / kpis.total) * 100)}%` : '0%'}
        />
        <Kpi label="핀 검토중" value={kpis.pinned} hint="수동" />
        <Kpi label="raw 미처리" value={kpis.pending} hint="다음 extract" />
      </section>

      <nav className="flex gap-2 border-b border-gray-200">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={`/admin/trend-radar/pain-points?filter=${f}`}
            className={`px-3 py-2 text-sm ${
              filter === f
                ? 'border-b-2 border-black font-semibold text-black'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {FILTER_LABEL[f]}
          </Link>
        ))}
      </nav>

      <FrequencySeverityMatrix rows={rows} />

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 추출된 페인포인트가 없습니다</p>
          <p className="text-sm mt-2">
            로컬에서{' '}
            <code className="px-1 bg-gray-100 rounded">
              node --env-file=.env.local scripts/extract-pain-points.mjs
            </code>{' '}
            실행 시 market_raw 본문에서 페인포인트가 채워집니다.
          </p>
        </div>
      ) : (
        <div className="rounded border border-gray-200 divide-y divide-gray-100 bg-white">
          <div className="grid grid-cols-12 px-4 py-2 text-xs text-gray-500 bg-gray-50">
            <div className="col-span-1">핀</div>
            <div className="col-span-5">발화 / 광고 카피</div>
            <div className="col-span-2">클러스터</div>
            <div className="col-span-1 text-right">심각도</div>
            <div className="col-span-1 text-right">빈도</div>
            <div className="col-span-2">매칭 상품 / 상태</div>
          </div>
          {rows.map((r) => {
            const mapped = r.mapped_product_id ? products[r.mapped_product_id] : null
            return (
              <div
                key={r.id}
                className={`grid grid-cols-12 px-4 py-3 text-sm items-start ${
                  r.mapped_product_id ? '' : 'bg-amber-50/40'
                }`}
              >
                <div className="col-span-1">
                  <PinToggle id={r.id} initialPinned={r.is_pinned} />
                </div>
                <div className="col-span-5">
                  <div className="font-medium text-gray-900">“{r.statement}”</div>
                  {r.ad_copy && (
                    <div className="text-xs text-purple-700 mt-1">📣 {r.ad_copy}</div>
                  )}
                  <div className="text-[10px] text-gray-400 mt-1 font-mono">
                    raw {r.raw_ids?.length ?? 0}건 · 최근 {r.last_seen.slice(0, 10)}
                  </div>
                </div>
                <div className="col-span-2 text-xs text-gray-600">
                  <div>{r.cluster_label || r.cluster_id}</div>
                  <div className="text-[10px] text-gray-400 font-mono">{r.cluster_id}</div>
                </div>
                <div className="col-span-1 text-right font-mono">
                  <span
                    className={
                      r.severity >= 8
                        ? 'text-red-700 font-bold'
                        : r.severity >= 5
                          ? 'text-amber-600'
                          : 'text-gray-500'
                    }
                  >
                    {r.severity}
                  </span>
                </div>
                <div className="col-span-1 text-right font-mono text-gray-700">{r.frequency}</div>
                <div className="col-span-2 text-xs">
                  {mapped ? (
                    <Link
                      href={`/admin/trend-radar/products/${mapped.id}`}
                      className="text-blue-700 hover:underline"
                    >
                      {mapped.canonical_name}{' '}
                      <span className="text-gray-400 font-mono">
                        ({r.mapped_score ?? '–'})
                      </span>
                    </Link>
                  ) : (
                    <span className="inline-block rounded bg-amber-200 px-2 py-0.5 text-amber-900 font-semibold">
                      Unmet Demand
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Kpi({ label, value, hint }: { label: string; value: number; hint: string | number }) {
  return (
    <div className="rounded border border-gray-200 p-3 bg-white">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-0.5">{value.toLocaleString()}</div>
      <div className="text-[11px] text-gray-400 mt-0.5">{hint}</div>
    </div>
  )
}
