import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import Sparkline from './Sparkline'

export const dynamic = 'force-dynamic'

interface TrendRow {
  category_top: string
  day: string
  branded_volume: number
  generic_volume: number
  ratio: number | null
  branded_count: number
  generic_count: number
}

interface KeywordRow {
  keyword: string
  total_volume: number
  hits: number
  last_seen: string
}

interface CategoryCard {
  category_top: string
  points: { day: string; ratio: number | null }[]
  latestRatio: number | null
  earliestRatio: number | null
  slopePerWeek: number | null
  breakpoint: string | null
  totalBranded: number
  totalGeneric: number
}

const CATEGORY_LABEL: Record<string, string> = {
  health: '건강식품',
  living: '생활/리빙',
  digital: '디지털/가전',
  other: '기타',
  unknown: '미분류',
}

const DAYS = 28

// 단순 선형회귀로 (day_index, ratio) 의 기울기 (per day) 계산.
// 주당 변화율(=기울기*7) 으로 환산.
function linearSlopePerWeek(points: { ratio: number | null }[]): number | null {
  const xs: number[] = []
  const ys: number[] = []
  points.forEach((p, i) => {
    if (p.ratio != null && Number.isFinite(p.ratio)) {
      xs.push(i)
      ys.push(p.ratio)
    }
  })
  if (xs.length < 4) return null
  const n = xs.length
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY)
    den += (xs[i] - meanX) ** 2
  }
  if (den === 0) return null
  return (num / den) * 7
}

// breakpoint: 7일 rolling 평균이 최고치였던 날 → 이후 우하향 시작 지점.
function findBreakpoint(points: { day: string; ratio: number | null }[]): string | null {
  if (points.length < 10) return null
  const w = 7
  let bestIdx = -1
  let bestVal = -Infinity
  for (let i = w - 1; i < points.length - 3; i++) {
    let sum = 0
    let cnt = 0
    for (let j = i - w + 1; j <= i; j++) {
      const r = points[j]?.ratio
      if (r != null) {
        sum += r
        cnt++
      }
    }
    if (cnt < Math.ceil(w / 2)) continue
    const avg = sum / cnt
    if (avg > bestVal) {
      bestVal = avg
      bestIdx = i
    }
  }
  if (bestIdx < 0) return null
  // 그 이후 ratio 가 실제로 하락했는지 확인 (윈도우 후반 평균 < 윈도우 평균).
  let postSum = 0
  let postCnt = 0
  for (let j = bestIdx + 1; j < points.length; j++) {
    const r = points[j]?.ratio
    if (r != null) {
      postSum += r
      postCnt++
    }
  }
  if (postCnt === 0) return null
  const postAvg = postSum / postCnt
  if (postAvg >= bestVal) return null
  return points[bestIdx].day
}

function buildCards(rows: TrendRow[]): CategoryCard[] {
  const byCat = new Map<string, TrendRow[]>()
  for (const r of rows) {
    const k = r.category_top || 'unknown'
    if (!byCat.has(k)) byCat.set(k, [])
    byCat.get(k)!.push(r)
  }

  // 각 카테고리에 대해 DAYS 길이의 연속 day 슬롯 채우기
  const today = new Date()
  const days: string[] = []
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(today.getDate() - i)
    days.push(d.toISOString().slice(0, 10))
  }

  const cards: CategoryCard[] = []
  for (const [cat, list] of byCat.entries()) {
    const byDay = new Map<string, TrendRow>()
    for (const r of list) byDay.set(r.day.slice(0, 10), r)
    const points = days.map((day) => {
      const r = byDay.get(day)
      return { day, ratio: r?.ratio != null ? Number(r.ratio) : null }
    })
    const observed = points.filter((p) => p.ratio != null)
    if (observed.length < 4) continue
    const latestRatio = observed[observed.length - 1]?.ratio ?? null
    const earliestRatio = observed[0]?.ratio ?? null
    const slopePerWeek = linearSlopePerWeek(points)
    const breakpoint = findBreakpoint(points)
    const totalBranded = list.reduce((a, r) => a + Number(r.branded_volume || 0), 0)
    const totalGeneric = list.reduce((a, r) => a + Number(r.generic_volume || 0), 0)
    cards.push({
      category_top: cat,
      points,
      latestRatio,
      earliestRatio,
      slopePerWeek,
      breakpoint,
      totalBranded,
      totalGeneric,
    })
  }

  // commoditization 점수: 기울기 음수일수록 + breakpoint 존재할수록 위로.
  cards.sort((a, b) => {
    const score = (c: CategoryCard) =>
      (c.slopePerWeek != null ? -c.slopePerWeek : 0) + (c.breakpoint ? 0.05 : 0)
    return score(b) - score(a)
  })
  return cards
}

