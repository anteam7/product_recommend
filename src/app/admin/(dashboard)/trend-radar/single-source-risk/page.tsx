import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface DivRow {
  product_id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  supplier_count: number
  supplier_sources: string[]
  ggsan_goods_no: string | null
  ggsan_title: string | null
  ggsan_status: string | null
  ggsan_is_imminent: boolean | null
  in_stock_count: number
  limited_count: number
  out_of_stock_count: number
  inventory_total: number
  in_stock_ratio: number | null
  out_of_stock_ratio: number | null
  price_cv: number | null
  min_lead_time_days: number | null
  single_source_risk: boolean
  risk_label: 'no_supplier' | 'single_supplier' | 'all_out_of_stock_or_limited' | 'ok'
  last_seen_at: string
}

const RISK_LABEL: Record<DivRow['risk_label'], { ko: string; tone: string }> = {
  no_supplier: { ko: '공급사 0개', tone: 'bg-red-100 text-red-700' },
  single_supplier: { ko: '단일 공급원', tone: 'bg-amber-100 text-amber-700' },
  all_out_of_stock_or_limited: { ko: '재고 위험', tone: 'bg-rose-100 text-rose-700' },
  ok: { ko: '정상', tone: 'bg-emerald-100 text-emerald-700' },
}

async function fetchData(cat: string) {
  const sb = createAdminClient()
  // v_supply_diversification 는 DB 마이그레이션 후 존재. 타입은 as any.
  let q = (sb as any).from('v_supply_diversification').select('*').eq('single_source_risk', true)
  if (cat && cat !== 'all') q = q.eq('category_top', cat)
  q = q.order('last_seen_at', { ascending: false }).limit(300)
  const { data, error } = await q
  if (error) {
    return { rows: [] as DivRow[], err: error.message }
  }
  return { rows: (data ?? []) as DivRow[], err: null as string | null }
}

async function fetchCounts() {
  const sb = createAdminClient()
  const [total, risk] = await Promise.all([
    (sb as any).from('v_supply_diversification').select('*', { count: 'exact', head: true }),
    (sb as any).from('v_supply_diversification').select('*', { count: 'exact', head: true }).eq('single_source_risk', true),
  ])
  return {
    total: total.count ?? 0,
    risk: risk.count ?? 0,
  }
}

const CATEGORIES = ['all', 'health', 'living', 'digital'] as const
type Category = (typeof CATEGORIES)[number]

export default async function SingleSourceRiskPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string }>
}) {
  const sp = await searchParams
  const cat = (CATEGORIES.includes(sp.cat as Category) ? sp.cat : 'all') as Category

  const [{ rows, err }, counts] = await Promise.all([fetchData(cat), fetchCounts()])

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">단일 공급원 리스크</h1>
          <p className="text-sm text-gray-500 mt-1">
            공급사 ≤ 1 또는 모든 공급사 품절·제한. 진입 전 컷·진입 후 품절 조기경보.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {err && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          v_supply_diversification 뷰가 아직 적용되지 않았습니다. supabase/trends_v4_supply_diversification.sql 적용 필요.
          <div className="text-xs mt-1 font-mono opacity-70">{err}</div>
        </div>
      )}

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <KpiCard label="전체 후보" value={counts.total} hint="canonical 매핑" />
        <KpiCard label="단일 공급원 리스크" value={counts.risk} hint={counts.total > 0 ? `${Math.round((counts.risk / counts.total) * 100)}% 위험` : '—'} />
        <KpiCard
          label="ggsan 단독"
          value={rows.filter((r) => r.supplier_count === 1 && r.ggsan_goods_no).length}
          hint="ggsan 만 보유"
        />
      </section>

      {/* 카테고리 탭 */}
      <nav className="flex gap-2 border-b border-gray-200">
        {CATEGORIES.map((c) => (
          <Link
            key={c}
            href={`/admin/trend-radar/single-source-risk?cat=${c}`}
            className={`px-3 py-2 text-sm ${
              cat === c
                ? 'border-b-2 border-black font-semibold text-black'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {c === 'all' ? '전체' : c}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">리스크 후보 없음</p>
          <p className="text-sm mt-2">
            모든 canonical 상품이 ≥2 공급사 + 재고 정상. ✨
          </p>
        </div>
      ) : (
        <section>
          <div className="grid gap-2">
            <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
              <div className="col-span-4">상품명</div>
              <div className="col-span-2">리스크</div>
              <div className="col-span-1 text-right">공급사</div>
              <div className="col-span-2 text-right">재고 (in/lim/out)</div>
              <div className="col-span-1 text-right">price CV</div>
              <div className="col-span-1 text-right">리드</div>
              <div className="col-span-1 text-right">갱신</div>
            </div>
            {rows.map((r) => {
              const lbl = RISK_LABEL[r.risk_label] ?? RISK_LABEL.ok
              return (
                <Link
                  key={r.product_id}
                  href={`/admin/trend-radar/products/${r.product_id}`}
                  className="grid grid-cols-12 px-3 py-2 rounded border border-gray-200 hover:bg-amber-50 transition-colors items-center text-sm"
                >
                  <div className="col-span-4">
                    <div className="font-medium truncate" title={r.canonical_name}>{r.canonical_name}</div>
                    <div className="text-xs text-gray-500">
                      {r.category_top}{r.category_mid ? ` / ${r.category_mid}` : ''}
                      {r.supplier_sources?.length > 0 && (
                        <span className="ml-2 text-gray-400">{r.supplier_sources.join(', ')}</span>
                      )}
                      {r.ggsan_goods_no && (
                        <span className="ml-2 text-amber-700">+ggsan</span>
                      )}
                    </div>
                  </div>
                  <div className="col-span-2">
                    <span className={`text-[10px] px-2 py-0.5 rounded font-semibold ${lbl.tone}`}>
                      {lbl.ko}
                    </span>
                  </div>
                  <div className="col-span-1 text-right font-mono">{r.supplier_count}</div>
                  <div className="col-span-2 text-right font-mono text-xs text-gray-600">
                    {r.inventory_total > 0
                      ? `${r.in_stock_count}/${r.limited_count}/${r.out_of_stock_count}`
                      : '—'}
                  </div>
                  <div className="col-span-1 text-right font-mono text-xs text-gray-600">
                    {r.price_cv != null ? r.price_cv.toFixed(2) : '—'}
                  </div>
                  <div className="col-span-1 text-right font-mono text-xs text-gray-600">
                    {r.min_lead_time_days != null ? `${r.min_lead_time_days}d` : '—'}
                  </div>
                  <div className="col-span-1 text-right text-xs text-gray-400 font-mono">
                    {r.last_seen_at?.slice(5, 10)}
                  </div>
                </Link>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}

function KpiCard({ label, value, hint }: { label: string; value: number; hint: string | number }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}
