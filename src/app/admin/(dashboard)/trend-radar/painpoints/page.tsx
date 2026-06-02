import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface GgsanMatch {
  goods_no: string
  title: string
  price_krw: number | null
  is_imminent: boolean
  image_url: string | null
  detail_url: string | null
  cate_label: string | null
  term: string
  sim: number
}

interface BoardRow {
  signal_id: string
  keywords: string[] | null
  description: string | null
  category: string | null
  country: string | null
  frequency: number
  first_seen: string
  last_seen: string
  pain_summary: string | null
  solution_terms: string[] | null
  generated_at: string | null
  unmet_score: number
  ggsan_matches: GgsanMatch[] | null
  sourceable: boolean
}

const DAYS_OPTIONS = [
  { v: 14, label: '14일' },
  { v: 30, label: '30일' },
  { v: 60, label: '60일' },
  { v: 90, label: '90일' },
] as const

const SIM_OPTIONS = [
  { v: 0.15, label: '0.15 (느슨)' },
  { v: 0.2, label: '0.20 (기본)' },
  { v: 0.3, label: '0.30 (엄격)' },
] as const

const PER_TERM_LIMIT = 4
const RESULT_LIMIT = 200

async function fetchBoard(opts: { days: number; minSim: number }) {
  const sb = createAdminClient()
  // RPC 는 마이그레이션(supabase/painpoint_solution.sql) 적용 후 존재 → 타입 미생성으로 as any
  const { data, error } = await (sb.rpc as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: BoardRow[] | null; error: { message: string } | null }>)(
    'jimscanner_painpoint_board',
    {
      days_window: opts.days,
      min_sim: opts.minSim,
      per_term_limit: PER_TERM_LIMIT,
      result_limit: RESULT_LIMIT,
    },
  )
  if (error) {
    console.error('painpoint_board rpc error', error)
    return [] as BoardRow[]
  }
  return (data ?? []) as BoardRow[]
}

function buildHref(
  current: Record<string, string>,
  override: Record<string, string | null>,
): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/painpoints' + (qs ? `?${qs}` : '')
}