async function fetchTrend(): Promise<TrendRow[]> {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_brand_generic_trend' as never, {
    p_category: null,
    p_days: DAYS,
  } as never)
  if (error) return []
  return ((data ?? []) as TrendRow[]).map((r) => ({
    ...r,
    branded_volume: Number(r.branded_volume),
    generic_volume: Number(r.generic_volume),
    ratio: r.ratio != null ? Number(r.ratio) : null,
  }))
}

async function fetchGenericKeywords(category: string): Promise<KeywordRow[]> {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_brand_generic_top_keywords' as never, {
    p_category: category,
    p_kind: 'generic',
    p_days: 14,
    p_limit: 30,
  } as never)
  if (error) return []
  return (data ?? []) as KeywordRow[]
}

async function fetchGgsanMatches(keywords: string[]): Promise<Map<string, number>> {
  if (keywords.length === 0) return new Map()
  const sb = createAdminClient()
  // ggsan 카탈로그에서 키워드 토큰이 name 에 포함된 후보 수 카운트
  const out = new Map<string, number>()
  // 단일 쿼리로 전체를 가져온 뒤 클라이언트에서 매칭 (테이블 작음).
  const { data } = await sb
    .from('jimscanner_ggsan_products')
    .select('title')
    .limit(2000)
  const names = ((data ?? []) as { title: string }[]).map((r) => r.title?.toLowerCase() ?? '')
  for (const kw of keywords) {
    const k = kw.toLowerCase()
    let c = 0
    for (const n of names) if (n.includes(k)) c++
    out.set(kw, c)
  }
  return out
}

function fmtPct(x: number | null): string {
  if (x == null) return '—'
  return `${(x * 100).toFixed(1)}%`
}

function fmtSlope(x: number | null): string {
  if (x == null) return '—'
  const sign = x > 0 ? '+' : ''
  return `${sign}${(x * 100).toFixed(2)}%p / 주`
}

function classifyWindow(slope: number | null, breakpoint: string | null): {
  label: string
  color: string
} {
  if (slope == null) return { label: '관측 부족', color: 'text-gray-400' }
  if (slope < -0.01 && breakpoint) return { label: '진입 윈도우 ★', color: 'text-red-600' }
  if (slope < -0.005) return { label: '이행 감지', color: 'text-orange-600' }
  if (slope > 0.005) return { label: '브랜드 강세', color: 'text-emerald-600' }
  return { label: '정체', color: 'text-gray-500' }
}

interface PageProps {
  searchParams: Promise<{ cat?: string }>
}

