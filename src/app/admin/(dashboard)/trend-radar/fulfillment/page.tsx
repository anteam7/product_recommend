import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import FulfillmentScatter, { type FulfillRow, MODE_META } from './FulfillmentScatter'

export const dynamic = 'force-dynamic'

// RPC(supabase/trends_fulfillment_mode.sql)는 DB에 존재하나 generated 타입 미반영
// — `npm run gen:types` 시 `as never` 캐스팅 제거
async function fetchFulfillment(): Promise<{ rows: FulfillRow[]; error: string | null }> {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_trends_fulfillment_mode' as never, {
    days_window: 90,
    min_observations: 4,
    min_volume: 5,
    result_limit: 300,
  } as never)
  if (error) return { rows: [], error: error.message }
  return { rows: (data ?? []) as FulfillRow[], error: null }
}

// burn-rate 추정 (사입 권고 부가) — FulfillmentScatter 와 동일 휴리스틱
function estBurn(meanVol: number): string {
  const daysToTurn = Math.max(1, Math.round(450 / Math.max(meanVol, 1)))
  return `~${daysToTurn}일`
}

export default async function FulfillmentGatePage() {
  const { rows, error } = await fetchFulfillment()

  const counts = {
    consignment: rows.filter((r) => r.mode === 'consignment').length,
    purchase: rows.filter((r) => r.mode === 'purchase').length,
    hold: rows.filter((r) => r.mode === 'hold').length,
  }

  const tableRows = [...rows].sort((a, b) => {
    // 사입 → 위탁 → 보류, 그 안에서 평균수요 내림차순
    const order: Record<string, number> = { purchase: 0, consignment: 1, hold: 2 }
    const d = (order[a.mode] ?? 9) - (order[b.mode] ?? 9)
    if (d !== 0) return d
    return b.mean_vol - a.mean_vol
  })

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">위탁 / 사입 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            수요 변동성(CV)·스파이크 빈도·자기상관 기반 fulfillment 모드 추천 · X = 변동성 · Y = 평균수요
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {error && (
        <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
          RPC 오류: {error}
          <div className="mt-1 text-xs text-amber-700">
            supabase/trends_fulfillment_mode.sql 마이그레이션 적용 여부를 확인하세요.
          </div>
        </div>
      )}

      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 시계열 충분치 않음 (키워드·source 별 4회 이상 누적 필요). cron 누적 후 다시 방문.
        </div>
      ) : (
        !error && (
          <>
            {/* 요약 카드 */}
            <div className="grid grid-cols-3 gap-3">
              {(['purchase', 'consignment', 'hold'] as const).map((m) => (
                <div
                  key={m}
                  className="rounded border border-gray-200 p-4"
                  style={{ borderLeft: `4px solid ${MODE_META[m].color}` }}
                >
                  <div className="text-xs text-gray-500">{MODE_META[m].badge}</div>
                  <div className="text-2xl font-bold">{counts[m]}</div>
                  <div className="text-xs text-gray-400">{MODE_META[m].label}</div>
                </div>
              ))}
            </div>

            <FulfillmentScatter rows={rows} />

            {/* 모드 배지 테이블 */}
            <div className="rounded border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 text-xs">
                  <tr>
                    <th className="px-3 py-2 text-left">모드</th>
                    <th className="px-3 py-2 text-left">키워드</th>
                    <th className="px-3 py-2 text-left">source</th>
                    <th className="px-3 py-2 text-right">평균수요</th>
                    <th className="px-3 py-2 text-right">CV</th>
                    <th className="px-3 py-2 text-right">스파이크</th>
                    <th className="px-3 py-2 text-right">자기상관</th>
                    <th className="px-3 py-2 text-right">관측</th>
                    <th className="px-3 py-2 text-left">권고</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.slice(0, 100).map((r) => {
                    const meta = MODE_META[r.mode] ?? MODE_META.hold
                    return (
                      <tr key={r.keyword + r.source} className="border-t border-gray-100">
                        <td className="px-3 py-2">
                          <span
                            className="rounded px-2 py-0.5 text-xs font-medium text-white"
                            style={{ background: meta.color }}
                          >
                            {meta.badge}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-medium">{r.keyword}</td>
                        <td className="px-3 py-2 text-gray-500 text-xs">{r.source}</td>
                        <td className="px-3 py-2 text-right">{r.mean_vol}</td>
                        <td className="px-3 py-2 text-right">{r.cv ?? '—'}</td>
                        <td className="px-3 py-2 text-right">{(r.spike_freq * 100).toFixed(0)}%</td>
                        <td className="px-3 py-2 text-right text-gray-500">{r.autocorr ?? '—'}</td>
                        <td className="px-3 py-2 text-right text-gray-500">{r.n_obs}</td>
                        <td className="px-3 py-2 text-xs text-gray-600">
                          {r.mode === 'purchase'
                            ? `사입 시 재고회전 ${estBurn(r.mean_vol)} 추정`
                            : r.mode === 'consignment'
                              ? '위탁 — 재고 무리스크'
                              : '데이터 부족·보류'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <p className="text-xs text-gray-400">
              기준: CV≥0.5 또는 스파이크≥18% → 위탁 · CV&lt;0.5 &amp;&amp; 평균수요≥30 → 사입 · 그 외 보류.
              ggsan 소싱 매칭(추천 페이지) 시 동일 키워드의 모드 배지를 핀에 함께 노출하면 의사결정이 빨라집니다.
            </p>
          </>
        )
      )}
    </div>
  )
}
