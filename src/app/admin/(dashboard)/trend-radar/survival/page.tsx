import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface KmRow {
  category_key: string
  category_top: string
  category_mid: string | null
  n_total: number
  n_events: number
  week: number
  at_risk: number
  events: number
  censored: number
  survival: number
  survival_lower: number
  survival_upper: number
  median_week: number | null
}

interface ActivePin {
  id: string
  canonical_name: string
  category_top: string
  entered_at: string
  age_weeks: number
}

async function fetchKm(groupByMid: boolean) {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_category_km_curve' as never, {
    group_by_mid: groupByMid,
    min_n: 3,
    max_week: 26,
  } as never)
  if (error) {
    return { rows: [] as KmRow[], err: error.message }
  }
  return { rows: ((data ?? []) as unknown) as KmRow[], err: null }
}

async function fetchActivePins(): Promise<ActivePin[]> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('jimscanner_trends_survival_events' as never)
    .select('product_id, canonical_name, category_top, entered_at, censored, duration_weeks')
    .eq('censored', true)
    .order('duration_weeks', { ascending: false })
    .limit(20)
  type Row = {
    product_id: string
    canonical_name: string
    category_top: string
    entered_at: string
    duration_weeks: number
  }
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.product_id,
    canonical_name: r.canonical_name,
    category_top: r.category_top,
    entered_at: r.entered_at,
    age_weeks: r.duration_weeks,
  }))
}

const PALETTE = [
  '#2563eb',
  '#dc2626',
  '#16a34a',
  '#ea580c',
  '#9333ea',
  '#0891b2',
  '#ca8a04',
  '#db2777',
]

