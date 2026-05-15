import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

const CATEGORIES = ['all', 'health', 'living', 'digital'] as const
type Category = (typeof CATEGORIES)[number]

const CATEGORY_LABEL: Record<Category, string> = {
  all: '전체',
  health: '건강식품',
  living: '생활/리빙',
  digital: '디지털/가전',
}

interface FamilyScoreRow {
  family_id: string
  root_name: string
  root_brand: string | null
  category_top: string
  category_mid: string | null
  variant_count: number
  accessory_count: number
  core_count: number
  accessory_ratio: number
  sum_trend_score: number
  sum_commerce_score: number
  sum_supplier_score: number
  max_final_score: number
  avg_final_score: number
  distinct_keywords: number
  lead_variant_id: string | null
  lead_variant_name: string | null
  lead_final_score: number | null
  last_seen_at: string | null
}

interface VariantRow {
  id: string
  canonical_name: string
  variant_role: string | null
  family_id: string | null
}

async function fetchFamilies(category: Category) {
  const sb = createAdminClient()

  // VIEW 는 supabase 타입에 없으므로 as any 캐스팅.
  let query = (sb as any)
    .from('jimscanner_trends_families_scores')
    .select('*')
    .order('sum_trend_score', { ascending: false })
    .limit(200)
  if (category !== 'all') query = query.eq('category_top', category)

  const { data: families, error } = await query
  if (error) {
    console.error('families fetch error', error)
    return { families: [] as FamilyScoreRow[], variants: new Map<string, VariantRow[]>() }
  }
  const rows = (families ?? []) as FamilyScoreRow[]

  // 상위 30 family 에 대해서만 variant drill-down 미리 로드 (Promise.all)
  const top = rows.slice(0, 30)
  const familyIds = top.map((f) => f.family_id)
  let variantMap = new Map<string, VariantRow[]>()
  if (familyIds.length > 0) {
    const { data: variants } = await (sb as any)
      .from('jimscanner_trends_products')
      .select('id, canonical_name, variant_role, family_id')
      .in('family_id', familyIds)
    const vs = (variants ?? []) as VariantRow[]
    for (const v of vs) {
      if (!v.family_id) continue
      const arr = variantMap.get(v.family_id) ?? []
      arr.push(v)
      variantMap.set(v.family_id, arr)
    }
  }

  return { families: rows, variants: variantMap }
}

async function fetchKpis() {
  const sb = createAdminClient()
  const [{ count: famCount }, { count: prodFamCount }, { count: prodTotal }] = await Promise.all([
    (sb as any).from('jimscanner_trends_product_families').select('*', { count: 'exact', head: true }),
    (sb as any).from('jimscanner_trends_products').select('*', { count: 'exact', head: true }).not('family_id', 'is', null),
    (sb as any).from('jimscanner_trends_products').select('*', { count: 'exact', head: true }),
  ])
  return {
    families: famCount ?? 0,
    mappedProducts: prodFamCount ?? 0,
    totalProducts: prodTotal ?? 0,
  }
}

