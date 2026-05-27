import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface DemandRow {
  category: string
  modifier: string
  period_start: string
  period_days: number
  query_count: number
  share: number | null
  slope_7d: number | null
  rank_in_category: number | null
}

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string | null
}

const CATEGORIES = ['all', 'health', 'living', 'digital', 'other'] as const
type Category = (typeof CATEGORIES)[number]

const CATEGORY_LABEL: Record<Category, string> = {
  all: '전체',
  health: '건강식품',
  living: '생활/리빙',
  digital: '디지털/가전',
  other: '기타',
}

const PERIODS = [1, 7, 30] as const
type Period = (typeof PERIODS)[number]
const WINDOW_BUCKETS = 12 // 누적영역차트에 보여줄 최근 버킷 수

const MODIFIER_PATTERNS: Record<string, string[]> = {
  대용량: ['대용량', '초대용량', '벌크', '점보'],
  미니: ['미니', '소형', '컴팩트', '초소형'],
  '1인용': ['1인용', '일인용', '싱글'],
  '2인용': ['2인용', '이인용', '커플'],
  대형: ['대형', '특대', 'xl', '맥시'],
  무선: ['무선', '와이어리스', 'wireless'],
  유선: ['유선'],
  접이식: ['접이식', '폴딩', '폴더블', '접는'],
  휴대용: ['휴대용', '포터블', 'portable'],
  접지형: ['접지형', '접지', '3구', '돼지코'],
  벽걸이: ['벽걸이', '월마운트'],
  스탠드: ['스탠드형', '스탠드', '수직'],
  저렴한: ['저렴한', '저가', '가성비', '초저가'],
  프리미엄: ['프리미엄', '하이엔드', '럭셔리'],
  명품: ['명품'],
  세트: ['세트', '패키지', '키트', '번들'],
  리퍼: ['리퍼', '리퍼비시', 'refurb'],
  중고: ['중고'],
  한정: ['한정', '리미티드', 'limited'],
  신상: ['신상', '신제품', '신형'],
  친환경: ['친환경', '에코', 'eco', '비건'],
  국산: ['국산'],
  수입: ['수입', '직구', '병행수입'],
  핸드메이드: ['핸드메이드', '수제'],
  블랙: ['블랙', 'black'],
  화이트: ['화이트', 'white'],
  심플: ['심플', '미니멀', '모던'],
  고출력: ['고출력', '하이파워', '대출력'],
  저소음: ['저소음', '무소음', '정숙'],
  방수: ['방수', '생활방수', 'ipx'],
  OLED: ['oled'],
  '4K': ['4k', 'uhd', '4케이'],
}

function modifierMatchesName(modifier: string, name: string): boolean {
  const t = name.toLowerCase()
  const patterns = MODIFIER_PATTERNS[modifier] ?? [modifier]
  return patterns.some((p) => t.includes(p.toLowerCase()))
}

async function fetchData(category: Category, period: Period) {
  const sb = createAdminClient()

  // 최근 윈도우 * period_days 일치만
  const sinceDate = new Date(Date.now() - WINDOW_BUCKETS * period * 86400_000)
  const sinceIso = sinceDate.toISOString().slice(0, 10)

  const dq = sb
    .from('jimscanner_modifier_demand' as never)
    .select('category, modifier, period_start, period_days, query_count, share, slope_7d, rank_in_category')
    .eq('period_days', period)
    .gte('period_start', sinceIso)
    .order('period_start', { ascending: true })
    .limit(5000)
  if (category !== 'all') dq.eq('category', category)
  const { data: rowsRaw } = (await dq) as { data: DemandRow[] | null }
  const rows = (rowsRaw ?? []) as DemandRow[]

  // SKU 매칭 — 카테고리 내 자기 상품들. 카테고리=all 이면 전체.
  const pq = sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .limit(2000)
  if (category !== 'all') pq.eq('category_top', category)
  const { data: prodsRaw } = await pq
  const products = (prodsRaw ?? []) as ProductRow[]

  return { rows, products }
}

