import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import PinWatchdogScatter from './PinWatchdogScatter'
import PinActions from './PinActions'

export const dynamic = 'force-dynamic'

export type PinDecayRow = {
  keyword: string
  source: string
  product_id: string | null
  category_top: string | null
  last_pinned_at: string | null

  final_score_latest: number | null
  trend_score_latest: number | null
  commerce_score_latest: number | null
  competition_score_latest: number | null
  supplier_score_latest: number | null

  final_slope_window: number | null
  final_slope_30d: number | null
  competition_delta_window: number | null
  supply_price_delta_pct_window: number | null
  serp_supply_count: number | null

  pin_health_score: number | null
  pin_quadrant: 'alive' | 'slowing' | 'saturated' | 'dead' | 'unknown' | string | null
  note: string | null
}

async function fetchPinDecay(daysWindow: number): Promise<PinDecayRow[]> {
  const sb = createAdminClient()
  // RPC 미적용 환경에서도 빌드 통과를 위해 as any 캐스팅.
  const { data, error } = await (sb.rpc as any)('jimscanner_pin_decay', {
    days_window: daysWindow,
  })
  if (error || !Array.isArray(data)) return []
  return data as PinDecayRow[]
}

function quadrantBadge(q: string | null | undefined) {
  switch (q) {
    case 'alive':
      return { label: '살아있음', cls: 'bg-green-100 text-green-800 border-green-300' }
    case 'slowing':
      return { label: '둔화', cls: 'bg-yellow-100 text-yellow-800 border-yellow-300' }
    case 'saturated':
      return { label: '포화', cls: 'bg-orange-100 text-orange-800 border-orange-300' }
    case 'dead':
      return { label: '소멸', cls: 'bg-red-100 text-red-800 border-red-300' }
    default:
      return { label: '미분류', cls: 'bg-gray-100 text-gray-600 border-gray-300' }
  }
}

export default async function PinWatchdogPage({
  searchParams,
}: {
  searchParams?: Promise<{ window?: string }>
}) {
  const sp = (await searchParams) ?? {}
  const win = Math.max(7, Math.min(60, parseInt(sp.window ?? '14', 10) || 14))
  const rows = await fetchPinDecay(win)

  const counts = rows.reduce(
    (acc, r) => {
      const q = (r.pin_quadrant ?? 'unknown') as string
      acc[q] = (acc[q] ?? 0) + 1
      return acc
    },
    {} as Record<string, number>,
  )

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">핀 부패 워치독</h1>
          <p className="text-sm text-gray-500 mt-1">
            등록된 핀의 점수·경쟁·공급 변동을 추적해 정리 대상을 골라낸다.{' '}
            <span className="font-mono">window={win}d</span>
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {['7', '14', '30'].map((w) => (
            <Link
              key={w}
              href={`/admin/trend-radar/pin-watchdog?window=${w}`}
              className={`px-2 py-1 rounded border ${
                String(win) === w
                  ? 'bg-black text-white border-black'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              {w}d
            </Link>
          ))}
          <Link
            href="/admin/trend-radar/pins"
            className="text-gray-700 hover:text-black underline"
          >
            ← 핀 목록
          </Link>
        </div>
      </header>

      <section className="grid grid-cols-4 gap-3 text-sm">
        {(['alive', 'slowing', 'saturated', 'dead'] as const).map((q) => {
          const b = quadrantBadge(q)
          return (
            <div
              key={q}
              className={`rounded border p-3 ${b.cls.replace('text-', 'text-')}`}
            >
              <div className="text-xs">{b.label}</div>
              <div className="text-2xl font-bold mt-1">{counts[q] ?? 0}</div>
            </div>
          )
        })}
      </section>

      <PinWatchdogScatter rows={rows} />

      <section>
        <h2 className="text-lg font-semibold mb-2">전체 핀 ({rows.length})</h2>
        {rows.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
            <p className="text-base font-medium">집계할 핀 없음</p>
            <p className="text-sm mt-2">
              RPC <code>jimscanner_pin_decay</code> 미적용 또는 pinned=true 행이 없음.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-600">
                <tr>
                  <th className="text-left px-3 py-2">키워드</th>
                  <th className="text-left px-3 py-2">소스</th>
                  <th className="text-right px-3 py-2">final</th>
                  <th className="text-right px-3 py-2">slope({win}d)</th>
                  <th className="text-right px-3 py-2">Δcomp</th>
                  <th className="text-right px-3 py-2">Δ공급가%</th>
                  <th className="text-right px-3 py-2">SERP</th>
                  <th className="text-right px-3 py-2">부패도</th>
                  <th className="text-center px-3 py-2">상태</th>
                  <th className="text-right px-3 py-2">액션</th>
                </tr>
              </thead>
              <tbody>
                {rows
                  .slice()
                  .sort((a, b) => (b.pin_health_score ?? 0) - (a.pin_health_score ?? 0))
                  .map((r) => {
                    const b = quadrantBadge(r.pin_quadrant ?? undefined)
                    return (
                      <tr
                        key={`${r.source}::${r.keyword}`}
                        className="border-t border-gray-100 hover:bg-gray-50"
                      >
                        <td className="px-3 py-2 font-medium">{r.keyword}</td>
                        <td className="px-3 py-2 text-xs text-gray-500">{r.source}</td>
                        <td className="px-3 py-2 text-right font-mono">
                          {r.final_score_latest?.toFixed(0) ?? '—'}
                        </td>
                        <td
                          className={`px-3 py-2 text-right font-mono ${
                            (r.final_slope_window ?? 0) < 0 ? 'text-red-600' : 'text-green-600'
                          }`}
                        >
                          {r.final_slope_window?.toFixed(2) ?? '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {r.competition_delta_window?.toFixed(1) ?? '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {r.supply_price_delta_pct_window?.toFixed(1) ?? '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {r.serp_supply_count ?? 0}
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-semibold">
                          {r.pin_health_score?.toFixed(0) ?? '—'}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span className={`inline-block px-2 py-0.5 rounded border text-xs ${b.cls}`}>
                            {b.label}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right text-xs">
                          <PinActions keyword={r.keyword} source={r.source} />
                        </td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
