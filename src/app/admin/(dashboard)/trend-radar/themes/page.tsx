import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import ThemeNetwork from './ThemeNetwork'

export const dynamic = 'force-dynamic'

// ── 타입 ──────────────────────────────────────────────
interface ComovePair {
  keyword_a: string
  keyword_b: string
  corr_val: number | null
  overlap_n: number
  method: string
}
interface Momentum {
  keyword: string
  category_top: string | null
  n_obs: number
  avg_vol: number | null
  last_vol: number | null
  slope_per_day: number | null
  last_seen: string
}
interface Theme {
  id: number
  keywords: string[]
  edges: { a: string; b: string; w: number }[]
  momentum: number // 구성원 평균 일일 상승 기울기
  avgStrength: number // 평균 동조 강도
  category: string | null
  method: string
  ggsanHits: string[] // ggsan supplier 보유 키워드
  ggsanGaps: string[] // 소싱 공백 키워드
}

const DAYS_WINDOW = 56
const MIN_CORR = 0.5

// ── 데이터 ────────────────────────────────────────────
async function fetchThemes(): Promise<{
  themes: Theme[]
  pairCount: number
  method: string
  kwCount: number
}> {
  // 신규 RPC 는 generated types 에 아직 없어 any 캐스팅 (마이그레이션 후 상태 가정)
  const sb = createAdminClient() as any

  // 1) 코무브먼트 페어 — Pearson 우선, 데이터 부족 시 co-occurrence fallback
  let method = 'pearson'
  let pairs: ComovePair[] = []
  {
    const { data } = await sb.rpc('jimscanner_trends_comovement', {
      days_window: DAYS_WINDOW,
      min_overlap: 4,
      min_corr: MIN_CORR,
      source_filter: null,
      result_limit: 600,
      use_cooccurrence: false,
    } as any)
    pairs = (data ?? []) as ComovePair[]
  }
  if (pairs.length === 0) {
    method = 'cooccurrence'
    const { data } = await sb.rpc('jimscanner_trends_comovement', {
      days_window: DAYS_WINDOW,
      min_overlap: 3,
      min_corr: 0,
      source_filter: null,
      result_limit: 600,
      use_cooccurrence: true,
    } as any)
    pairs = (data ?? []) as ComovePair[]
  }

  if (pairs.length === 0) {
    return { themes: [], pairCount: 0, method, kwCount: 0 }
  }

  // co-occurrence 강도 정규화 (overlap_n → 0~1)
  const maxOverlap = Math.max(...pairs.map((p) => p.overlap_n), 1)
  const edgeWeight = (p: ComovePair) =>
    method === 'pearson' ? (p.corr_val ?? 0) : p.overlap_n / maxOverlap

  // 2) 모멘텀 (기울기)
  const { data: momData } = await sb.rpc('jimscanner_trends_keyword_momentum', {
    days_window: DAYS_WINDOW,
    source_filter: null,
  } as any)
  const momByKw = new Map<string, Momentum>(
    ((momData ?? []) as Momentum[]).map((m) => [m.keyword, m]),
  )

  // 3) 연결요소(connected components) 클러스터링 ── 양(+) 동조 그래프
  const adj = new Map<string, Map<string, number>>()
  const addEdge = (a: string, b: string, w: number) => {
    if (!adj.has(a)) adj.set(a, new Map())
    if (!adj.has(b)) adj.set(b, new Map())
    adj.get(a)!.set(b, w)
    adj.get(b)!.set(a, w)
  }
  for (const p of pairs) addEdge(p.keyword_a, p.keyword_b, edgeWeight(p))

  const visited = new Set<string>()
  const clusters: string[][] = []
  for (const start of adj.keys()) {
    if (visited.has(start)) continue
    const comp: string[] = []
    const queue = [start]
    visited.add(start)
    while (queue.length) {
      const cur = queue.shift()!
      comp.push(cur)
      for (const nb of adj.get(cur)!.keys()) {
        if (!visited.has(nb)) {
          visited.add(nb)
          queue.push(nb)
        }
      }
    }
    if (comp.length >= 2) clusters.push(comp)
  }

  // 4) ggsan 소싱 커버리지 — 테마 키워드 ↔ ggsan 상품명 ilike 매칭
  const allKw = [...new Set(clusters.flat())]
  const ggsanHitSet = new Set<string>()
  if (allKw.length > 0) {
    // 키워드별 ilike OR — 보유 여부만 확인 (제목 일부 포함)
    const orExpr = allKw
      .slice(0, 120)
      .map((kw) => `title.ilike.%${kw.replace(/[%,()]/g, ' ')}%`)
      .join(',')
    const { data: ggsan } = await sb
      .from('jimscanner_ggsan_products')
      .select('title')
      .or(orExpr)
      .limit(2000)
    const titles = ((ggsan ?? []) as { title: string }[]).map((g) => g.title ?? '')
    for (const kw of allKw) {
      if (titles.some((t) => t.includes(kw))) ggsanHitSet.add(kw)
    }
  }

  // 5) 테마 빌드
  const themes: Theme[] = clusters.map((kws, idx) => {
    const edges: { a: string; b: string; w: number }[] = []
    const seen = new Set<string>()
    for (const a of kws) {
      const nbrs = adj.get(a)
      if (!nbrs) continue
      for (const [b, w] of nbrs) {
        const key = a < b ? `${a}|${b}` : `${b}|${a}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({ a, b, w })
      }
    }
    const slopes = kws
      .map((k) => momByKw.get(k)?.slope_per_day)
      .filter((s): s is number => typeof s === 'number' && isFinite(s))
    const momentum = slopes.length ? slopes.reduce((a, b) => a + b, 0) / slopes.length : 0
    const avgStrength = edges.length
      ? edges.reduce((a, e) => a + e.w, 0) / edges.length
      : 0
    // 대표 카테고리 (최빈)
    const catCount = new Map<string, number>()
    for (const k of kws) {
      const c = momByKw.get(k)?.category_top
      if (c) catCount.set(c, (catCount.get(c) ?? 0) + 1)
    }
    const category =
      [...catCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    const ggsanHits = kws.filter((k) => ggsanHitSet.has(k))
    const ggsanGaps = kws.filter((k) => !ggsanHitSet.has(k))

    return {
      id: idx,
      keywords: kws,
      edges,
      momentum,
      avgStrength,
      category,
      method,
      ggsanHits,
      ggsanGaps,
    }
  })

  // 모멘텀(상승기울기) 높은 순 → 동조 강도 순
  themes.sort((a, b) => b.momentum - a.momentum || b.avgStrength - a.avgStrength)

  return { themes, pairCount: pairs.length, method, kwCount: allKw.length }
}

// ── 페이지 ────────────────────────────────────────────
export default async function ThemesPage() {
  const { themes, pairCount, method, kwCount } = await fetchThemes()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">수요 동조 테마</h1>
          <p className="text-sm text-gray-500 mt-1">
            함께 오르내리는 키워드 묶음 = 테마 · 단품이 아닌 어소트먼트 단위 신호
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 요약 */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Kpi label="테마 수" value={themes.length} hint="연결요소 ≥2" />
        <Kpi label="동조 페어" value={pairCount} hint={method === 'pearson' ? '주별 Pearson' : '동시출현 fallback'} />
        <Kpi label="구성 키워드" value={kwCount} hint="클러스터 합산" />
        <Kpi
          label="소싱 보유"
          value={themes.reduce((a, t) => a + t.ggsanHits.length, 0)}
          hint="ggsan 매칭"
        />
      </section>

      {method === 'cooccurrence' && themes.length > 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          ⚠️ 시계열 누적이 부족해 <b>같은 날 동시출현 빈도</b> 기반 fallback 으로 묶었습니다.
          몇 주 더 누적되면 Pearson 상호상관으로 자동 전환됩니다.
        </div>
      )}

      {themes.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {themes.map((t) => (
            <ThemeCard key={t.id} t={t} />
          ))}
        </div>
      )}
    </div>
  )
}

function ThemeCard({ t }: { t: Theme }) {
  const momentumUp = t.momentum > 0
  return (
    <div className="rounded border border-gray-200 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">
              {t.keywords.slice(0, 3).join(' · ')}
              {t.keywords.length > 3 && (
                <span className="text-gray-400 font-normal"> +{t.keywords.length - 3}</span>
              )}
            </h3>
            {t.category && (
              <span className="text-xs rounded bg-gray-100 px-1.5 py-0.5 text-gray-600">
                {t.category}
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {t.keywords.length}개 키워드 · 동조 강도 {(t.avgStrength * 100).toFixed(0)}%
          </div>
        </div>
        <div className="text-right shrink-0">
          <div
            className={`text-lg font-bold font-mono ${momentumUp ? 'text-emerald-600' : 'text-gray-400'}`}
          >
            {momentumUp ? '▲' : '—'} {t.momentum.toFixed(2)}
          </div>
          <div className="text-[10px] text-gray-400">모멘텀 /일</div>
        </div>
      </div>

      {/* 동조 강도 네트워크 그래프 */}
      <div className="flex justify-center">
        <ThemeNetwork nodes={t.keywords} edges={t.edges} size={t.keywords.length > 6 ? 280 : 220} />
      </div>

      {/* 구성 키워드 */}
      <div className="flex flex-wrap gap-1">
        {t.keywords.map((kw) => {
          const has = t.ggsanHits.includes(kw)
          return (
            <span
              key={kw}
              className={`text-xs rounded px-1.5 py-0.5 border ${
                has
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                  : 'border-gray-200 bg-gray-50 text-gray-500'
              }`}
              title={has ? 'ggsan 소싱 보유' : '소싱 공백'}
            >
              {has ? '✓ ' : ''}
              {kw}
            </span>
          )
        })}
      </div>

      {/* 소싱 커버리지 */}
      <div className="flex items-center justify-between text-xs border-t border-gray-100 pt-2">
        <span className="text-emerald-700">
          소싱 보유 {t.ggsanHits.length}
        </span>
        <span className={t.ggsanGaps.length > 0 ? 'text-amber-700' : 'text-gray-400'}>
          소싱 공백 {t.ggsanGaps.length}
        </span>
        <Link
          href={`/admin/trend-radar/tv-ggsan-match`}
          className="text-gray-500 hover:text-black underline"
        >
          ggsan 매칭 →
        </Link>
      </div>
    </div>
  )
}

function Kpi({ label, value, hint }: { label: string; value: number; hint: string }) {
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
      <p className="text-base font-medium">아직 동조 테마가 없습니다</p>
      <p className="text-sm mt-2">
        키워드 시계열이 충분히 누적되면(주별 4버킷 이상) 함께 뜨는 키워드 묶음이
        자동으로 테마로 묶입니다.
        <br />
        naver_tvtime(일 2회)·shopping_insight·search_trend 가 매일 쌓이는 중입니다.
      </p>
    </div>
  )
}