function buildModifierSeries(rows: DemandRow[]) {
  // periodStart 오름차순으로 들어옴 가정. modifier 별 시계열 구축.
  const periods = Array.from(new Set(rows.map((r) => r.period_start))).sort()
  const lastPeriods = periods.slice(-WINDOW_BUCKETS)
  const byMod = new Map<
    string,
    {
      modifier: string
      counts: number[]
      shares: number[]
      lastShare: number
      lastCount: number
      slope: number | null
      rank: number | null
    }
  >()

  for (const r of rows) {
    const e = byMod.get(r.modifier) ?? {
      modifier: r.modifier,
      counts: new Array(lastPeriods.length).fill(0),
      shares: new Array(lastPeriods.length).fill(0),
      lastShare: 0,
      lastCount: 0,
      slope: null,
      rank: null,
    }
    const idx = lastPeriods.indexOf(r.period_start)
    if (idx >= 0) {
      e.counts[idx] = (e.counts[idx] ?? 0) + r.query_count
      e.shares[idx] = Math.max(e.shares[idx] ?? 0, r.share ?? 0)
    }
    e.slope = r.slope_7d ?? e.slope
    e.rank = r.rank_in_category ?? e.rank
    byMod.set(r.modifier, e)
  }

  for (const e of byMod.values()) {
    e.lastCount = e.counts[e.counts.length - 1] ?? 0
    e.lastShare = e.shares[e.shares.length - 1] ?? 0
  }

  const list = [...byMod.values()].sort((a, b) => (b.slope ?? -Infinity) - (a.slope ?? -Infinity))
  return { lastPeriods, list }
}