export default async function CommoditizationPage({ searchParams }: PageProps) {
  const sp = await searchParams
  const drillCat = sp.cat?.trim() || null

  const rows = await fetchTrend()
  const cards = buildCards(rows)

  let drill: {
    category: string
    keywords: KeywordRow[]
    ggsanCounts: Map<string, number>
  } | null = null
  if (drillCat) {
    const kws = await fetchGenericKeywords(drillCat)
    const ggsanCounts = await fetchGgsanMatches(kws.map((k) => k.keyword))
    drill = { category: drillCat, keywords: kws, ggsanCounts }
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Commoditization 윈도우 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            카테고리별 브랜드:제네릭 검색 볼륨 비율 28일 추세 — 우하향(브랜드 비중 ↓) = 위탁/PB 진입 최적
            윈도우.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {cards.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 text-sm">
          아직 brand_kind 라벨링된 키워드가 없음.
          <br />
          <code className="text-xs">node --env-file=.env.local scripts/classify-trends-llm.mjs</code> 실행
          후 카테고리별 트렌드가 누적되면 카드가 생성됩니다.
        </div>
      ) : (
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {cards.map((c) => {
            const w = classifyWindow(c.slopePerWeek, c.breakpoint)
            return (
              <Link
                key={c.category_top}
                href={`/admin/trend-radar/commoditization?cat=${encodeURIComponent(c.category_top)}`}
                className={`rounded border p-4 hover:bg-gray-50 ${
                  drillCat === c.category_top ? 'border-black' : 'border-gray-200'
                }`}
              >
                <div className="flex items-baseline justify-between mb-1">
                  <h2 className="text-base font-semibold">
                    {CATEGORY_LABEL[c.category_top] ?? c.category_top}
                  </h2>
                  <span className={`text-xs font-medium ${w.color}`}>{w.label}</span>
                </div>
                <div className="text-xs text-gray-500 mb-2">
                  최신 ratio <span className="font-mono text-gray-900">{fmtPct(c.latestRatio)}</span>
                  {' · '}28일 전 <span className="font-mono">{fmtPct(c.earliestRatio)}</span>
                </div>
                <Sparkline points={c.points} />
                <div className="mt-2 flex items-center justify-between text-xs">
                  <span className="text-gray-500">기울기</span>
                  <span className="font-mono">{fmtSlope(c.slopePerWeek)}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500">breakpoint</span>
                  <span className="font-mono">{c.breakpoint ?? '—'}</span>
                </div>
                <div className="mt-2 flex items-center justify-between text-[11px] text-gray-400">
                  <span>
                    branded {Math.round(c.totalBranded)} · generic {Math.round(c.totalGeneric)}
                  </span>
                </div>
              </Link>
            )
          })}
        </section>
      )}

      {drill && (
        <section className="rounded border border-gray-200">
          <header className="border-b border-gray-200 px-4 py-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">
              제네릭 키워드 상위 — {CATEGORY_LABEL[drill.category] ?? drill.category} (14일)
            </h2>
            <Link
              href="/admin/trend-radar/commoditization"
              className="text-xs text-gray-500 hover:text-black underline"
            >
              드릴다운 닫기
            </Link>
          </header>
          {drill.keywords.length === 0 ? (
            <div className="px-4 py-8 text-sm text-gray-500 text-center">
              이 카테고리의 generic 키워드가 14일 내에 없음.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">키워드</th>
                  <th className="px-3 py-2 text-right">볼륨 합</th>
                  <th className="px-3 py-2 text-right">관측</th>
                  <th className="px-3 py-2 text-right">ggsan 매칭</th>
                  <th className="px-3 py-2 text-left">최근 관측</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {drill.keywords.map((k) => {
                  const matches = drill!.ggsanCounts.get(k.keyword) ?? 0
                  return (
                    <tr key={k.keyword}>
                      <td className="px-3 py-1.5 font-medium">{k.keyword}</td>
                      <td className="px-3 py-1.5 text-right font-mono">
                        {Math.round(Number(k.total_volume))}
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-500">{k.hits}</td>
                      <td
                        className={`px-3 py-1.5 text-right font-mono ${
                          matches > 0 ? 'text-emerald-700' : 'text-gray-400'
                        }`}
                      >
                        {matches}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-gray-500 font-mono">
                        {k.last_seen?.slice(5, 16)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>
      )}

      <section className="rounded border border-dashed border-gray-300 p-4 text-xs text-gray-500">
        <strong className="text-gray-700">읽는 법:</strong> ratio = branded_volume / (branded_volume +
        generic_volume). 우하향(기울기 음수) + breakpoint 존재 = 소비자가 특정 브랜드를 떠나 카테고리 자체로
        검색하기 시작한 시점. 이때 동일 needs 를 더 싸게 충족시키는 위탁·PB·중국 직구 셀러가 진입할 최적
        타이밍.
        <br />
        slope 임계값: &lt; -1%p/주 + breakpoint = ★ 진입 윈도우, &lt; -0.5%p/주 = 이행 감지, &gt;
        +0.5%p/주 = 브랜드 강세.
      </section>
    </div>
  )
}
