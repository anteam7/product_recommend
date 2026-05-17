import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface ScoreRow {
  product_id: string
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  final_score: number
  computed_at: string
  score_components?: any
}
interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
  alias_count: number
  last_seen_at: string
}

interface RowWithGap extends ScoreRow {
  product: ProductRow
  // 단독 조정 시 가장 작은 delta (균등 가중치 0.25 가정)
  minDelta: number
  minDeltaComponent: string
  // 100 천장 초과 안 하는지
  minDeltaFeasible: boolean
}

function computeMinDelta(s: ScoreRow): {
  minDelta: number
  component: string
  feasible: boolean
} {
  const gap = 50 - Number(s.final_score)
  const deltaNeeded = gap / 0.25 // 균등 가중치
  const comps = [
    { name: 'trend', cur: Number(s.trend_score) },
    { name: 'commerce', cur: Number(s.commerce_score) },
    { name: 'supplier', cur: Number(s.supplier_score) },
    { name: 'competition', cur: Number(s.competition_score) },
  ]
  // 가장 헤드룸 큰 (현재값 가장 낮은) 컴포넌트 = 단독 끌어올리기 가장 쉬움
  comps.sort((a, b) => a.cur - b.cur)
  const top = comps[0]
  return {
    minDelta: deltaNeeded,
    component: top.name,
    feasible: top.cur + deltaNeeded <= 100,
  }
}

async function fetchData() {
  const sb = createAdminClient()

  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select(
      'product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, computed_at, score_components',
    )
    .order('computed_at', { ascending: false })
    .limit(3000)

  // product_id 별 latest 만
  const seen = new Set<string>()
  const latest: ScoreRow[] = []
  for (const s of (scores ?? []) as ScoreRow[]) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latest.push(s)
  }

  // 경계권 30~49.99
  const borderline = latest.filter(
    (s) => Number(s.final_score) >= 30 && Number(s.final_score) < 50,
  )
  if (borderline.length === 0) return { rows: [] as RowWithGap[] }

  const ids = borderline.map((s) => s.product_id)
  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, alias_count, last_seen_at')
    .in('id', ids)
  const byId = new Map<string, ProductRow>(
    ((prods ?? []) as ProductRow[]).map((p) => [p.id, p]),
  )

  const rows: RowWithGap[] = borderline
    .map((s) => {
      const product = byId.get(s.product_id)
      if (!product) return null
      const md = computeMinDelta(s)
      return {
        ...s,
        product,
        minDelta: md.minDelta,
        minDeltaComponent: md.component,
        minDeltaFeasible: md.feasible,
      }
    })
    .filter((r): r is RowWithGap => r !== null)
    // 가장 작은 delta 가 먼저
    .sort((a, b) => {
      // feasible 먼저, delta 작은 순
      if (a.minDeltaFeasible !== b.minDeltaFeasible) {
        return a.minDeltaFeasible ? -1 : 1
      }
      return a.minDelta - b.minDelta
    })

  return { rows }
}

