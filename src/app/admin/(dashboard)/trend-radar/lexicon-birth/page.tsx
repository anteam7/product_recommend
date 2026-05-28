import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface BirthRow {
  token: string
  birth_date: string
  days_since_birth: number
  total_occurrences: number
  source_count: number
  origin_source: string
  first_query: string | null
  daily_counts: number[] | null
  echo_sources: string[] | null
  echo_first_lag_days: number | null
  catalog_match_count: number
}

const BIRTH_WINDOWS = [3, 7, 14] as const
type Win = (typeof BIRTH_WINDOWS)[number]

async function fetchLexiconBirth(birthWindow: Win) {
  const sb = createAdminClient()
  const { data, error } = (await sb.rpc('jimscanner_lexicon_birth' as never, {
    lookback_days: 60,
    birth_window_days: birthWindow,
    min_occurrences: 2,
    result_limit: 200,
  } as never)) as { data: BirthRow[] | null; error: { message?: string } | null }
  return { rows: (data ?? []) as BirthRow[], error }
}

// growth slope: 마지막 3일 평균 / 첫 3일 평균 (NaN-safe)
function accel(daily: number[] | null): number {
  if (!daily || daily.length < 2) return 0
  const head = daily.slice(0, Math.min(3, daily.length))
  const tail = daily.slice(-Math.min(3, daily.length))
  const ha = head.reduce((s, x) => s + x, 0) / head.length
  const ta = tail.reduce((s, x) => s + x, 0) / tail.length
  if (ha <= 0) return ta > 0 ? ta : 0
  return ta / ha
}

function Sparkline({ bars }: { bars: number[] }) {
  if (bars.length === 0) return <span className="text-xs text-gray-400">—</span>
  const max = Math.max(1, ...bars)
  const w = 80
  const h = 22
  const step = bars.length > 1 ? w / (bars.length - 1) : 0
  const pts = bars
    .map((v, i) => `${(i * step).toFixed(2)},${(h - (v / max) * h).toFixed(2)}`)
    .join(' ')
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline fill="none" stroke="#111" strokeWidth="1.4" points={pts} />
      {bars.map((v, i) => (
        <circle
          key={i}
          cx={(i * step).toFixed(2)}
          cy={(h - (v / max) * h).toFixed(2)}
          r={1.6}
          fill="#111"
        />
      ))}
    </svg>
  )
}

// echo lag 박스플롯 (min, q1, median, q3, max)
function LagBoxplot({ values }: { values: number[] }) {
  if (values.length === 0) {
    return <div className="text-xs text-gray-400">echo lag 샘플 없음</div>
  }
  const sorted = [...values].sort((a, b) => a - b)
  const q = (p: number) => {
    const idx = (sorted.length - 1) * p
    const lo = Math.floor(idx)
    const hi = Math.ceil(idx)
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
  }
  const min = sorted[0]
  const max = sorted[sorted.length - 1]
  const q1 = q(0.25)
  const med = q(0.5)
  const q3 = q(0.75)
  const w = 480
  const h = 60
  const padX = 24
  const span = Math.max(1, max - min)
  const scale = (v: number) => padX + ((v - min) / span) * (w - padX * 2)
  const mid = h / 2
  return (
    <div className="space-y-1">
      <svg width={w} height={h} className="overflow-visible">
        <line x1={scale(min)} y1={mid} x2={scale(max)} y2={mid} stroke="#9ca3af" strokeWidth="1" />
        <rect
          x={scale(q1)}
          y={mid - 10}
          width={Math.max(2, scale(q3) - scale(q1))}
          height={20}
          fill="#e5e7eb"
          stroke="#6b7280"
        />
        <line x1={scale(med)} y1={mid - 10} x2={scale(med)} y2={mid + 10} stroke="#111" strokeWidth="2" />
        <line x1={scale(min)} y1={mid - 6} x2={scale(min)} y2={mid + 6} stroke="#6b7280" strokeWidth="1" />
        <line x1={scale(max)} y1={mid - 6} x2={scale(max)} y2={mid + 6} stroke="#6b7280" strokeWidth="1" />
        <text x={scale(min)} y={mid + 22} fontSize="10" textAnchor="middle" fill="#6b7280">
          {min.toFixed(0)}d
        </text>
        <text x={scale(med)} y={mid + 22} fontSize="10" textAnchor="middle" fill="#111">
          med {med.toFixed(1)}d
        </text>
        <text x={scale(max)} y={mid + 22} fontSize="10" textAnchor="middle" fill="#6b7280">
          {max.toFixed(0)}d
        </text>
      </svg>
      <div className="text-xs text-gray-500">
        n={values.length} · q1 {q1.toFixed(1)}d · q3 {q3.toFixed(1)}d
      </div>
    </div>
  )
}

