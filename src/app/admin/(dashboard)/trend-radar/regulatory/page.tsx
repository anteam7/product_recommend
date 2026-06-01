import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  BARRIER_COLUMNS,
  barrierMeta,
  COST_BAND_LABEL,
  type BarrierType,
} from './barrier-meta'

export const dynamic = 'force-dynamic'

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  barrier_type: string | null
  barrier_est_cost_band: string | null
  barrier_est_days: number | null
  barrier_evidence: string | null
  barrier_classified_at: string | null
}

async function fetchProducts() {
  const sb = createAdminClient()
  // barrier_* 컬럼은 generated 타입 미반영 — 마이그레이션(supabase/trends_regulatory_barrier.sql) 후 `as any`
  const { data, error } = await sb
    .from('jimscanner_trends_products')
    .select(
      'id, canonical_name, category_top, category_mid, barrier_type, barrier_est_cost_band, barrier_est_days, barrier_evidence, barrier_classified_at' as any,
    )
    .order('last_seen_at', { ascending: false })
    .limit(2000)
  return { rows: ((data ?? []) as any) as ProductRow[], error: error?.message ?? null }
}

export default async function RegulatoryPage() {
  const { rows, error } = await fetchProducts()

  // 게이트 보드: barrier_type 별 그룹
  const byBarrier = new Map<string, ProductRow[]>()
  let unclassified = 0
  let noBarrier = 0
  for (const r of rows) {
    const key = r.barrier_type ?? 'unclassified'
    if (!r.barrier_type) unclassified++
    if (r.barrier_type === 'none') noBarrier++
    const list = byBarrier.get(key) ?? []
    list.push(r)
    byBarrier.set(key, list)
  }
  const classified = rows.length - unclassified

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🛡 인증·규제 진입장벽 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            발굴 상품을 &lsquo;솔로 위탁 셀러가 즉시 등록 가능한가&rsquo; 축으로 게이팅 — 좌측 즉시등록가능 ↔ 우측 인증필요
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          조회 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            마이그레이션 미적용 가능성 — supabase/trends_regulatory_barrier.sql 적용 필요.
          </p>
        </div>
      )}

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="전체 상품" value={rows.length} />
        <Kpi label="✅ 즉시 등록 가능" value={noBarrier} highlight={noBarrier > 0} highlightClass="border-emerald-300 bg-emerald-50 text-emerald-700" />
        <Kpi label="🔒 인증 필요" value={classified - noBarrier} />
        <Kpi label="미분류" value={unclassified} />
      </section>

      {classified === 0 && !error && (
        <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          아직 barrier 판정된 상품이 없습니다. 로컬에서{' '}
          <code className="font-mono">node --env-file=.env.local scripts/classify-regulatory-barrier.mjs</code>{' '}
          실행 후 새로고침하세요.
        </div>
      )}

      {/* 칸반 보드 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        {BARRIER_COLUMNS.map((bt) => {
          const meta = barrierMeta(bt)
          const items = (byBarrier.get(bt) ?? []).slice(0, 50)
          const total = (byBarrier.get(bt) ?? []).length
          return (
            <div key={bt} className="rounded border border-gray-200 flex flex-col min-h-[120px]">
              <div className={`px-3 py-2 border-b text-xs font-semibold rounded-t ${meta.badgeClass}`}>
                {meta.label}
                <span className="ml-1 font-mono opacity-70">({total})</span>
              </div>
              <div className="flex-1 divide-y divide-gray-100 overflow-y-auto max-h-[480px]">
                {items.length === 0 ? (
                  <div className="px-3 py-6 text-center text-[11px] text-gray-300">—</div>
                ) : (
                  items.map((p) => <BarrierCard key={p.id} p={p} barrierType={bt} />)
                )}
                {total > items.length && (
                  <div className="px-3 py-2 text-[11px] text-gray-400">+{total - items.length}건 더</div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* 미분류 목록 (있으면) */}
      {unclassified > 0 && (
        <section className="text-xs text-gray-500 border-t border-gray-200 pt-4">
          미분류 {unclassified}건 — classify-regulatory-barrier.mjs 재실행 시 자동 판정됩니다.
        </section>
      )}
    </div>
  )
}

function BarrierCard({ p, barrierType }: { p: ProductRow; barrierType: BarrierType }) {
  const meta = barrierMeta(barrierType)
  return (
    <Link
      href={`/admin/trend-radar/products/${p.id}`}
      className="block px-3 py-2 hover:bg-gray-50 transition-colors"
    >
      <div className="text-sm font-medium leading-snug truncate" title={p.canonical_name}>
        {p.canonical_name}
      </div>
      <div className="text-[11px] text-gray-500 mt-0.5">
        {p.category_top}
        {p.category_mid ? ` / ${p.category_mid}` : ''}
      </div>
      {barrierType !== 'none' && (
        <div className="mt-1 flex items-center gap-1 flex-wrap text-[10px]">
          {p.barrier_est_cost_band && (
            <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
              비용 {COST_BAND_LABEL[p.barrier_est_cost_band] ?? p.barrier_est_cost_band}
            </span>
          )}
          {typeof p.barrier_est_days === 'number' && p.barrier_est_days > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">~{p.barrier_est_days}일</span>
          )}
        </div>
      )}
      {p.barrier_evidence && barrierType !== 'none' && (
        <div className="mt-1 text-[10px] text-gray-400 leading-tight" title={p.barrier_evidence}>
          {p.barrier_evidence}
        </div>
      )}
      <span className={`hidden ${meta.badgeClass}`} />
    </Link>
  )
}

function Kpi({
  label,
  value,
  highlight = false,
  highlightClass = '',
}: {
  label: string
  value: number | string
  highlight?: boolean
  highlightClass?: string
}) {
  return (
    <div className={`rounded border p-3 ${highlight ? highlightClass || 'border-gray-300 bg-gray-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
