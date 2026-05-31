import type { ReactNode } from 'react'
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
}

interface BriefingPayload {
  movers?: {
    up?: { product_id: string; name: string; prev: number; curr: number; delta: number }[]
    down?: { product_id: string; name: string; prev: number; curr: number; delta: number }[]
  }
  entries?: {
    entered?: { product_id: string; name: string; score: number }[]
    exited?: { product_id: string; name: string }[]
  }
  ggsan?: { goods_no: string; title: string; final_score: number; is_imminent: boolean; detail_url: string | null }[]
  alerts?: { kind: string; severity: string; message: string }[]
  backlog?: { unclassified: number; delta: number | null }
}
interface BriefingRow {
  briefing_date: string
  payload: BriefingPayload
  narrative: string | null
  computed_at: string
}

async function fetchBriefing(): Promise<BriefingRow | null> {
  const sb = createAdminClient()
  // jimscanner_trends_briefings 는 generated 타입 미반영 — supabase/trends_briefings.sql 적용 후 `as any` 캐스팅.
  const { data } = await (sb as any)
    .from('jimscanner_trends_briefings')
    .select('briefing_date, payload, narrative, computed_at')
    .order('briefing_date', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as BriefingRow | null) ?? null
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
  const { data: latestScores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, computed_at, score_components')
    .order('computed_at', { ascending: false })
    .limit(2000)

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

export default async function TrendRadarPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string }>
}) {
  const sp = await searchParams
  const category = (CATEGORIES.includes(sp.cat as Category) ? sp.cat : 'all') as Category

  const [{ products, scores, kpis }, tvPushes, tvGgsan, briefing] = await Promise.all([
    fetchData(category),
    fetchTvPushes(),
    fetchTvGgsanMatchSummary(),
    fetchBriefing(),
  ])

  const sorted = products
    .map((p) => ({ p, s: scores.get(p.id) }))
    .filter((x) => x.s)
    .sort((a, b) => (b.s!.final_score - a.s!.final_score))

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

      {/* 🌅 오늘의 브리핑 — 24h Δ 다이제스트 */}
      <BriefingCard briefing={briefing} />

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

      {/* Top 카드 */}
      <section>
        {sorted.length === 0 ? (
          <EmptyState category={category} />
        ) : (
          <div className="grid gap-3">
            <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
              <div className="col-span-1">#</div>
              <div className="col-span-5">상품명</div>
              <div className="col-span-1 text-right">final</div>
              <div className="col-span-1 text-right">trend</div>
              <div className="col-span-1 text-right">commerce</div>
              <div className="col-span-1 text-right">supplier</div>
              <div className="col-span-1 text-right">competition</div>
              <div className="col-span-1 text-right">aliases</div>
            </div>
            {sorted.slice(0, 50).map(({ p, s }, i) => (
              <Link
                key={p.id}
                href={`/admin/trend-radar/products/${p.id}`}
                className="grid grid-cols-12 px-3 py-2 rounded border border-gray-200 hover:bg-gray-50 transition-colors"
              >
                <div className="col-span-1 text-gray-400 font-mono">{i + 1}</div>
                <div className="col-span-5">
                  <div className="font-medium">{p.canonical_name}</div>
                  <div className="text-xs text-gray-500">{p.category_top}</div>
                </div>
                <div className="col-span-1 text-right font-mono font-bold">{s!.final_score}</div>
                <div className="col-span-1 text-right font-mono text-gray-600">{s!.trend_score}</div>
                <div className="col-span-1 text-right font-mono text-gray-600">{s!.commerce_score}</div>
                <div className="col-span-1 text-right font-mono text-gray-600">{s!.supplier_score}</div>
                <div className="col-span-1 text-right font-mono text-gray-600">{s!.competition_score}</div>
                <div className="col-span-1 text-right text-xs text-gray-500">{p.alias_count}</div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function BriefingCard({ briefing }: { briefing: BriefingRow | null }) {
  if (!briefing) {
    return (
      <section className="rounded border border-dashed border-gray-300 px-4 py-3 text-sm text-gray-500">
        🌅 오늘의 브리핑 — 아직 생성 전. 다음 로컬 cron(<code className="px-1 bg-gray-100 rounded text-xs">run-crons.mjs</code>)에서 자동 합성됩니다.
      </section>
    )
  }
  const p = briefing.payload ?? {}
  const up = p.movers?.up ?? []
  const down = p.movers?.down ?? []
  const entered = p.entries?.entered ?? []
  const exited = p.entries?.exited ?? []
  const ggsan = p.ggsan ?? []
  const alerts = p.alerts ?? []
  const backlog = p.backlog
  const prodHref = (id: string) => `/admin/trend-radar/products/${id}`

  return (
    <section className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-4 space-y-3">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-indigo-900">
          🌅 오늘의 브리핑{' '}
          <span className="text-xs font-normal text-gray-500 ml-1">{briefing.briefing_date} · 24h Δ 자동 감지</span>
        </h2>
        <span className="text-xs text-gray-400">합성 {briefing.computed_at.slice(5, 16).replace('T', ' ')}</span>
      </div>

      {briefing.narrative && (
        <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-line">{briefing.narrative}</p>
      )}

      {alerts.length > 0 && (
        <Link href="/admin/trend-radar/sources" className="block rounded border border-red-300 bg-red-50 px-3 py-2 hover:bg-red-100">
          {alerts.map((a, i) => (
            <div key={i} className="text-xs text-red-800">
              ⚠ {a.message}
            </div>
          ))}
          <div className="text-[10px] text-red-500 mt-1">소스 헬스 보기 →</div>
        </Link>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* 상승 무버 */}
        <BriefingColumn title="📈 상승 무버" empty={up.length === 0}>
          {up.map((m) => (
            <Link key={m.product_id} href={prodHref(m.product_id)} className="flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-white text-xs">
              <span className="truncate">{m.name}</span>
              <span className="font-mono font-bold text-emerald-700 flex-shrink-0">+{m.delta}</span>
            </Link>
          ))}
        </BriefingColumn>

        {/* 하락 무버 */}
        <BriefingColumn title="📉 하락 무버" empty={down.length === 0}>
          {down.map((m) => (
            <Link key={m.product_id} href={prodHref(m.product_id)} className="flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-white text-xs">
              <span className="truncate">{m.name}</span>
              <span className="font-mono font-bold text-red-700 flex-shrink-0">{m.delta}</span>
            </Link>
          ))}
        </BriefingColumn>

        {/* 신규 진입 / 이탈 */}
        <BriefingColumn title={`🆕 Top 진입 ${entered.length} / 이탈 ${exited.length}`} empty={entered.length === 0 && exited.length === 0}>
          {entered.slice(0, 5).map((m) => (
            <Link key={m.product_id} href={prodHref(m.product_id)} className="flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-white text-xs">
              <span className="truncate text-indigo-800">↑ {m.name}</span>
              <span className="font-mono text-gray-500 flex-shrink-0">{m.score}</span>
            </Link>
          ))}
          {exited.slice(0, 3).map((m) => (
            <Link key={m.product_id} href={prodHref(m.product_id)} className="px-2 py-1 rounded hover:bg-white text-xs text-gray-400 truncate block">
              ↓ {m.name}
            </Link>
          ))}
        </BriefingColumn>
      </div>

      {/* ggsan 교차 매치 + 적체 */}
      <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-indigo-100">
        {ggsan.length > 0 && (
          <Link href="/admin/trend-radar/recommend" className="text-xs bg-amber-100 text-amber-800 px-2 py-1 rounded hover:bg-amber-200">
            🛒 ggsan 교차 후보 {ggsan.length}건
            {ggsan[0] && <span className="ml-1 text-amber-700">· 최상위 {ggsan[0].title.slice(0, 14)} ({ggsan[0].final_score})</span>}
            <span className="ml-1">→</span>
          </Link>
        )}
        {backlog && (
          <span className="text-xs text-gray-500">
            미분류 적체 {backlog.unclassified.toLocaleString()}건
            {backlog.delta != null && backlog.delta !== 0 && (
              <span className={backlog.delta > 0 ? 'text-red-600 ml-1' : 'text-emerald-600 ml-1'}>
                ({backlog.delta > 0 ? '+' : ''}{backlog.delta})
              </span>
            )}
          </span>
        )}
      </div>
    </section>
  )
}

function BriefingColumn({ title, empty, children }: { title: string; empty: boolean; children: ReactNode }) {
  return (
    <div className="rounded border border-indigo-100 bg-white/60 p-2">
      <div className="text-xs font-semibold text-gray-600 mb-1 px-1">{title}</div>
      {empty ? <div className="text-xs text-gray-400 px-2 py-1">변화 없음</div> : <div className="space-y-0.5">{children}</div>}
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