export default async function LexiconBirthPage({
  searchParams,
}: {
  searchParams: Promise<{ win?: string; shop?: string }>
}) {
  const sp = await searchParams
  const winRaw = Number(sp.win)
  const birthWindow: Win = (BIRTH_WINDOWS as readonly number[]).includes(winRaw)
    ? (winRaw as Win)
    : 7
  const shoppableOnly = sp.shop === '1'

  const { rows, error } = await fetchLexiconBirth(birthWindow)

  const visible = shoppableOnly ? rows.filter((r) => r.catalog_match_count === 0) : rows
  const sorted = [...visible].sort((a, b) => {
    const acc = accel(b.daily_counts) - accel(a.daily_counts)
    if (acc !== 0) return acc
    return b.total_occurrences - a.total_occurrences
  })

  const echoLags = rows
    .map((r) => r.echo_first_lag_days)
    .filter((v): v is number => typeof v === 'number' && v >= 0)

  const kpis = {
    newborns: rows.length,
    accelerating: rows.filter((r) => accel(r.daily_counts) >= 2).length,
    echoed: rows.filter((r) => (r.echo_sources?.length ?? 0) > 0).length,
    catalogGap: rows.filter((r) => r.catalog_match_count === 0).length,
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">🐣 신생어 출생 레이더</h1>
          <p className="text-sm text-gray-500 mt-1">
            과거 60일 history 에 없던 토큰이 지난 {birthWindow}일 안에 google 자동완성에서 처음 태어났다 ·
            카탈로그 0건 = ggsan whitespace 후보
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 호출 실패: {error.message ?? 'unknown error'}
          <div className="text-xs text-red-700 mt-1">
            supabase/trend_lexicon_birth.sql 을 DB 에 아직 적용하지 않았다면 먼저 마이그레이션 필요.
          </div>
        </div>
      )}

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="신생어 (newborn)" value={kpis.newborns} hint={`지난 ${birthWindow}일`} />
        <KpiCard label="가속 중 (×2 이상)" value={kpis.accelerating} hint="첫 3일 → 최근 3일" />
        <KpiCard label="타 소스 echo" value={kpis.echoed} hint="blog/news/quasarzone 등" />
        <KpiCard label="카탈로그 0건" value={kpis.catalogGap} hint="ggsan whitespace" />
      </section>

      <nav className="flex gap-2 border-b border-gray-200 items-baseline">
        {BIRTH_WINDOWS.map((w) => (
          <Link
            key={w}
            href={`/admin/trend-radar/lexicon-birth?win=${w}${shoppableOnly ? '&shop=1' : ''}`}
            className={`px-3 py-2 text-sm ${
              birthWindow === w
                ? 'border-b-2 border-black font-semibold text-black'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            지난 {w}일
          </Link>
        ))}
        <div className="ml-auto">
          <Link
            href={`/admin/trend-radar/lexicon-birth?win=${birthWindow}${shoppableOnly ? '' : '&shop=1'}`}
            className={`px-3 py-1 text-xs rounded border ${
              shoppableOnly
                ? 'bg-black text-white border-black'
                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
            }`}
          >
            🛒 카탈로그 0건만
          </Link>
        </div>
      </nav>

      {/* echo lag 박스플롯 */}
      <section className="rounded border border-gray-200 p-4 bg-gray-50/50">
        <div className="text-sm font-semibold mb-2">
          📦 자동완성 → 타 소스 echo 지연 (일)
        </div>
        <p className="text-xs text-gray-500 mb-3">
          신생어가 google 자동완성에서 태어난 뒤 blog / news / quasarzone 등에 며칠 후 도달하는지.
          좌측에 가까울수록 자동완성이 진짜 leading 지표.
        </p>
        <LagBoxplot values={echoLags} />
      </section>

      {/* 신생어 카드 */}
      {sorted.length === 0 ? (
        <EmptyState />
      ) : (
        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {sorted.map((r) => {
            const a = accel(r.daily_counts)
            const echoList = r.echo_sources ?? []
            return (
              <div
                key={r.token}
                className="rounded border border-gray-200 p-4 hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="font-semibold text-base break-all">{r.token}</div>
                  <div className="text-xs text-gray-500 whitespace-nowrap">
                    {r.birth_date} · {r.days_since_birth}일째
                  </div>
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  최초 query: <span className="font-mono">{r.first_query ?? '—'}</span>
                </div>

                <div className="mt-3 flex items-center gap-3">
                  <Sparkline bars={r.daily_counts ?? []} />
                  <div className="text-xs">
                    <div>
                      <span className="text-gray-500">총</span>{' '}
                      <span className="font-mono font-semibold">{r.total_occurrences}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">가속</span>{' '}
                      <span className={`font-mono font-semibold ${a >= 2 ? 'text-red-700' : 'text-gray-700'}`}>
                        ×{a.toFixed(1)}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-1 text-xs">
                  {echoList.length === 0 ? (
                    <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
                      echo 없음 (자동완성 단독)
                    </span>
                  ) : (
                    <>
                      {echoList.slice(0, 4).map((s) => (
                        <span key={s} className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">
                          {s}
                        </span>
                      ))}
                      {r.echo_first_lag_days !== null && (
                        <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
                          +{r.echo_first_lag_days}d lag
                        </span>
                      )}
                    </>
                  )}
                  <span
                    className={`px-1.5 py-0.5 rounded ${
                      r.catalog_match_count === 0
                        ? 'bg-green-50 text-green-700'
                        : 'bg-gray-100 text-gray-600'
                    }`}
                    title="ggsan 카탈로그 title ILIKE 매치 수"
                  >
                    🛒 카탈로그 {r.catalog_match_count}건
                  </span>
                </div>
              </div>
            )
          })}
        </section>
      )}

      <footer className="text-xs text-gray-400 border-t border-gray-200 pt-3">
        데이터: jimscanner_market_raw · 60일 lookback · 매일 KST 04:10 google_suggest cron 후 갱신.
      </footer>
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
      <p className="text-base font-medium">아직 신생어 없음</p>
      <p className="text-sm mt-2">
        google_suggest 누적이 충분하지 않거나 (lookback 60일 미달) 지난 윈도우 안에 set-diff 결과가 비었습니다.
      </p>
      <p className="text-xs mt-4 text-gray-400">
        DB 마이그레이션 미적용 시: <code className="px-1 bg-gray-100 rounded">supabase/trend_lexicon_birth.sql</code>
      </p>
    </div>
  )
}
