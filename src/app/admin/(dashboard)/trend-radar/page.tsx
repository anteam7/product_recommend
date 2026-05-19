import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import RejectActions from './RejectActions'

export const dynamic = 'force-dynamic'

const CATEGORIES = ['all', 'health', 'living', 'digital'] as const
type Category = (typeof CATEGORIES)[number]

const CATEGORY_LABEL: Record<Category, string> = {
  all: '전체',
  health: '건강식품',
  living: '생활/리빙',
  digital: '디지털/가전',
}

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
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
  score_components?: any
  reject_prob?: number | null
}

async function fetchTvGgsanMatchSummary() {
  const sb = createAdminClient()
  const { data } = await sb.rpc('jimscanner_tv_ggsan_match', {
    days_window: 30,
    min_sim: 0.2,
    per_keyword_limit: 3,
    result_limit: 500,
  })
  type Row = { keyword: string; is_imminent: boolean }
  const rows = (data ?? []) as Row[]
  const uniqueKw = new Set(rows.map((r) => r.keyword)).size
  const imminentRows = rows.filter((r) => r.is_imminent).length
  const imminentKw = new Set(rows.filter((r) => r.is_imminent).map((r) => r.keyword)).size
  return { totalRows: rows.length, uniqueKw, imminentRows, imminentKw }
}

async function fetchTvPushes() {
  const sb = createAdminClient()
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()
  const { data } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, category, collected_at')
    .eq('source', 'naver_tvtime')
    .gte('collected_at', since)
  type Row = { keyword: string; category: string | null; collected_at: string }
  const rows = (data ?? []) as Row[]

  // 같은 keyword 의 편성 횟수 + 시간대 + 마지막 등장
  const map = new Map<string, { keyword: string; count: number; slots: Set<string>; last: string }>()
  for (const r of rows) {
    const k = r.keyword
    let v = map.get(k)
    if (!v) { v = { keyword: k, count: 0, slots: new Set(), last: r.collected_at }; map.set(k, v) }
    v.count++
    if (r.category) v.slots.add(r.category)
    if (r.collected_at > v.last) v.last = r.collected_at
  }
  const ranked = [...map.values()]
    .sort((a, b) => b.count - a.count || (b.last.localeCompare(a.last)))
    .slice(0, 20)
    .map((v) => ({ ...v, slots: [...v.slots].sort() }))
  return { ranked, totalKeywords: map.size, totalRows: rows.length }
}

async function fetchData(category: Category) {
  const sb = createAdminClient()

  // 최신 score 별 product_id 조회 — 같은 product 의 가장 최근 row 만.
  // reject_prob 컬럼은 trends_v4_reject_learning.sql 마이그레이션 후 채워짐.
  const { data: latestScores } = (await sb
    .from('jimscanner_trends_scores')
    .select(
      'product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, computed_at, score_components, reject_prob',
    )
    .order('computed_at', { ascending: false })
    .limit(2000)) as { data: ScoreRow[] | null }

  // product_id 별 첫 등장 (가장 최근) 만 keep
  const seen = new Set<string>()
  const latestMap = new Map<string, ScoreRow>()
  for (const s of (latestScores ?? []) as ScoreRow[]) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latestMap.set(s.product_id, s)
  }

  const productIds = [...latestMap.keys()]
  if (productIds.length === 0) return { products: [], scores: latestMap, kpis: { products: 0, top: 0, supplier: 0, tv: 0, llmClassified: 0 } }

  const prodQuery = sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, alias_count, last_seen_at')
    .in('id', productIds)

  if (category !== 'all') prodQuery.eq('category_top', category)

  const { data: products } = await prodQuery

  // KPI
  const allCount = (await sb.from('jimscanner_trends_products').select('*', { count: 'exact', head: true })).count ?? 0
  const llmClassifiedCount =
    (await sb
      .from('jimscanner_trends_products')
      .select('*', { count: 'exact', head: true })
      .not('llm_classified_at', 'is', null)).count ?? 0
  const topCount = [...latestMap.values()].filter((s) => s.final_score >= 50).length
  const supplierCount = [...latestMap.values()].filter((s) => s.supplier_score >= 50).length
  const tvCount = [...latestMap.values()].filter((s) => (s.score_components as any)?.commerce?.tv_push > 0).length

  return {
    products: (products ?? []) as ProductRow[],
    scores: latestMap,
    kpis: { products: allCount, top: topCount, supplier: supplierCount, tv: tvCount, llmClassified: llmClassifiedCount },
  }
}

const REJECT_THRESHOLD = 0.6
const REJECT_PENALTY = 0.6 // final_score 곱연산 페널티 (1.0 = 페널티 X, 0 = 완전 차단)

