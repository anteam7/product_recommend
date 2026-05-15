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

const WINDOWS = [7, 30] as const
type Window = (typeof WINDOWS)[number]

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  brand: string | null
  alias_count: number
  last_seen_at: string
}
interface ScoreRow {
  product_id: string
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  final_score: number
  computed_at: string
  score_components: any
}

interface BrandRollup {
  brand: string
  category_top: string
  activeSku: number
  avgFinal: number
  maxFinal: number
  velocity: number
  supplierHits: number
  tvPushHits: number
  risingSkuCount: number
  newAliasCount: number
  products: Array<{
    id: string
    name: string
    category_mid: string | null
    finalScore: number
    delta: number
    supplierScore: number
    tvPush: boolean
    aliases: number
    spark: number[]
  }>
}

async function fetchBrandRollups(category: Category, windowDays: Window): Promise<BrandRollup[]> {
  const sb = createAdminClient()
  const sinceIso = new Date(Date.now() - windowDays * 86400_000).toISOString()

  // 1) Pull a generous slice of recent scores.
  const { data: scoreRows } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, computed_at, score_components')
    .order('computed_at', { ascending: false })
    .limit(8000)

  const scores = (scoreRows ?? []) as ScoreRow[]

  // latest score per product
  const latestByProduct = new Map<string, ScoreRow>()
  // earliest score within the active window per product (for delta)
  const earliestInWindow = new Map<string, ScoreRow>()
  // spark history per product (most-recent-first, cap 10)
  const sparkByProduct = new Map<string, number[]>()

  for (const s of scores) {
    if (!latestByProduct.has(s.product_id)) latestByProduct.set(s.product_id, s)
    if (s.computed_at >= sinceIso) {
      const cur = earliestInWindow.get(s.product_id)
      if (!cur || s.computed_at < cur.computed_at) earliestInWindow.set(s.product_id, s)
    }
    const arr = sparkByProduct.get(s.product_id) ?? []
    if (arr.length < 10) arr.push(Number(s.final_score))
    sparkByProduct.set(s.product_id, arr)
  }

  // 2) Pull products with a brand label.
  let pq = sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, category_mid, brand, alias_count, last_seen_at')
    .not('brand', 'is', null)
    .limit(5000)
  if (category !== 'all') pq = pq.eq('category_top', category)
  const { data: prodRows } = await pq
  const products = (prodRows ?? []) as ProductRow[]

  // 3) Group by (brand, category_top)
  const groups = new Map<string, BrandRollup>()
  for (const p of products) {
    const brand = (p.brand ?? '').trim()
    if (!brand) continue
    const latest = latestByProduct.get(p.id)
    if (!latest) continue
    const prior = earliestInWindow.get(p.id)
    const delta =
      prior && prior.computed_at !== latest.computed_at
        ? Number(latest.final_score) - Number(prior.final_score)
        : 0
    const tvPush = Number((latest.score_components as any)?.commerce?.tv_push ?? 0) > 0

    const key = `${brand}|||${p.category_top}`
    let g = groups.get(key)
    if (!g) {
      g = {
        brand,
        category_top: p.category_top,
        activeSku: 0,
        avgFinal: 0,
        maxFinal: 0,
        velocity: 0,
        supplierHits: 0,
        tvPushHits: 0,
        risingSkuCount: 0,
        newAliasCount: 0,
        products: [],
      }
      groups.set(key, g)
    }
    g.products.push({
      id: p.id,
      name: p.canonical_name,
      category_mid: p.category_mid,
      finalScore: Number(latest.final_score),
      delta,
      supplierScore: Number(latest.supplier_score),
      tvPush,
      aliases: p.alias_count ?? 0,
      spark: (sparkByProduct.get(p.id) ?? []).slice().reverse(),
    })
  }

  // 4) Per-group aggregates.
  const rollups: BrandRollup[] = []
  for (const g of groups.values()) {
    const finals = g.products.map((x) => x.finalScore)
    g.activeSku = g.products.length
    g.avgFinal = finals.length ? Math.round((finals.reduce((a, b) => a + b, 0) / finals.length) * 10) / 10 : 0
    g.maxFinal = finals.length ? Math.max(...finals) : 0
    g.velocity = Math.round(g.products.reduce((a, p) => a + p.delta, 0) * 10) / 10
    g.supplierHits = g.products.filter((p) => p.supplierScore >= 50).length
    g.tvPushHits = g.products.filter((p) => p.tvPush).length
    g.risingSkuCount = g.products.filter((p) => p.delta > 0).length
    // sort products inside group by finalScore desc
    g.products.sort((a, b) => b.finalScore - a.finalScore)
    rollups.push(g)
  }

  // 5) Optional new-alias count (best-effort, single query)
  if (rollups.length > 0) {
    const productIds = rollups.flatMap((g) => g.products.map((p) => p.id))
    if (productIds.length > 0) {
      const { data: aliasRows } = await sb
        .from('jimscanner_trends_aliases')
        .select('product_id, created_at')
        .in('product_id', productIds)
        .gte('created_at', sinceIso)
        .limit(20000)
      const byProduct = new Map<string, number>()
      for (const a of (aliasRows ?? []) as { product_id: string; created_at: string }[]) {
        byProduct.set(a.product_id, (byProduct.get(a.product_id) ?? 0) + 1)
      }
      for (const g of rollups) {
        g.newAliasCount = g.products.reduce((acc, p) => acc + (byProduct.get(p.id) ?? 0), 0)
      }
    }
  }

  rollups.sort((a, b) => {
    // multi-SKU rising first, then by velocity, then by maxFinal
    const aMulti = a.risingSkuCount >= 2 ? 1 : 0
    const bMulti = b.risingSkuCount >= 2 ? 1 : 0
    if (aMulti !== bMulti) return bMulti - aMulti
    if (b.velocity !== a.velocity) return b.velocity - a.velocity
    return b.maxFinal - a.maxFinal
  })

  return rollups
}

