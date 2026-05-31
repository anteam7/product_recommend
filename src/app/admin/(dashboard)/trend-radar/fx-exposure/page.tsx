import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { TRACKED_CURRENCIES, type Currency } from '@/lib/exchange-rates'
import Sparkline from './Sparkline'

export const dynamic = 'force-dynamic'

// jimscanner_fx_margin_exposure RPC 반환 행. 마이그레이션 적용 후 상태 가정.
interface ExposureRow {
  product_id: string
  product_name: string
  supplier_id: string
  supplier_source: string
  currency: Currency | string
  price_original: number | null
  base_rate_krw: number | null
  base_landed_krw: number | null
  daily_vol_pct: number | null
  stress_pct: number | null
  stressed_landed_krw: number | null
  fx_sensitivity_krw_per_pct: number | null
  moq: number | null
  lead_time_days: number | null
  base_margin_pct: number | null
  stressed_margin_pct: number | null
  recommended_buffer_pct: number | null
  is_fx_exposed: boolean
  is_red_flag: boolean
}

interface HistoryRow {
  currency: string
  rate_krw: number
  rate_date: string
}

function krw(n: number | null | undefined) {
  if (n == null) return '—'
  return Math.round(n).toLocaleString('ko-KR')
}

function pct(n: number | null | undefined, digits = 2) {
  if (n == null) return '—'
  return `${n.toFixed(digits)}%`
}

async function fetchData() {
  const sb = createAdminClient()

  // RPC: product×supplier 별 base/stressed 마진·FX 민감도
  const { data: rpcData, error: rpcError } = await (sb as any).rpc('jimscanner_fx_margin_exposure', {
    p_days: 30,
    p_min_stress: 0.03,
    p_target_margin: 0.25,
    p_fee: 0.106,
    p_margin_floor: 0.1,
  })

  // 통화별 스파크라인용 최근 환율 시계열
  const { data: historyRaw } = await sb
    .from('jimscanner_exchange_rate_history')
    .select('currency, rate_krw, rate_date')
    .order('rate_date', { ascending: true })
    .limit(400)

  const rows = ((rpcData ?? []) as ExposureRow[]) || []
  const history = (historyRaw ?? []) as HistoryRow[]

  const seriesByCurrency = new Map<string, number[]>()
  for (const h of history) {
    const arr = seriesByCurrency.get(h.currency) ?? []
    arr.push(h.rate_krw)
    seriesByCurrency.set(h.currency, arr)
  }

  return { rows, seriesByCurrency, rpcError: rpcError?.message ?? null }
}