export default async function TrendRadarPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string; showFiltered?: string }>
}) {
  const sp = await searchParams
  const category = (CATEGORIES.includes(sp.cat as Category) ? sp.cat : 'all') as Category
  const showFiltered = sp.showFiltered === '1'

  const [{ products, scores, kpis }, tvPushes, tvGgsan] = await Promise.all([
    fetchData(category),
    fetchTvPushes(),
    fetchTvGgsanMatchSummary(),
  ])

  const enriched = products
    .map((p) => {
      const s = scores.get(p.id)
      if (!s) return null
      const rp = typeof s.reject_prob === 'number' ? s.reject_prob : null
      const isFiltered = rp != null && rp >= REJECT_THRESHOLD
      const adjusted = isFiltered ? s.final_score * REJECT_PENALTY : s.final_score
      return { p, s, rp, isFiltered, adjusted }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  const visible = enriched.filter((x) => showFiltered || !x.isFiltered)
  const hiddenCount = enriched.filter((x) => x.isFiltered).length

  const sorted = visible.sort((a, b) => b.adjusted - a.adjusted)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">트렌드 레이더 PRO</h1>
          <p className="text-sm text-gray-500 mt-1">
            위탁 판매 상품 발굴 · 30일 누적 후 4점수 정확도 ↑
          </p>
        </div>
        <Link
          href="/admin/trend-radar/sources"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          소스 헬스 →
        </Link>
      </header>

      {/* KPI 5종 */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <KpiCard label="canonical 상품" value={kpis.products} hint="누적 매핑" />
        <KpiCard label="LLM 분류" value={kpis.llmClassified} hint={`${kpis.products > 0 ? Math.round((kpis.llmClassified / kpis.products) * 100) : 0}% 진척`} />
        <KpiCard label="고득점 (≥50)" value={kpis.top} hint="final_score 기준" />
        <KpiCard label="supplier 매칭" value={kpis.supplier} hint="도매꾹·알리 검출" />
        <KpiCard label="TV push" value={kpis.tv} hint="홈쇼핑 편성 검출" />
      </section>

      {/* 카테고리 탭 */}
      <nav className="flex gap-2 border-b border-gray-200">
        {CATEGORIES.map((c) => (
          <Link
            key={c}
            href={`/admin/trend-radar?cat=${c}`}
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

      {/* 🔥 TV ↔ ggsan 매칭 callout */}
      <Link
        href="/admin/trend-radar/tv-ggsan-match"
        className={`block rounded border px-4 py-3 transition-colors ${
          tvGgsan.imminentRows > 0
            ? 'border-red-300 bg-red-50 hover:bg-red-100'
            : 'border-gray-200 hover:bg-gray-50'
        }`}
      >
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <div className="text-sm font-semibold">
              🔥 TV 편성 ↔ ggsan 매칭{' '}
              <span className="text-xs font-normal text-gray-500 ml-1">
                홈쇼핑 push 상품 중 ggsan 도매몰 후보
              </span>
            </div>
            <div className="text-xs text-gray-600 mt-0.5">
              {tvGgsan.uniqueKw}개 TV 키워드 → {tvGgsan.totalRows} 매칭
              {tvGgsan.imminentRows > 0 && (
                <span className="ml-2 text-red-700 font-semibold">
                  · 임박특가 매칭 {tvGgsan.imminentRows}건 ({tvGgsan.imminentKw} 키워드)
                </span>
              )}
            </div>
          </div>
          <span className="text-xs text-gray-500">매칭 보러가기 →</span>
        </div>
      </Link>

      {/* TV 편성 push Top 20 */}
      <section className="rounded border border-gray-200 p-4 bg-amber-50/40">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-700">
            🎯 TV 편성 push Top 20{' '}
            <span className="text-xs font-normal text-gray-500 ml-2">
              (홈쇼핑 9사 통합 · 30일 누적 · 빈도순)
            </span>
          </h2>
          <Link
            href="/admin/trend-radar/tv-pushes"
            className="text-xs text-gray-600 hover:text-black underline"
          >
            전체 분석 →
          </Link>
        </div>
        {tvPushes.ranked.length === 0 ? (
          <div className="text-sm text-gray-500 text-center py-6">
            아직 데이터 없음. 다음 KST 04:10 자동 수집.
          </div>
        ) : (
          <div className="space-y-1">
            <div className="grid grid-cols-12 text-xs text-gray-500 px-2 py-1">
              <div className="col-span-1">#</div>
              <div className="col-span-7">상품명</div>
              <div className="col-span-1 text-right">편성</div>
              <div className="col-span-2 text-right">시간대</div>
              <div className="col-span-1 text-right">최근</div>
            </div>
            {tvPushes.ranked.map((r, i) => (
              <div key={r.keyword} className="grid grid-cols-12 px-2 py-1 text-sm rounded hover:bg-white">
                <div className="col-span-1 font-mono text-gray-400">{i + 1}</div>
                <div className="col-span-7 truncate">{r.keyword}</div>
                <div className="col-span-1 text-right font-mono font-bold">{r.count}</div>
                <div className="col-span-2 text-right text-xs text-gray-500">
                  {r.slots.length === 1 ? r.slots[0] : `${r.slots.length} 슬롯`}
                </div>
                <div className="col-span-1 text-right text-xs text-gray-400">
                  {r.last.slice(5, 10)}
                </div>
              </div>
            ))}
            <div className="text-xs text-gray-500 mt-3 pt-2 border-t border-amber-200">
              총 {tvPushes.totalKeywords}개 unique 상품 · {tvPushes.totalRows}회 편성 누적 (30일)
            </div>
          </div>
        )}
      </section>

      {/* 리젝 학습 필터 토글 */}
      {hiddenCount > 0 && (
        <div className="flex items-center justify-between rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs">
          <div className="text-gray-600">
            🧠 리젝 학습 필터가 <strong>{hiddenCount}건</strong>을 숨겼습니다 (reject_prob ≥ {REJECT_THRESHOLD})
          </div>
          <Link
            href={`/admin/trend-radar?cat=${category}${showFiltered ? '' : '&showFiltered=1'}`}
            className="px-2 py-1 rounded border border-gray-300 bg-white hover:bg-gray-100"
          >
            {showFiltered ? '숨기기' : '필터가 숨긴 N건 검토 →'}
          </Link>
        </div>
      )}

      {/* Top 카드 */}
      <section>
        {sorted.length === 0 ? (
          <EmptyState category={category} />
        ) : (
          <div className="grid gap-3">
            <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
              <div className="col-span-1">#</div>
              <div className="col-span-4">상품명</div>
              <div className="col-span-1 text-right">final</div>
              <div className="col-span-1 text-right">trend</div>
              <div className="col-span-1 text-right">commerce</div>
              <div className="col-span-1 text-right">supplier</div>
              <div className="col-span-1 text-right">competition</div>
              <div className="col-span-2 text-right">학습/액션</div>
            </div>
            {sorted.slice(0, 50).map(({ p, s, rp, isFiltered, adjusted }, i) => (
              <div
                key={p.id}
                className={`grid grid-cols-12 px-3 py-2 rounded border transition-colors ${
                  isFiltered
                    ? 'border-gray-200 bg-gray-50/50 opacity-60 hover:opacity-90'
                    : 'border-gray-200 hover:bg-gray-50'
                }`}
              >
                <Link
                  href={`/admin/trend-radar/products/${p.id}`}
                  className="col-span-10 grid grid-cols-10"
                >
                  <div className="col-span-1 text-gray-400 font-mono">{i + 1}</div>
                  <div className="col-span-4">
                    <div className="font-medium">{p.canonical_name}</div>
                    <div className="text-xs text-gray-500">
                      {p.category_top}
                      {isFiltered && <span className="ml-2 text-amber-700">· 학습 필터 디머</span>}
                    </div>
                  </div>
                  <div className="col-span-1 text-right font-mono font-bold">
                    {Math.round(adjusted)}
                    {isFiltered && (
                      <div className="text-[10px] text-gray-400 line-through">{s!.final_score}</div>
                    )}
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-600">{s!.trend_score}</div>
                  <div className="col-span-1 text-right font-mono text-gray-600">{s!.commerce_score}</div>
                  <div className="col-span-1 text-right font-mono text-gray-600">{s!.supplier_score}</div>
                  <div className="col-span-1 text-right font-mono text-gray-600">{s!.competition_score}</div>
                </Link>
                <div className="col-span-2 flex justify-end items-center">
                  <RejectActions productId={p.id} rejectProb={rp} surface="trend-radar" />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
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

function EmptyState({ category }: { category: Category }) {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
      <p className="text-base font-medium">아직 매핑된 상품이 없습니다</p>
      <p className="text-sm mt-2">
        cron 매일 KST 06:00 recompute 가 누적된 키워드를 canonical product 로 정규화 매핑합니다.
        <br />
        30일 누적 후에야 multi-source 시그널 + LLM 분류로 진짜 신호가 분리됩니다.
      </p>
      <p className="text-xs mt-4 text-gray-400">
        category={category} · 수동 재산출은 WSL 안:
        <code className="ml-1 px-1 bg-gray-100 rounded">tsx src/scoring/recompute.ts</code>
      </p>
    </div>
  )
}