export default async function ModifierAxisPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string; period?: string }>
}) {
  const sp = await searchParams
  const category = (CATEGORIES.includes(sp.cat as Category) ? sp.cat : 'all') as Category
  const periodNum = Number.parseInt(sp.period ?? '1', 10)
  const period = (PERIODS.includes(periodNum as Period) ? periodNum : 1) as Period

  const { rows, products } = await fetchData(category, period)
  const { lastPeriods, list } = buildModifierSeries(rows)

  // 카운트: 카테고리 SKU 중 해당 modifier 미포함 SKU 수
  function missingSkuCount(modifier: string) {
    if (products.length === 0) return 0
    let missing = 0
    for (const p of products) {
      if (!modifierMatchesName(modifier, p.canonical_name)) missing++
    }
    return missing
  }

  // KPI
  const totalQueries = list.reduce((s, m) => s + m.lastCount, 0)
  const risingCount = list.filter((m) => (m.slope ?? 0) > 0).length
  const fallingCount = list.filter((m) => (m.slope ?? 0) < 0).length

  // 상위 8개 누적영역차트
  const topForArea = list.slice(0, 8)
  const periodIndexCount = lastPeriods.length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">수식어 수요 벡터</h1>
          <p className="text-sm text-gray-500 mt-1">
            카테고리 안에서 어떤 포지셔닝축(대용량·미니·무선·접이식·프리미엄…)이 부상 중인지 분해해서 본다.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="수식어" value={list.length} hint={`category=${category}`} />
        <KpiCard label="합산 쿼리" value={totalQueries} hint={`period=${period}d · 최근 ${periodIndexCount}버킷`} />
        <KpiCard label="상승 수식어" value={risingCount} hint="slope_7d > 0" />
        <KpiCard label="하락 수식어" value={fallingCount} hint="slope_7d < 0" />
      </section>

      <div className="flex flex-wrap gap-4 items-end border-b border-gray-200 pb-3">
        <nav className="flex gap-2">
          {CATEGORIES.map((c) => (
            <Link
              key={c}
              href={`/admin/trend-radar/modifier-axis?cat=${c}&period=${period}`}
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
        <nav className="flex gap-2 ml-auto">
          {PERIODS.map((p) => (
            <Link
              key={p}
              href={`/admin/trend-radar/modifier-axis?cat=${category}&period=${p}`}
              className={`px-3 py-1 text-xs rounded ${
                period === p ? 'bg-black text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {p}d
            </Link>
          ))}
        </nav>
      </div>

      {list.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <section className="rounded border border-gray-200 p-4">
            <h2 className="text-sm font-semibold mb-3 text-gray-700">
              demand-share 누적 (Top {topForArea.length}, 최근 {periodIndexCount}버킷)
            </h2>
            <StackedArea modifiers={topForArea} periodCount={periodIndexCount} />
          </section>

          <section>
            <h2 className="text-sm font-semibold mb-2 text-gray-700">슬로프 정렬 — 상승 우선</h2>
            <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
              <div className="col-span-1">#</div>
              <div className="col-span-2">수식어</div>
              <div className="col-span-1 text-right">최근 쿼리</div>
              <div className="col-span-1 text-right">share</div>
              <div className="col-span-1 text-right">slope_7d</div>
              <div className="col-span-1 text-right">랭크</div>
              <div className="col-span-3">{periodIndexCount}버킷 추세</div>
              <div className="col-span-2 text-right">미포함 SKU</div>
            </div>
            {list.map((m, i) => {
              const max = Math.max(1, ...m.counts)
              const missing = missingSkuCount(m.modifier)
              return (
                <div
                  key={m.modifier}
                  className="grid grid-cols-12 px-3 py-2 rounded border border-gray-200 hover:bg-gray-50 transition-colors text-sm mt-1"
                >
                  <div className="col-span-1 font-mono text-gray-400">{i + 1}</div>
                  <div className="col-span-2 font-medium">{m.modifier}</div>
                  <div className="col-span-1 text-right font-mono">{m.lastCount.toLocaleString()}</div>
                  <div className="col-span-1 text-right font-mono text-gray-600">
                    {(m.lastShare * 100).toFixed(1)}%
                  </div>
                  <div
                    className={`col-span-1 text-right font-mono font-bold ${
                      (m.slope ?? 0) > 0
                        ? 'text-green-600'
                        : (m.slope ?? 0) < 0
                          ? 'text-red-600'
                          : 'text-gray-400'
                    }`}
                  >
                    {m.slope == null ? '—' : m.slope.toFixed(2)}
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-600">
                    {m.rank ?? '—'}
                  </div>
                  <div className="col-span-3">
                    <Sparkline bars={m.counts} max={max} />
                  </div>
                  <div className="col-span-2 text-right">
                    {products.length === 0 ? (
                      <span className="text-xs text-gray-400">SKU 없음</span>
                    ) : missing === products.length ? (
                      <span className="text-xs font-bold text-orange-600">
                        {missing}/{products.length} (전부 미포함)
                      </span>
                    ) : (
                      <span className="text-xs text-gray-600">
                        {missing}/{products.length}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </section>
        </>
      )}
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

function Sparkline({ bars, max }: { bars: number[]; max: number }) {
  return (
    <div className="flex items-end gap-px h-8" aria-label="추세">
      {bars.map((v, i) => {
        const h = Math.max(1, Math.round((v / max) * 28))
        return (
          <span
            key={i}
            className="w-1.5 bg-gray-300 hover:bg-gray-500"
            style={{ height: `${h}px` }}
            title={`bucket -${bars.length - 1 - i}: ${v}`}
          />
        )
      })}
    </div>
  )
}

const AREA_COLORS = [
  '#2563eb', '#16a34a', '#dc2626', '#ea580c', '#7c3aed', '#0891b2', '#db2777', '#65a30d',
]

function StackedArea({
  modifiers,
  periodCount,
}: {
  modifiers: { modifier: string; counts: number[] }[]
  periodCount: number
}) {
  if (modifiers.length === 0 || periodCount === 0) {
    return <div className="text-xs text-gray-400">데이터 부족</div>
  }
  // 각 시점별 합 (top N 만)
  const totals: number[] = []
  for (let i = 0; i < periodCount; i++) {
    let s = 0
    for (const m of modifiers) s += m.counts[i] ?? 0
    totals.push(s || 1)
  }
  const colHeight = 140
  return (
    <div>
      <div className="flex items-end h-[140px] gap-px">
        {Array.from({ length: periodCount }).map((_, i) => {
          let stacked = 0
          return (
            <div
              key={i}
              className="flex-1 flex flex-col-reverse"
              style={{ height: `${colHeight}px` }}
              title={`bucket -${periodCount - 1 - i}`}
            >
              {modifiers.map((m, mi) => {
                const v = m.counts[i] ?? 0
                const h = Math.round((v / totals[i]) * colHeight)
                stacked += h
                return (
                  <div
                    key={m.modifier}
                    style={{ height: `${h}px`, background: AREA_COLORS[mi % AREA_COLORS.length] }}
                    title={`${m.modifier}: ${v}`}
                  />
                )
              })}
              {stacked === 0 ? <div style={{ height: '1px' }} className="bg-gray-100" /> : null}
            </div>
          )
        })}
      </div>
      <div className="flex flex-wrap gap-2 mt-3 text-xs">
        {modifiers.map((m, i) => (
          <span key={m.modifier} className="inline-flex items-center gap-1">
            <span
              className="inline-block w-3 h-3 rounded-sm"
              style={{ background: AREA_COLORS[i % AREA_COLORS.length] }}
            />
            {m.modifier}
          </span>
        ))}
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
      <p className="text-base font-medium">아직 수식어 수요 데이터가 없습니다</p>
      <p className="text-sm mt-2">
        야간 cron <code className="px-1 bg-gray-100 rounded">scripts/build-modifier-demand.mjs</code> 가
        jimscanner_trends_keywords 의 raw 쿼리에서 수식어를 추출하여 적재합니다.
      </p>
      <p className="text-xs mt-4 text-gray-400">
        수동 실행:{' '}
        <code className="px-1 bg-gray-100 rounded">
          node --env-file=.env.local scripts/build-modifier-demand.mjs --days=30 --period=1
        </code>
      </p>
    </div>
  )
}