export default async function FxExposurePage() {
  const { rows, seriesByCurrency, rpcError } = await fetchData()

  const exposed = rows.filter((r) => r.is_fx_exposed)
  const immune = rows.filter((r) => !r.is_fx_exposed)
  const redFlags = rows.filter((r) => r.is_red_flag)

  // 변동성 카드용 통화 집계 (노출 SKU 기준)
  const currencyStats = new Map<string, { vol: number; stress: number }>()
  for (const r of exposed) {
    if (!currencyStats.has(r.currency) && r.daily_vol_pct != null) {
      currencyStats.set(r.currency, {
        vol: r.daily_vol_pct ?? 0,
        stress: r.stress_pct ?? 0,
      })
    }
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">FX 익스포저 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            수입소싱 SKU 의 환율 민감도 · 리드타임 스트레스(σ×리드타임) 후 마진 잠식 · 권장 FX 버퍼.
            KRW(ggsan) 소싱은 환노출 면역으로 회색 처리.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {rpcError && (
        <div className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          RPC <code className="bg-white px-1 rounded border">jimscanner_fx_margin_exposure</code> 호출 실패:{' '}
          {rpcError}. <code className="bg-white px-1 rounded border">supabase/fx_margin_exposure.sql</code> 를
          DB 에 적용했는지 확인하세요.
        </div>
      )}

      {/* 요약 카드 */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border bg-white p-4">
          <div className="text-xs text-gray-500">환노출 SKU</div>
          <div className="text-2xl font-bold text-gray-900">{exposed.length}</div>
          <div className="text-xs text-gray-400 mt-1">면역(KRW) {immune.length}건</div>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <div className="text-xs text-gray-500">적색 플래그</div>
          <div className={`text-2xl font-bold ${redFlags.length ? 'text-red-600' : 'text-gray-900'}`}>
            {redFlags.length}
          </div>
          <div className="text-xs text-gray-400 mt-1">스트레스 시 마진 임계 이하</div>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <div className="text-xs text-gray-500">추적 통화</div>
          <div className="flex flex-wrap gap-3 mt-1">
            {TRACKED_CURRENCIES.map((cur) => {
              const series = seriesByCurrency.get(cur) ?? []
              const st = currencyStats.get(cur)
              return (
                <div key={cur} className="flex flex-col items-start">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold text-gray-700">{cur}</span>
                    <Sparkline values={series.slice(-30)} width={64} height={18} />
                  </div>
                  <span className="text-[10px] text-gray-400">
                    σ {pct(st?.vol, 2)} · 스트레스 {pct(st?.stress, 1)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* 익스포저 테이블 */}
      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          {rpcError
            ? '데이터 없음 — 마이그레이션 적용 후 다시 방문.'
            : 'supplier 데이터 없음. ggsan/수입 소싱 수집 후 다시 방문.'}
        </div>
      ) : (
        <div className="bg-white border rounded-lg overflow-x-auto">
          <table className="w-full text-sm min-w-[1040px]">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-3 py-2 text-xs font-semibold text-gray-600 uppercase">상품</th>
                <th className="text-left px-3 py-2 text-xs font-semibold text-gray-600 uppercase">소스</th>
                <th className="text-center px-3 py-2 text-xs font-semibold text-gray-600 uppercase">통화</th>
                <th className="text-right px-3 py-2 text-xs font-semibold text-gray-600 uppercase" title="현재 환율로 재계산한 도매원가">
                  현재 원가
                </th>
                <th className="text-right px-3 py-2 text-xs font-semibold text-gray-600 uppercase" title="+1% FX 당 원가 변화(원)">
                  ∂원가/FX
                </th>
                <th className="text-right px-3 py-2 text-xs font-semibold text-gray-600 uppercase" title="일별 로그수익률 표준편차">
                  σ(일)
                </th>
                <th className="text-right px-3 py-2 text-xs font-semibold text-gray-600 uppercase" title="z·σ·√리드타임, 최소 3%">
                  스트레스
                </th>
                <th className="text-right px-3 py-2 text-xs font-semibold text-gray-600 uppercase">스트레스 원가</th>
                <th className="text-right px-3 py-2 text-xs font-semibold text-gray-600 uppercase" title="기준→스트레스 마진">
                  마진(기준→스트레스)
                </th>
                <th className="text-right px-3 py-2 text-xs font-semibold text-gray-600 uppercase" title="기준마진 유지에 필요한 도매원가 버퍼">
                  권장 버퍼
                </th>
                <th className="text-center px-3 py-2 text-xs font-semibold text-gray-600 uppercase">MOQ/리드</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const immuneRow = !r.is_fx_exposed
                return (
                  <tr
                    key={r.supplier_id}
                    className={`border-b last:border-b-0 ${
                      r.is_red_flag
                        ? 'bg-red-50'
                        : immuneRow
                          ? 'bg-gray-50/60 text-gray-400'
                          : ''
                    }`}
                  >
                    <td className="px-3 py-2 max-w-[240px] truncate font-medium" title={r.product_name}>
                      {r.is_red_flag && <span className="mr-1 text-red-600">●</span>}
                      {r.product_name}
                    </td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">{r.supplier_source}</td>
                    <td className="px-3 py-2 text-center">
                      {immuneRow ? (
                        <span className="text-xs text-gray-400">면역</span>
                      ) : (
                        <span className="text-xs font-semibold text-gray-700">{r.currency}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{krw(r.base_landed_krw)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {immuneRow ? '—' : krw(r.fx_sensitivity_krw_per_pct)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {immuneRow ? '—' : pct(r.daily_vol_pct, 2)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {immuneRow ? '—' : (
                        <span className="text-amber-700">{pct(r.stress_pct, 1)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {immuneRow ? '—' : krw(r.stressed_landed_krw)}
                    </td>
                    <td className="px-3 py-2 text-right text-xs whitespace-nowrap">
                      {immuneRow ? (
                        '—'
                      ) : (
                        <>
                          <span className="text-gray-600">{pct(r.base_margin_pct, 0)}</span>
                          <span className="mx-1 text-gray-400">→</span>
                          <span
                            className={
                              r.is_red_flag
                                ? 'font-semibold text-red-600'
                                : 'text-gray-900'
                            }
                          >
                            {pct(r.stressed_margin_pct, 1)}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {immuneRow ? '—' : (
                        <span className="text-blue-700">+{pct(r.recommended_buffer_pct, 1)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center text-xs text-gray-500 whitespace-nowrap">
                      {r.moq ?? '—'} / {r.lead_time_days ?? '—'}일
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 text-xs text-blue-900 leading-relaxed space-y-1">
        <p className="font-semibold">읽는 법 (마진 워터폴)</p>
        <p>
          도매원가(현재 환율 재계산) → FX 스트레스 가산(z·σ·√리드타임, 최소 3%) → 쿠팡 수수료 10.6% →
          잔여 마진. <span className="text-red-700 font-medium">적색 행</span>은 현실적 FX 스윙만으로 마진이
          임계(10%) 아래로 떨어지는 SKU — 등록 전 판매가에 <b>권장 버퍼</b>만큼 패딩하거나 소싱을 재검토.
          σ 는 <code className="bg-white px-1 rounded border">jimscanner_exchange_rate_logs</code> 의 최근 30일
          실현 변동성. 기준마진 25% 가정.
        </p>
      </div>
    </div>
  )
}
