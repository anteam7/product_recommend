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

interface SpreadRow {
  product_id: string
  alias_n: number
  total_volume: number
  top1_alias: string | null
  top1_share: number
  top3_share: number
  effective_alias_count: number
  capture_uplift: number
  gini: number
}

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
  alias_count: number
}

async function fetchSpread(category: Category) {
  const sb = createAdminClient()

  // View 는 마이그레이션 후 생성됨. 타입 안전성 우회 — as any.
  const { data: spreadRaw, error: spreadErr } = await (sb as any)
    .from('jimscanner_alias_spread')
    .select('*')
    .limit(2000)

  if (spreadErr) {
    return { rows: [], summary: emptySummary(), error: spreadErr.message }
  }

  const spread = (spreadRaw ?? []) as SpreadRow[]
  if (spread.length === 0) return { rows: [], summary: emptySummary(), error: null }

  const productIds = spread.map((s) => s.product_id)
  const prodQuery = sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, alias_count')
    .in('id', productIds)
  if (category !== 'all') prodQuery.eq('category_top', category)
  const { data: products } = await prodQuery
  const byId = new Map<string, ProductRow>(
    ((products ?? []) as ProductRow[]).map((p) => [p.id, p])
  )

  const merged = spread
    .map((s) => ({ s, p: byId.get(s.product_id) }))
    .filter((x) => x.p && (x.s.alias_n ?? 0) >= 2 && (x.s.total_volume ?? 0) > 0)

  merged.sort((a, b) => b.s.capture_uplift - a.s.capture_uplift)

  const summary = {
    products: merged.length,
    bigUplift: merged.filter((x) => x.s.capture_uplift >= 3 && x.s.top1_share < 0.4).length,
    consolidated: merged.filter((x) => x.s.top1_share >= 0.7).length,
    avgEffective:
      merged.length > 0
        ? merged.reduce((a, x) => a + (x.s.effective_alias_count || 0), 0) / merged.length
        : 0,
  }

  return { rows: merged, summary, error: null }
}

function emptySummary() {
  return { products: 0, bigUplift: 0, consolidated: 0, avgEffective: 0 }
}

function actionLabel(s: SpreadRow): { tag: string; tone: string } {
  if (s.top1_share >= 0.7) return { tag: '단일 표준 리스팅 OK', tone: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
  if (s.top1_share < 0.4 && s.capture_uplift >= 3)
    return { tag: '통합 차익 大 · 표준 리스팅 신규', tone: 'bg-rose-50 text-rose-700 border-rose-200' }
  if (s.top1_share < 0.55) return { tag: 'alias 별 분산 listing 고려', tone: 'bg-amber-50 text-amber-700 border-amber-200' }
  return { tag: '주력 + 보조 1~2개', tone: 'bg-gray-50 text-gray-600 border-gray-200' }
}

export default async function AliasSpreadPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string }>
}) {
  const sp = await searchParams
  const category = (CATEGORIES.includes(sp.cat as Category) ? sp.cat : 'all') as Category
  const { rows, summary, error } = await fetchSpread(category)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Alias 분산 · Capture Uplift</h1>
          <p className="text-sm text-gray-500 mt-1">
            한 product 의 alias 들이 검색량을 얼마나 균등하게 나눠 갖는지 · 단일 표준 리스팅 통합
            시 top1 단독 대비 흡수 가능한 추가 검색량 배수
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          view 조회 오류: {error}
          <div className="text-xs mt-1 text-red-600">
            supabase/trends_v5_alias_spread.sql 마이그레이션 적용 후 다시 시도.
          </div>
        </div>
      )}

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="분석 product" value={summary.products} hint="alias ≥ 2 · 데이터 존재" />
        <KpiCard label="통합 차익 大" value={summary.bigUplift} hint="uplift ≥ 3 & top1 < 40%" />
        <KpiCard label="이미 단일 표준 OK" value={summary.consolidated} hint="top1 점유 ≥ 70%" />
        <KpiCard
          label="평균 effective alias"
          value={Number(summary.avgEffective.toFixed(2))}
          hint="1/HHI"
        />
      </section>

      <nav className="flex gap-2 border-b border-gray-200">
        {CATEGORIES.map((c) => (
          <Link
            key={c}
            href={`/admin/trend-radar/alias-spread?cat=${c}`}
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

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 분석 대상이 없습니다</p>
          <p className="text-sm mt-2">
            alias 가 2개 이상이고 최근 30일 volume_relative 가 있는 product 만 표시됩니다.
            <br />
            jimscanner_trends_keywords 누적 후 다시 방문.
          </p>
        </div>
      ) : (
        <section>
          <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
            <div className="col-span-1">#</div>
            <div className="col-span-3">상품명</div>
            <div className="col-span-2">top1 alias</div>
            <div className="col-span-1 text-right">alias N</div>
            <div className="col-span-1 text-right">effective</div>
            <div className="col-span-1 text-right">top1%</div>
            <div className="col-span-1 text-right">uplift</div>
            <div className="col-span-2 text-right">추천 액션</div>
          </div>
          <div className="grid gap-1">
            {rows.slice(0, 100).map(({ s, p }, i) => {
              const action = actionLabel(s)
              return (
                <Link
                  key={s.product_id}
                  href={`/admin/trend-radar/products/${s.product_id}`}
                  className="grid grid-cols-12 px-3 py-2 rounded border border-gray-200 hover:bg-gray-50 transition-colors items-center"
                >
                  <div className="col-span-1 text-gray-400 font-mono">{i + 1}</div>
                  <div className="col-span-3">
                    <div className="font-medium truncate">{p!.canonical_name}</div>
                    <div className="text-xs text-gray-500">{p!.category_top}</div>
                  </div>
                  <div className="col-span-2 truncate text-sm text-gray-700">
                    {s.top1_alias ?? '—'}
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-600">{s.alias_n}</div>
                  <div className="col-span-1 text-right font-mono text-gray-600">
                    {Number(s.effective_alias_count).toFixed(2)}
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-600">
                    {(Number(s.top1_share) * 100).toFixed(0)}%
                  </div>
                  <div className="col-span-1 text-right font-mono font-bold">
                    {Number(s.capture_uplift).toFixed(2)}×
                  </div>
                  <div className="col-span-2 text-right">
                    <span className={`text-[10px] px-2 py-0.5 rounded border ${action.tone}`}>
                      {action.tag}
                    </span>
                  </div>
                </Link>
              )
            })}
          </div>
          <div className="text-xs text-gray-500 mt-3">
            상위 100 (capture_uplift 내림차순) · 총 {rows.length} 분석 대상
          </div>
        </section>
      )}

      <section className="rounded border border-gray-200 bg-gray-50 p-4 text-xs text-gray-600 space-y-1">
        <div className="font-semibold text-gray-700">읽는 법</div>
        <div>· <b>top1_share</b> 가 높을수록 한 alias 가 검색량 대부분을 차지 → 표준 리스팅 1개로 충분</div>
        <div>· <b>capture_uplift</b> = 1/top1_share. top1 단독 등록 대비, 모든 alias 를 통합 표준 리스팅으로 흡수했을 때 검색량 배수</div>
        <div>· <b>effective_alias_count</b> = 1/HHI. 균등 분포일수록 alias_n 에 가깝고, 한쪽으로 쏠리면 1 에 수렴</div>
        <div>· <b>gini</b> = 0 (완전 균등) ~ 1 (완전 집중). 높을수록 통합 가치는 적음</div>
      </section>
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