export default async function AlmostTherePage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string; comp?: string }>
}) {
  const sp = await searchParams
  const filterCat = sp.cat ?? 'all'
  const filterComp = sp.comp ?? 'all'

  const { rows } = await fetchData()
  const filtered = rows.filter((r) => {
    if (filterCat !== 'all' && r.product.category_top !== filterCat) return false
    if (filterComp !== 'all' && r.minDeltaComponent !== filterComp) return false
    return true
  })

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">🚪 Almost There — 진입 경계권</h1>
          <p className="text-sm text-gray-500 mt-1">
            final_score 30~49 의 borderline 상품. 어떤 데이터 한 조각을 보강하면 게이트(50)에 진입하는지 자동 진단.
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 대시보드
        </Link>
      </header>

      {/* 필터 */}
      <div className="flex flex-wrap gap-2 text-xs">
        <FilterGroup
          label="카테고리"
          param="cat"
          current={filterCat}
          other={filterComp}
          otherParam="comp"
          options={[
            ['all', '전체'],
            ['health', '건강식품'],
            ['living', '생활/리빙'],
            ['digital', '디지털/가전'],
          ]}
        />
        <FilterGroup
          label="권장 액션"
          param="comp"
          current={filterComp}
          other={filterCat}
          otherParam="cat"
          options={[
            ['all', '전체'],
            ['trend', 'trend 보강'],
            ['commerce', 'commerce 보강'],
            ['supplier', 'supplier 보강'],
            ['competition', 'competition 보강'],
          ]}
        />
      </div>

      <section className="text-xs text-gray-500">
        총 {rows.length}개 경계권 상품 · 필터 적용 {filtered.length}개
      </section>

      {filtered.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">경계권 상품이 없습니다</p>
          <p className="text-sm mt-2">
            아직 데이터가 누적되지 않았거나, 모든 상품이 게이트(50) 통과 또는 30 미만입니다.
          </p>
        </div>
      ) : (
        <div className="grid gap-2">
          <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
            <div className="col-span-1">#</div>
            <div className="col-span-4">상품명</div>
            <div className="col-span-1 text-right">final</div>
            <div className="col-span-2 text-right">단독 보강</div>
            <div className="col-span-2 text-right">필요 delta</div>
            <div className="col-span-2 text-right">현재→목표</div>
          </div>
          {filtered.slice(0, 200).map((r, i) => {
            const compCur =
              r.minDeltaComponent === 'trend'
                ? r.trend_score
                : r.minDeltaComponent === 'commerce'
                  ? r.commerce_score
                  : r.minDeltaComponent === 'supplier'
                    ? r.supplier_score
                    : r.competition_score
            const compTarget = Math.min(100, Number(compCur) + r.minDelta)
            return (
              <Link
                key={r.product_id}
                href={`/admin/trend-radar/products/${r.product_id}`}
                className={`grid grid-cols-12 px-3 py-2 rounded border transition-colors ${
                  r.minDeltaFeasible
                    ? 'border-amber-200 bg-amber-50/40 hover:bg-amber-50'
                    : 'border-gray-200 bg-gray-50/60 hover:bg-gray-100'
                }`}
              >
                <div className="col-span-1 text-gray-400 font-mono text-sm">{i + 1}</div>
                <div className="col-span-4">
                  <div className="font-medium text-sm">{r.product.canonical_name}</div>
                  <div className="text-xs text-gray-500">{r.product.category_top}</div>
                </div>
                <div className="col-span-1 text-right font-mono font-bold text-sm">
                  {Number(r.final_score).toFixed(0)}
                </div>
                <div className="col-span-2 text-right text-xs">
                  <span className="px-1.5 py-0.5 rounded bg-white border border-amber-200 font-medium">
                    {r.minDeltaComponent}
                  </span>
                  {!r.minDeltaFeasible && (
                    <span className="ml-1 text-[10px] text-gray-500">(불가)</span>
                  )}
                </div>
                <div className="col-span-2 text-right font-mono text-amber-700 font-bold text-sm">
                  +{r.minDelta.toFixed(1)}
                </div>
                <div className="col-span-2 text-right font-mono text-xs text-gray-600">
                  {Number(compCur).toFixed(0)} → {compTarget.toFixed(0)}
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

function FilterGroup({
  label,
  param,
  current,
  other,
  otherParam,
  options,
}: {
  label: string
  param: string
  current: string
  other: string
  otherParam: string
  options: [string, string][]
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-gray-500 mr-1">{label}:</span>
      {options.map(([val, lab]) => {
        const qs = new URLSearchParams()
        if (val !== 'all') qs.set(param, val)
        if (other !== 'all') qs.set(otherParam, other)
        const href =
          '/admin/trend-radar/almost-there' + (qs.toString() ? `?${qs}` : '')
        const active = current === val
        return (
          <Link
            key={val}
            href={href}
            className={`px-2 py-0.5 rounded ${
              active
                ? 'bg-black text-white'
                : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50'
            }`}
          >
            {lab}
          </Link>
        )
      })}
    </div>
  )
}