export default async function PainpointsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; sim?: string; sourceable?: string; solved?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '60', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 60
  const minSim = parseFloat(sp.sim ?? '0.2')
  const validSim = SIM_OPTIONS.some((s) => Math.abs(s.v - minSim) < 0.001) ? minSim : 0.2
  const sourceableOnly = sp.sourceable === '1'
  const solvedOnly = sp.solved === '1'

  const current: Record<string, string> = {
    days: String(validDays),
    sim: String(validSim),
    sourceable: sourceableOnly ? '1' : '',
    solved: solvedOnly ? '1' : '',
  }

  let rows = await fetchBoard({ days: validDays, minSim: validSim })
  const totalPains = rows.length
  const solvedCount = rows.filter((r) => (r.solution_terms?.length ?? 0) > 0).length
  const sourceableCount = rows.filter((r) => r.sourceable).length

  if (solvedOnly) rows = rows.filter((r) => (r.solution_terms?.length ?? 0) > 0)
  if (sourceableOnly) rows = rows.filter((r) => r.sourceable)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🩹 고충 역설계 보드</h1>
          <p className="text-sm text-gray-500 mt-1 max-w-3xl">
            커뮤니티·뉴스에서 추출된 <strong>불편 발화(pain point)</strong>를 LLM 이 후보 상품으로
            역설계 → ggsan 매칭. 이미 뜨는 상품이 아니라, <strong>상품을 모른 채 표출된 수요</strong>를
            잡는 선점 영역. 미해결 강도 = 빈도 × 최신성.
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
          href={buildHref(current, { solved: solvedOnly ? null : '1' })}
          className={`px-3 py-1 text-xs rounded ${solvedOnly ? 'bg-indigo-100 text-indigo-700 font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
        >
          {solvedOnly ? '✓ ' : ''}역설계된 것만
        </Link>
        <Link
          href={buildHref(current, { sourceable: sourceableOnly ? null : '1' })}
          className={`px-3 py-1 text-xs rounded ${sourceableOnly ? 'bg-emerald-100 text-emerald-700 font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
        >
          {sourceableOnly ? '✓ ' : ''}소싱 가능만
        </Link>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="불편 발화" value={totalPains} />
        <Kpi label="역설계 완료" value={solvedCount} />
        <Kpi
          label="🟢 소싱 가능 (ggsan 매칭)"
          value={sourceableCount}
          highlight={sourceableCount > 0}
        />
        <Kpi label="공백 (미매칭)" value={solvedCount - sourceableCount} />
      </section>

      {/* 보드 */}
      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div>조건에 맞는 불편 발화 없음</div>
          <div className="text-xs text-gray-400">
            pain_point 시그널이 수집·역설계되면 표시됩니다. classify-trends-llm 의 painpoint 패스
            누적 권장.
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const solved = (r.solution_terms?.length ?? 0) > 0
            const matches = r.ggsan_matches ?? []
            const daysSince = Math.max(
              0,
              Math.round((Date.now() - new Date(r.last_seen).getTime()) / 86400000),
            )
            return (
              <div
                key={r.signal_id}
                className="rounded border border-gray-200 overflow-hidden grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-gray-100"
              >
                {/* 1열: 불편 발화 */}
                <div className="p-4 bg-gray-50">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs bg-gray-200 text-gray-700 px-2 py-0.5 rounded">
                      불편
                    </span>
                    {r.category && (
                      <span className="text-xs text-gray-500">{r.category}</span>
                    )}
                    {r.country && (
                      <span className="text-xs text-gray-400">{r.country}</span>
                    )}
                  </div>
                  <div className="mt-2 text-sm font-medium leading-snug">
                    {r.pain_summary ?? r.description ?? '(설명 없음)'}
                  </div>
                  {r.description && r.description !== r.pain_summary && (
                    <div className="mt-1 text-xs text-gray-500 line-clamp-3">
                      {r.description}
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1">
                    {(r.keywords ?? []).slice(0, 6).map((k) => (
                      <span
                        key={k}
                        className="text-[11px] bg-white border border-gray-200 text-gray-600 px-1.5 py-0.5 rounded"
                      >
                        {k}
                      </span>
                    ))}
                  </div>
                  <div className="mt-3 text-xs text-gray-500 flex items-center gap-2 flex-wrap">
                    <span title="미해결 강도 = 빈도 × 최신성">
                      미해결강도{' '}
                      <strong className="font-mono text-amber-700">
                        {Number(r.unmet_score).toFixed(2)}
                      </strong>
                    </span>
                    <span>· 빈도 {r.frequency}</span>
                    <span>· {daysSince === 0 ? '오늘' : `${daysSince}일 전`}</span>
                  </div>
                </div>

                {/* 2열: 제안 솔루션 */}
                <div className="p-4">
                  <div className="text-xs text-gray-400 mb-2">제안 솔루션 (역설계)</div>
                  {solved ? (
                    <div className="flex flex-wrap gap-1.5">
                      {r.solution_terms!.map((t) => (
                        <span
                          key={t}
                          className="text-sm bg-indigo-50 border border-indigo-200 text-indigo-700 px-2 py-1 rounded font-medium"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-gray-400 italic">
                      아직 역설계 안 됨 (또는 상품으로 풀 수 없는 불편)
                    </div>
                  )}
                </div>

                {/* 3열: ggsan 매칭 / 공백 */}
                <div className="p-4">
                  <div className="text-xs text-gray-400 mb-2">
                    ggsan 소싱 {matches.length > 0 ? `(${matches.length})` : ''}
                  </div>
                  {matches.length === 0 ? (
                    <div
                      className={`text-xs rounded px-2 py-3 text-center ${solved ? 'bg-orange-50 text-orange-700 border border-orange-200' : 'bg-gray-50 text-gray-400'}`}
                    >
                      {solved ? '🕳️ 도매 공백 — 선점 후보' : '대기'}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {matches
                        .slice()
                        .sort((a, b) => Number(b.sim) - Number(a.sim))
                        .slice(0, 4)
                        .map((m) => (
                          <a
                            key={m.goods_no}
                            href={m.detail_url ?? '#'}
                            target="_blank"
                            rel="noopener"
                            className="flex items-center gap-2 hover:bg-emerald-50 rounded p-1 -m-1 transition-colors"
                          >
                            <div className="w-10 h-10 bg-gray-100 rounded overflow-hidden flex-shrink-0">
                              {m.image_url && (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={m.image_url}
                                  alt=""
                                  className="w-full h-full object-cover"
                                  loading="lazy"
                                />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-xs font-medium leading-tight line-clamp-2">
                                {m.title}
                              </div>
                              <div className="text-[11px] text-gray-400 mt-0.5">
                                {m.price_krw ? `${m.price_krw.toLocaleString()}원` : '가격X'} ·{' '}
                                <span className="font-mono">{m.term}</span> sim{' '}
                                {Number(m.sim).toFixed(2)}
                              </div>
                            </div>
                            {m.is_imminent && (
                              <span className="text-[9px] bg-red-600 text-white px-1 rounded flex-shrink-0">
                                임박
                              </span>
                            )}
                          </a>
                        ))}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div>
          <strong>핵심:</strong> 능동 구매발화가 아닌, 상품을 모른 채 표출된 불편을 LLM 이 상품으로
          번역. 도매 공백(🕳️)은 경쟁이 비어 있는 선점 후보.
        </div>
        <div>
          역설계는 <code>classify-trends-llm.mjs</code> 의 painpoint 패스가 생성 ·
          매칭은 pg_trgm <code>similarity()</code> 기반 ·
          미해결강도는 frequency × 최신성(최근일수록 ↑).
        </div>
      </section>
    </div>
  )
}

function Kpi({
  label,
  value,
  highlight = false,
}: {
  label: string
  value: number | string
  highlight?: boolean
}) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-emerald-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
