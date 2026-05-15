import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface MatchRow {
  keyword: string
  tv_count: number
  tv_first_seen: string
  tv_last_seen: string
  goods_no: string
  ggsan_title: string
  price_krw: number | null
  is_imminent: boolean
  cate_cd: string | null
  cate_label: string | null
  image_url: string | null
  detail_url: string | null
  ggsan_last_seen: string
  sim: number
}

const SIM_OPTIONS = [
  { v: 0.1,  label: '0.10 (느슨)' },
  { v: 0.15, label: '0.15' },
  { v: 0.2,  label: '0.20 (기본)' },
  { v: 0.3,  label: '0.30' },
  { v: 0.4,  label: '0.40 (엄격)' },
] as const

const DAYS_OPTIONS = [
  { v: 7,  label: '7일' },
  { v: 14, label: '14일' },
  { v: 30, label: '30일' },
  { v: 60, label: '60일' },
] as const

const PER_KW_LIMIT = 3
const RESULT_LIMIT = 500

async function fetchMatches(opts: { days: number; minSim: number; imminentOnly: boolean }) {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_tv_ggsan_match', {
    days_window: opts.days,
    min_sim: opts.minSim,
    per_keyword_limit: PER_KW_LIMIT,
    result_limit: RESULT_LIMIT,
  })
  if (error) {
    console.error('rpc error', error)
    return [] as MatchRow[]
  }
  let rows = (data ?? []) as MatchRow[]
  if (opts.imminentOnly) rows = rows.filter((r) => r.is_imminent)
  return rows
}

async function fetchLiftMap(): Promise<Map<string, number>> {
  const sb = createAdminClient()
  // RPC 미반영 — supabase/trends_v4_tv_lift.sql 적용 후 캐스팅 제거
  const { data, error } = await sb.rpc('jimscanner_tv_lift' as never, {
    window_days: 7,
    min_tv_count: 1,
    result_limit: 1000,
  } as never)
  if (error || !data) return new Map()
  const map = new Map<string, number>()
  for (const r of data as { keyword: string; lift: number | null }[]) {
    if (r.lift != null) map.set(r.keyword, Number(r.lift))
  }
  return map
}

interface Group {
  keyword: string
  tv_count: number
  tv_first_seen: string
  tv_last_seen: string
  matches: MatchRow[]
  bestSim: number
  hasImminent: boolean
}

function groupByKeyword(rows: MatchRow[]): Group[] {
  const map = new Map<string, Group>()
  for (const r of rows) {
    let g = map.get(r.keyword)
    if (!g) {
      g = {
        keyword: r.keyword,
        tv_count: r.tv_count,
        tv_first_seen: r.tv_first_seen,
        tv_last_seen: r.tv_last_seen,
        matches: [],
        bestSim: 0,
        hasImminent: false,
      }
      map.set(r.keyword, g)
    }
    g.matches.push(r)
    if (r.sim > g.bestSim) g.bestSim = r.sim
    if (r.is_imminent) g.hasImminent = true
  }
  return [...map.values()].sort((a, b) => {
    if (a.hasImminent !== b.hasImminent) return a.hasImminent ? -1 : 1
    if (a.tv_count !== b.tv_count) return b.tv_count - a.tv_count
    return b.bestSim - a.bestSim
  })
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/tv-ggsan-match' + (qs ? `?${qs}` : '')
}