export default async function SurvivalPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>
}) {
  const sp = await searchParams
  const groupByMid = sp.mode === 'mid'

  const [{ rows, err }, activePins] = await Promise.all([fetchKm(groupByMid), fetchActivePins()])

  // group rows by category_key
  const byCat = new Map<string, KmRow[]>()
  for (const r of rows) {
    if (!byCat.has(r.category_key)) byCat.set(r.category_key, [])
    byCat.get(r.category_key)!.push(r)
  }
  const categories = [...byCat.entries()]
    .map(([key, ks]) => ({
      key,
      rows: ks.sort((a, b) => a.week - b.week),
      n_total: ks[0]?.n_total ?? 0,
      n_events: ks[0]?.n_events ?? 0,
      median: ks[0]?.median_week ?? null,
    }))
    .sort((a, b) => b.n_total - a.n_total)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <Link href="/admin/trend-radar" className="text-sm text-gray-500 hover:text-black">
            ← 대시보드
          </Link>
          <h1 className="text-2xl font-bold mt-1">트렌드 생존곡선 (Kaplan-Meier)</h1>
          <p className="text-sm text-gray-500 mt-1">
            카테고리별 진입(final_score≥50) → 이탈(score&lt;35) 생존 분석. 우측 절단(아직 살아있는
            트렌드)는 KM 정의대로 처리.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/admin/trend-radar/survival?mode=top"
            className={`text-xs px-3 py-1.5 rounded border ${
              !groupByMid
                ? 'border-black bg-black text-white'
                : 'border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            top 카테고리
          </Link>
          <Link
            href="/admin/trend-radar/survival?mode=mid"
            className={`text-xs px-3 py-1.5 rounded border ${
              groupByMid
                ? 'border-black bg-black text-white'
                : 'border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            top / mid 분할
          </Link>
        </div>
      </header>

      {err && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          KM RPC 호출 실패: <code className="font-mono">{err}</code>
          <p className="mt-1 text-xs">
            <code>supabase/trends_survival.sql</code> 마이그레이션이 아직 적용되지 않았을 수 있습니다.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 좌측: 카테고리별 KM 곡선 */}
        <section className="lg:col-span-2 space-y-4">
          {categories.length === 0 ? (
            <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
              <p className="text-base font-medium">아직 충분한 KM 데이터가 없습니다</p>
              <p className="text-sm mt-2">
                category 당 최소 3개 product 의 진입 이벤트가 필요합니다.
              </p>
            </div>
          ) : (
            <>
              <h2 className="text-sm font-semibold text-gray-700">
                카테고리별 KM 곡선 ({categories.length}개)
              </h2>
              <div className="rounded border border-gray-200 p-4">
                <KmSvg categories={categories} />
                <div className="flex flex-wrap gap-3 mt-3">
                  {categories.map((c, i) => (
                    <div key={c.key} className="flex items-center gap-1.5 text-xs">
                      <span
                        className="inline-block w-3 h-3 rounded-sm"
                        style={{ backgroundColor: PALETTE[i % PALETTE.length] }}
                      />
                      <span className="font-medium">{c.key}</span>
                      <span className="text-gray-500">
                        n={c.n_total} · 이탈 {c.n_events} · median{' '}
                        {c.median !== null ? `${c.median}w` : '—'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded border border-gray-200 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-gray-500">
                    <tr>
                      <th className="px-3 py-2 text-left">category</th>
                      <th className="px-3 py-2 text-right">n</th>
                      <th className="px-3 py-2 text-right">이탈</th>
                      <th className="px-3 py-2 text-right">median (주)</th>
                      <th className="px-3 py-2 text-right">S(1w)</th>
                      <th className="px-3 py-2 text-right">S(4w)</th>
                      <th className="px-3 py-2 text-right">S(8w)</th>
                      <th className="px-3 py-2 text-right">S(13w)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {categories.map((c) => {
                      const sAt = (w: number) =>
                        c.rows.find((r) => r.week === w)?.survival ?? null
                      return (
                        <tr key={c.key}>
                          <td className="px-3 py-1.5 font-medium">{c.key}</td>
                          <td className="px-3 py-1.5 text-right">{c.n_total}</td>
                          <td className="px-3 py-1.5 text-right text-gray-600">{c.n_events}</td>
                          <td className="px-3 py-1.5 text-right font-bold">
                            {c.median ?? '—'}
                          </td>
                          {[1, 4, 8, 13].map((w) => {
                            const s = sAt(w)
                            return (
                              <td key={w} className="px-3 py-1.5 text-right font-mono">
                                {s !== null ? (s * 100).toFixed(0) + '%' : '—'}
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>

        {/* 우측: 현재 살아있는 핀의 expected remaining life */}
        <aside className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-700">
            살아있는 핀 잔존 생존확률 (Top 20)
          </h2>
          <p className="text-xs text-gray-500">
            진입 주차 N → 동일 category KM 곡선에서 S(N+k)/S(N) 룩업.
          </p>
          <div className="rounded border border-gray-200 divide-y divide-gray-100">
            {activePins.length === 0 ? (
              <div className="p-4 text-xs text-gray-500 text-center">
                아직 활성 핀이 없습니다.
              </div>
            ) : (
              activePins.map((pin) => {
                const catRows = byCat.get(pin.category_top) ?? []
                const sNow =
                  catRows.find((r) => r.week === pin.age_weeks)?.survival ?? null
                const sPlus4 =
                  catRows.find((r) => r.week === pin.age_weeks + 4)?.survival ?? null
                const cond = sNow && sPlus4 && sNow > 0 ? sPlus4 / sNow : null
                return (
                  <Link
                    key={pin.id}
                    href={`/admin/trend-radar/products/${pin.id}`}
                    className="block px-3 py-2 hover:bg-gray-50"
                  >
                    <div className="text-sm font-medium truncate">{pin.canonical_name}</div>
                    <div className="flex items-center justify-between text-xs text-gray-500 mt-0.5">
                      <span>
                        {pin.category_top} · {pin.age_weeks}주차
                      </span>
                      <span className="font-mono">
                        +4w 잔존:{' '}
                        <span
                          className={
                            cond === null
                              ? 'text-gray-400'
                              : cond >= 0.5
                              ? 'text-green-700 font-bold'
                              : cond >= 0.25
                              ? 'text-amber-700 font-bold'
                              : 'text-red-700 font-bold'
                          }
                        >
                          {cond !== null ? (cond * 100).toFixed(0) + '%' : '—'}
                        </span>
                      </span>
                    </div>
                  </Link>
                )
              })
            )}
          </div>
        </aside>
      </div>

      <footer className="text-xs text-gray-400 border-t border-gray-100 pt-3">
        진입 임계: final_score ≥ 50 · 이탈 임계: final_score &lt; 35 · 우측 절단: last_seen_at 기준
        · 신뢰구간: Greenwood plain-scale 95%
      </footer>
    </div>
  )
}

function KmSvg({
  categories,
}: {
  categories: { key: string; rows: KmRow[] }[]
}) {
  const W = 720
  const H = 320
  const pad = { l: 44, r: 12, t: 12, b: 30 }
  const innerW = W - pad.l - pad.r
  const innerH = H - pad.t - pad.b
  const maxWeek = Math.max(
    1,
    ...categories.flatMap((c) => c.rows.map((r) => r.week)),
  )
  const xAt = (w: number) => pad.l + (w / maxWeek) * innerW
  const yAt = (s: number) => pad.t + (1 - s) * innerH

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      preserveAspectRatio="xMidYMid meet"
      style={{ background: '#fafafa', borderRadius: 4 }}
    >
      {/* y-axis ticks */}
      {[0, 0.25, 0.5, 0.75, 1].map((s) => (
        <g key={s}>
          <line
            x1={pad.l}
            y1={yAt(s)}
            x2={W - pad.r}
            y2={yAt(s)}
            stroke="#e5e7eb"
            strokeDasharray={s === 0.5 ? '4 2' : '1 3'}
          />
          <text x={pad.l - 6} y={yAt(s) + 3} fontSize={10} textAnchor="end" fill="#6b7280">
            {(s * 100).toFixed(0)}%
          </text>
        </g>
      ))}
      {/* x-axis ticks */}
      {[0, 4, 8, 13, 17, 21, 26].filter((w) => w <= maxWeek).map((w) => (
        <g key={w}>
          <line x1={xAt(w)} y1={pad.t} x2={xAt(w)} y2={H - pad.b} stroke="#f3f4f6" />
          <text x={xAt(w)} y={H - pad.b + 14} fontSize={10} textAnchor="middle" fill="#6b7280">
            {w}w
          </text>
        </g>
      ))}
      {/* curves (step function) */}
      {categories.map((c, i) => {
        const color = PALETTE[i % PALETTE.length]
        const path: string[] = []
        let prevS = 1
        let prevX = xAt(0)
        path.push(`M ${prevX} ${yAt(prevS)}`)
        for (const r of c.rows) {
          const x = xAt(r.week)
          path.push(`L ${x} ${yAt(prevS)}`)
          path.push(`L ${x} ${yAt(r.survival)}`)
          prevS = r.survival
          prevX = x
        }
        return (
          <path
            key={c.key}
            d={path.join(' ')}
            stroke={color}
            strokeWidth={2}
            fill="none"
            opacity={0.9}
          />
        )
      })}
      {/* axes */}
      <line x1={pad.l} y1={H - pad.b} x2={W - pad.r} y2={H - pad.b} stroke="#9ca3af" />
      <line x1={pad.l} y1={pad.t} x2={pad.l} y2={H - pad.b} stroke="#9ca3af" />
      <text
        x={pad.l + innerW / 2}
        y={H - 4}
        fontSize={10}
        textAnchor="middle"
        fill="#374151"
      >
        weeks since entry
      </text>
      <text
        x={12}
        y={pad.t + innerH / 2}
        fontSize={10}
        textAnchor="middle"
        fill="#374151"
        transform={`rotate(-90, 12, ${pad.t + innerH / 2})`}
      >
        survival S(t)
      </text>
    </svg>
  )
}