function Sparkline({ values }: { values: number[] }) {
  if (!values || values.length < 2) {
    return <span className="text-xs text-gray-300">—</span>
  }
  const w = 80
  const h = 20
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const step = w / (values.length - 1)
  const pts = values
    .map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`)
    .join(' ')
  const last = values[values.length - 1]
  const first = values[0]
  const stroke = last >= first ? '#16a34a' : '#dc2626'
  return (
    <svg width={w} height={h} className="inline-block align-middle">
      <polyline fill="none" stroke={stroke} strokeWidth="1.5" points={pts} />
    </svg>
  )
}

export default async function BrandRollupPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string; w?: string; brand?: string }>
}) {
  const sp = await searchParams
  const category = (CATEGORIES.includes(sp.cat as Category) ? sp.cat : 'all') as Category
  const windowDays = (WINDOWS.includes(Number(sp.w) as Window) ? Number(sp.w) : 7) as Window
  const openBrand = sp.brand ?? ''

  const rollups = await fetchBrandRollups(category, windowDays)

  const totalBrands = rollups.length
  const multiRising = rollups.filter((r) => r.risingSkuCount >= 2).length
  const tvHitBrands = rollups.filter((r) => r.tvPushHits > 0).length
  const supplierHitBrands = rollups.filter((r) => r.supplierHits > 0).length

  const expanded = openBrand
    ? rollups.find(
        (r) => r.brand === openBrand && (category === 'all' || r.category_top === category),
      ) ?? null
    : null

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">브랜드 모멘텀 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            브랜드 단위 다중 SKU 동반 상승 신호 — 라인업 전체가 부상 중인 브랜드를 우선 노출
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="브랜드 수" value={totalBrands} hint="brand 컬럼 채워진 SKU 보유" />
        <KpiCard label="다중 SKU 상승" value={multiRising} hint="2+ SKU 동시 상승" />
        <KpiCard label="TV push 브랜드" value={tvHitBrands} hint="홈쇼핑 편성 검출" />
        <KpiCard label="supplier 매칭" value={supplierHitBrands} hint="도매꾹·알리 검출" />
      </section>

      {/* 카테고리 + window 탭 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex gap-2 border-b border-gray-200">
          {CATEGORIES.map((c) => (
            <Link
              key={c}
              href={`/admin/trend-radar/brands?cat=${c}&w=${windowDays}`}
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
        <div className="flex gap-1 text-xs">
          {WINDOWS.map((w) => (
            <Link
              key={w}
              href={`/admin/trend-radar/brands?cat=${category}&w=${w}`}
              className={`px-3 py-1 rounded border ${
                windowDays === w
                  ? 'bg-black text-white border-black'
                  : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {w}일 window
            </Link>
          ))}
        </div>
      </div>

      {rollups.length === 0 ? (
        <EmptyState />
      ) : (
        <section className="space-y-1">
          <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
            <div className="col-span-3">브랜드</div>
            <div className="col-span-1">카테고리</div>
            <div className="col-span-1 text-right">SKU</div>
            <div className="col-span-1 text-right">avg</div>
            <div className="col-span-1 text-right">max</div>
            <div className="col-span-1 text-right">velocity</div>
            <div className="col-span-1 text-right">rising</div>
            <div className="col-span-1 text-right">TV</div>
            <div className="col-span-1 text-right">공급</div>
            <div className="col-span-1 text-right">신규alias</div>
          </div>

          {rollups.slice(0, 200).map((r) => {
            const key = `${r.brand}|${r.category_top}`
            const opened =
              expanded && expanded.brand === r.brand && expanded.category_top === r.category_top
            const multi = r.risingSkuCount >= 2
            return (
              <div key={key}>
                <Link
                  href={
                    opened
                      ? `/admin/trend-radar/brands?cat=${category}&w=${windowDays}`
                      : `/admin/trend-radar/brands?cat=${category}&w=${windowDays}&brand=${encodeURIComponent(r.brand)}#${encodeURIComponent(r.brand)}`
                  }
                  id={r.brand}
                  className={`grid grid-cols-12 px-3 py-2 rounded border transition-colors ${
                    multi
                      ? 'border-amber-300 bg-amber-50 hover:bg-amber-100'
                      : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <div className="col-span-3 flex items-center gap-2">
                    <span className="font-semibold">{r.brand}</span>
                    {multi && (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-200 text-amber-900">
                        🔥 라인업 상승 {r.risingSkuCount}/{r.activeSku}
                      </span>
                    )}
                  </div>
                  <div className="col-span-1 text-xs text-gray-500 self-center">{r.category_top}</div>
                  <div className="col-span-1 text-right font-mono">{r.activeSku}</div>
                  <div className="col-span-1 text-right font-mono">{r.avgFinal}</div>
                  <div className="col-span-1 text-right font-mono font-bold">{r.maxFinal}</div>
                  <div
                    className={`col-span-1 text-right font-mono ${
                      r.velocity > 0 ? 'text-green-700' : r.velocity < 0 ? 'text-red-600' : 'text-gray-400'
                    }`}
                  >
                    {r.velocity > 0 ? '+' : ''}
                    {r.velocity}
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-600">{r.risingSkuCount}</div>
                  <div className="col-span-1 text-right font-mono text-gray-600">{r.tvPushHits}</div>
                  <div className="col-span-1 text-right font-mono text-gray-600">{r.supplierHits}</div>
                  <div className="col-span-1 text-right font-mono text-gray-500">{r.newAliasCount}</div>
                </Link>

                {opened && (
                  <div className="ml-6 mb-3 mt-1 border-l-2 border-amber-300 pl-4 py-2 space-y-1">
                    <div className="text-xs text-gray-500 mb-1">
                      {r.brand} · {r.category_top} · {r.activeSku}개 SKU
                    </div>
                    {expanded!.products.map((p) => (
                      <Link
                        key={p.id}
                        href={`/admin/trend-radar/products/${p.id}`}
                        className="grid grid-cols-12 px-3 py-1.5 rounded border border-gray-200 hover:bg-white text-sm"
                      >
                        <div className="col-span-6">
                          <div className="font-medium truncate">{p.name}</div>
                          <div className="text-xs text-gray-500">{p.category_mid ?? '—'}</div>
                        </div>
                        <div className="col-span-2 self-center">
                          <Sparkline values={p.spark} />
                        </div>
                        <div className="col-span-1 text-right font-mono font-bold">{p.finalScore}</div>
                        <div
                          className={`col-span-1 text-right font-mono ${
                            p.delta > 0 ? 'text-green-700' : p.delta < 0 ? 'text-red-600' : 'text-gray-400'
                          }`}
                        >
                          {p.delta > 0 ? '+' : ''}
                          {Math.round(p.delta * 10) / 10}
                        </div>
                        <div className="col-span-1 text-right text-xs text-gray-600">
                          {p.tvPush ? 'TV' : ''}
                          {p.supplierScore >= 50 ? ' 공급' : ''}
                        </div>
                        <div className="col-span-1 text-right text-xs text-gray-500">{p.aliases} alias</div>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </section>
      )}

      <p className="text-xs text-gray-400">
        * brand 컬럼이 비어있는 product 는 집계에서 제외됩니다. backfill 은
        <code className="ml-1 px-1 bg-gray-100 rounded">scripts/classify-trends-llm.mjs</code>
        의 brand NER 단계 또는 별도 backfill 스크립트로.
      </p>
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

function EmptyState() {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
      <p className="text-base font-medium">아직 brand 컬럼이 채워진 product 가 없습니다</p>
      <p className="text-sm mt-2">
        LLM 분류기(<code>scripts/classify-trends-llm.mjs</code>) 가 canonical_name 으로부터
        브랜드 NER 을 채워야 집계가 시작됩니다.
      </p>
    </div>
  )
}