export default async function TvGgsanMatchPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; sim?: string; imminent?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '30', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 30
  const minSim = parseFloat(sp.sim ?? '0.2')
  const validSim = SIM_OPTIONS.some((s) => Math.abs(s.v - minSim) < 0.001) ? minSim : 0.2
  const imminentOnly = sp.imminent === '1'

  const current: Record<string, string> = {
    days: String(validDays),
    sim: String(validSim),
    imminent: imminentOnly ? '1' : '',
  }

  const [rows, liftMap] = await Promise.all([
    fetchMatches({ days: validDays, minSim: validSim, imminentOnly }),
    fetchLiftMap(),
  ])
  const groups = groupByKeyword(rows)

  const totalMatches = rows.length
  const uniqueKeywords = groups.length
  const imminentCount = rows.filter((r) => r.is_imminent).length
  const avgSim =
    rows.length > 0 ? rows.reduce((s, r) => s + Number(r.sim), 0) / rows.length : 0

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">TV 편성 ↔ ggsan 매칭</h1>
          <p className="text-sm text-gray-500 mt-1">
            홈쇼핑 9사가 push 하는 상품 중 ggsan 도매몰에 있는 후보. <strong>임박특가 우선</strong> · pg_trgm similarity
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-4 rounded border border-gray-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">기간</span>
          {DAYS_OPTIONS.map((d) => (
            <Link
              key={d.v}
              href={buildHref(current, { days: String(d.v) })}
              className={`px-2 py-1 text-xs rounded ${validDays === d.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {d.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">유사도 ≥</span>
          {SIM_OPTIONS.map((s) => (
            <Link
              key={s.v}
              href={buildHref(current, { sim: String(s.v) })}
              className={`px-2 py-1 text-xs rounded ${Math.abs(validSim - s.v) < 0.001 ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {s.label}
            </Link>
          ))}
        </div>
        <Link
          href={buildHref(current, { imminent: imminentOnly ? null : '1' })}
          className={`px-3 py-1 text-xs rounded ${imminentOnly ? 'bg-red-100 text-red-700 font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
        >
          {imminentOnly ? '✓ ' : ''}임박특가만
        </Link>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="매칭 row" value={totalMatches} />
        <Kpi label="unique TV 키워드" value={uniqueKeywords} />
        <Kpi label="🔥 임박특가 매칭" value={imminentCount} highlight={imminentCount > 0} />
        <Kpi label="평균 유사도" value={avgSim.toFixed(3)} />
      </section>

      {/* 결과 — TV 키워드별 그룹 */}
      {groups.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div>조건에 맞는 매칭 없음</div>
          <div className="text-xs text-gray-400">
            데이터 누적이 적으면 결과가 적습니다. 30일 누적 권장.
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.keyword} className="rounded border border-gray-200 overflow-hidden">
              {/* TV 키워드 헤더 */}
              <div className={`px-4 py-3 flex items-center justify-between flex-wrap gap-2 ${g.hasImminent ? 'bg-red-50' : 'bg-gray-50'}`}>
                <div className="flex items-baseline gap-3 flex-wrap">
                  <h3 className="font-semibold text-base">📺 {g.keyword}</h3>
                  <span className="text-xs text-gray-600">
                    편성 <strong className="font-mono">{g.tv_count}</strong>회
                    · {g.tv_first_seen.slice(5, 10)}~{g.tv_last_seen.slice(5, 10)}
                  </span>
                  {g.hasImminent && (
                    <span className="text-xs bg-red-600 text-white px-2 py-0.5 rounded">
                      🔥 임박특가 매칭
                    </span>
                  )}
                  {liftMap.get(g.keyword) != null && (liftMap.get(g.keyword) as number) > 1.1 && (
                    <span
                      className={`text-xs px-2 py-0.5 rounded ${
                        (liftMap.get(g.keyword) as number) >= 2
                          ? 'bg-red-100 text-red-700 font-semibold'
                          : (liftMap.get(g.keyword) as number) >= 1.5
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-green-100 text-green-700'
                      }`}
                      title="첫 편성 ±7일 검색량 lift"
                    >
                      📈 lift ×{(liftMap.get(g.keyword) as number).toFixed(1)}
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-500">
                  ggsan {g.matches.length} 매칭 · best sim {g.bestSim.toFixed(3)}
                </div>
              </div>

              {/* ggsan 후보들 */}
              <div className="divide-y divide-gray-100">
                {g.matches
                  .sort((a, b) => {
                    if (a.is_imminent !== b.is_imminent) return a.is_imminent ? -1 : 1
                    return b.sim - a.sim
                  })
                  .map((m) => (
                    <a
                      key={m.goods_no}
                      href={m.detail_url ?? '#'}
                      target="_blank"
                      rel="noopener"
                      className="flex items-start gap-3 px-4 py-3 hover:bg-amber-50 transition-colors"
                    >
                      <div className="w-16 h-16 bg-gray-100 rounded overflow-hidden flex-shrink-0 relative">
                        {m.image_url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={m.image_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                        )}
                        {m.is_imminent && (
                          <span className="absolute top-0 left-0 bg-red-600 text-white text-[9px] px-1 leading-tight rounded-br">
                            임박
                          </span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium leading-snug line-clamp-2" title={m.ggsan_title}>
                          {m.ggsan_title}
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                          {m.cate_label ?? m.cate_cd} · {m.goods_no}
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="text-base font-bold">
                          {m.price_krw ? `${m.price_krw.toLocaleString()}원` : <span className="text-gray-400 text-xs">가격 X</span>}
                        </div>
                        <div className="text-xs font-mono text-gray-400 mt-1">
                          sim {Number(m.sim).toFixed(3)}
                        </div>
                      </div>
                    </a>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div>매칭 = pg_trgm <code>similarity()</code> 기반 fuzzy 비교 (오타·어순 무관 부분 일치).</div>
        <div>
          <strong>의사결정 단서:</strong>{' '}
          (1) TV 9사 통합 편성 빈도가 높을수록 시장 push 가 강함 ·
          (2) 임박특가 매칭은 ggsan 도매가가 평소보다 낮을 가능성 ·
          (3) 같은 키워드에 여러 ggsan 후보가 잡히면 가격·브랜드 비교 후 선정.
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-red-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