export default async function TrendRadarFamiliesPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string }>
}) {
  const sp = await searchParams
  const category = (CATEGORIES.includes(sp.cat as Category) ? sp.cat : 'all') as Category

  const [{ families, variants }, kpis] = await Promise.all([
    fetchFamilies(category),
    fetchKpis(),
  ])

  const mappedPct = kpis.totalProducts > 0
    ? Math.round((kpis.mappedProducts / kpis.totalProducts) * 100)
    : 0

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">패밀리(제품군) 리더보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            본체 + 변형/액세서리 통합 신호 점수 · 액세서리 비율 ≥30% 면 번들 위탁 후보
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← variant 단위 보드
        </Link>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <KpiCard label="등록 패밀리" value={kpis.families} hint="제품군 root" />
        <KpiCard label="매핑된 variant" value={kpis.mappedProducts} hint={`${mappedPct}% 진척`} />
        <KpiCard label="전체 product" value={kpis.totalProducts} hint="canonical 1:1" />
      </section>

      <nav className="flex gap-2 border-b border-gray-200">
        {CATEGORIES.map((c) => (
          <Link
            key={c}
            href={`/admin/trend-radar/families?cat=${c}`}
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

      {families.length === 0 ? (
        <EmptyState />
      ) : (
        <section className="space-y-2">
          <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
            <div className="col-span-1">#</div>
            <div className="col-span-4">패밀리 root</div>
            <div className="col-span-1 text-right">variant</div>
            <div className="col-span-1 text-right">acc%</div>
            <div className="col-span-1 text-right">Σ trend</div>
            <div className="col-span-1 text-right">max final</div>
            <div className="col-span-1 text-right">kw</div>
            <div className="col-span-2 text-right">lead variant</div>
          </div>
          {families.map((f, i) => {
            const vs = variants.get(f.family_id) ?? []
            const isBundleCandidate = f.accessory_ratio >= 0.3 && f.core_count >= 1
            return (
              <details
                key={f.family_id}
                className="rounded border border-gray-200 hover:bg-gray-50 transition-colors"
              >
                <summary className="grid grid-cols-12 px-3 py-2 cursor-pointer items-center">
                  <div className="col-span-1 text-gray-400 font-mono">{i + 1}</div>
                  <div className="col-span-4">
                    <div className="font-medium flex items-center gap-2">
                      {f.root_name}
                      {isBundleCandidate && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold">
                          🎁 본체+액세서리 번들 후보
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500">
                      {f.root_brand ? `${f.root_brand} · ` : ''}
                      {f.category_top}
                    </div>
                  </div>
                  <div className="col-span-1 text-right font-mono">{f.variant_count}</div>
                  <div className="col-span-1 text-right font-mono text-gray-600">
                    {Math.round(f.accessory_ratio * 100)}%
                  </div>
                  <div className="col-span-1 text-right font-mono font-bold">
                    {Math.round(f.sum_trend_score)}
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-600">
                    {Math.round(f.max_final_score)}
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-600">
                    {f.distinct_keywords}
                  </div>
                  <div className="col-span-2 text-right text-xs text-gray-500 truncate">
                    {f.lead_variant_name ?? '—'}
                  </div>
                </summary>
                {vs.length > 0 && (
                  <div className="px-3 pb-3 pt-1 border-t border-gray-100 bg-gray-50/50">
                    <div className="text-xs text-gray-500 mb-1">variants ({vs.length})</div>
                    <ul className="space-y-0.5">
                      {vs.map((v) => (
                        <li key={v.id} className="flex items-center justify-between text-sm">
                          <Link
                            href={`/admin/trend-radar/products/${v.id}`}
                            className="hover:underline truncate flex-1"
                          >
                            {v.canonical_name}
                          </Link>
                          <span
                            className={`ml-2 text-[10px] px-1.5 py-0.5 rounded font-medium ${roleBadge(v.variant_role)}`}
                          >
                            {v.variant_role ?? 'unknown'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </details>
            )
          })}
        </section>
      )}
    </div>
  )
}

function roleBadge(role: string | null) {
  switch (role) {
    case 'core': return 'bg-blue-100 text-blue-700'
    case 'accessory': return 'bg-amber-100 text-amber-700'
    case 'bundle': return 'bg-emerald-100 text-emerald-700'
    default: return 'bg-gray-100 text-gray-600'
  }
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

function EmptyState() {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
      <p className="text-base font-medium">아직 패밀리 매핑이 없습니다</p>
      <p className="text-sm mt-2">
        DDL <code className="px-1 bg-gray-100 rounded">supabase/trends_v5_product_families.sql</code> 적용 후,
        <br />
        로컬에서 <code className="px-1 bg-gray-100 rounded">node --env-file=.env.local scripts/extract-product-families.mjs</code> 를 실행하면
        product 들이 family 로 클러스터링됩니다.
      </p>
    </div>
  )
}
