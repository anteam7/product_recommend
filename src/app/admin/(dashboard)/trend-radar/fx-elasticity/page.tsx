import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface ElasticityRow {
  currency: string
  category_top: string
  lag_days: number
  beta: number | null
  correlation: number | null
  sample_count: number
  avg_demand: number | null
  avg_fx_pct: number | null
}

interface ShockRow {
  currency: string
  start_rate: number | null
  end_rate: number | null
  pct_change: number | null
  trend: 'up' | 'down' | 'flat' | null
}

interface SubstitutionRow {
  category_top: string
  best_lag: number
  beta_demand: number | null
  beta_gsc: number | null
  substitution_score: number | null
}

const CURRENCIES = ['USD', 'JPY', 'CNY'] as const
const DAYS_OPTIONS = [
  { v: 60, label: '60일' },
  { v: 90, label: '90일 (기본)' },
  { v: 180, label: '180일' },
] as const

async function fetchAll(daysWindow: number) {
  const sb = createAdminClient()

  const [elasticity, shock, subUSD, subJPY, subCNY] = await Promise.all([
    sb.rpc('jimscanner_fx_elasticity' as never, {
      days_window: daysWindow,
      min_samples: 6,
    } as never),
    sb.rpc('jimscanner_fx_recent_shock' as never, { days_back: 7 } as never),
    sb.rpc('jimscanner_fx_substitution_candidates' as never, {
      days_window: daysWindow,
      target_currency: 'USD',
      min_samples: 6,
    } as never),
    sb.rpc('jimscanner_fx_substitution_candidates' as never, {
      days_window: daysWindow,
      target_currency: 'JPY',
      min_samples: 6,
    } as never),
    sb.rpc('jimscanner_fx_substitution_candidates' as never, {
      days_window: daysWindow,
      target_currency: 'CNY',
      min_samples: 6,
    } as never),
  ])

  return {
    elasticity: (elasticity.data ?? []) as ElasticityRow[],
    shock: (shock.data ?? []) as ShockRow[],
    substitution: {
      USD: (subUSD.data ?? []) as SubstitutionRow[],
      JPY: (subJPY.data ?? []) as SubstitutionRow[],
      CNY: (subCNY.data ?? []) as SubstitutionRow[],
    },
    error:
      elasticity.error?.message ??
      shock.error?.message ??
      subUSD.error?.message ??
      subJPY.error?.message ??
      subCNY.error?.message ??
      null,
  }
}

function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return '–'
  return `${(Number(v) * 100).toFixed(digits)}%`
}
function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return '–'
  return Number(v).toFixed(digits)
}
function betaColor(b: number | null): string {
  if (b == null) return 'bg-gray-50 text-gray-400'
  if (b >= 5) return 'bg-emerald-600 text-white'
  if (b >= 2) return 'bg-emerald-300 text-emerald-900'
  if (b >= 0.5) return 'bg-emerald-100 text-emerald-800'
  if (b > -0.5) return 'bg-gray-100 text-gray-600'
  if (b > -2) return 'bg-rose-100 text-rose-800'
  if (b > -5) return 'bg-rose-300 text-rose-900'
  return 'bg-rose-600 text-white'
}

export default async function FxElasticityPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; currency?: string; multiplier?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '90', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 90
  const selectedCurrency = (CURRENCIES as readonly string[]).includes(sp.currency ?? '')
    ? (sp.currency as 'USD' | 'JPY' | 'CNY')
    : 'USD'
  const multiplierOn = sp.multiplier === '1'

  const { elasticity, shock, substitution, error } = await fetchAll(validDays)

  // 카테고리 × lag 히트맵 (선택된 통화)
  const heatRows = elasticity.filter((r) => r.currency === selectedCurrency)
  const categories = Array.from(new Set(heatRows.map((r) => r.category_top))).sort()
  const lags = Array.from({ length: 15 }, (_, i) => i) // 0~14
  const byKey = new Map<string, ElasticityRow>()
  for (const r of heatRows) byKey.set(`${r.category_top}|${r.lag_days}`, r)

  // 통화별 카테고리 rank (best beta across lag>=0)
  const bestByCategory = new Map<string, { cat: string; lag: number; beta: number; corr: number | null }>()
  for (const r of heatRows) {
    if (r.beta == null) continue
    const cur = bestByCategory.get(r.category_top)
    if (!cur || Math.abs(r.beta) > Math.abs(cur.beta)) {
      bestByCategory.set(r.category_top, {
        cat: r.category_top,
        lag: r.lag_days,
        beta: Number(r.beta),
        corr: r.correlation == null ? null : Number(r.correlation),
      })
    }
  }
  const rankRows = Array.from(bestByCategory.values()).sort(
    (a, b) => Math.abs(b.beta) - Math.abs(a.beta),
  )

  // 최근 7d 환율 충격 → 다음 14d 예측 (선택된 통화)
  const shockRow = shock.find((s) => s.currency === selectedCurrency)
  const fxShockPct = Number(shockRow?.pct_change ?? 0) // 7일 변화율
  const forecastRows = rankRows.slice(0, 8).map((r) => ({
    category_top: r.cat,
    lag: r.lag,
    expected_delta: r.beta * fxShockPct, // demand_index 단위 변화 예측
  }))

  // 위탁 대체 후보 (선택된 통화)
  const subs = substitution[selectedCurrency] ?? []

  const currentParams: Record<string, string> = {
    days: String(validDays),
    currency: selectedCurrency,
    multiplier: multiplierOn ? '1' : '',
  }
  const buildHref = (override: Record<string, string | null>) => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(currentParams)) if (v) params.set(k, v)
    for (const [k, v] of Object.entries(override)) {
      if (v == null || v === '') params.delete(k)
      else params.set(k, v)
    }
    const qs = params.toString()
    return '/admin/trend-radar/fx-elasticity' + (qs ? `?${qs}` : '')
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">💱 FX 충격 → 카테고리 수요 Elasticity</h1>
          <p className="text-sm text-gray-500 mt-1">
            환율 변동률(USD/JPY/CNY) ↔ 카테고리 수요(volume_relative) ↔ 자사 GSC 클릭을 lag 0~14d
            cross-correlation 으로 결합. 환율 ↑ · 직구 둔화 → 국내 위탁 대체수요로 의심되는 카테고리 탐지.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">윈도우</span>
          {DAYS_OPTIONS.map((d) => (
            <Link
              key={d.v}
              href={buildHref({ days: String(d.v) })}
              className={`px-2 py-1 text-xs rounded ${
                validDays === d.v ? 'bg-indigo-100 text-indigo-700 font-semibold' : 'text-gray-500 hover:text-black'
              }`}
            >
              {d.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">통화</span>
          {CURRENCIES.map((c) => (
            <Link
              key={c}
              href={buildHref({ currency: c })}
              className={`px-2 py-1 text-xs rounded ${
                selectedCurrency === c
                  ? 'bg-indigo-100 text-indigo-700 font-semibold'
                  : 'text-gray-500 hover:text-black'
              }`}
            >
              {c}
            </Link>
          ))}
        </div>
        <Link
          href={buildHref({ multiplier: multiplierOn ? null : '1' })}
          className={`px-3 py-1 text-xs rounded ${
            multiplierOn ? 'bg-amber-100 text-amber-700 font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
          title="ggsan_recommend 점수에 elasticity-adjusted multiplier 적용 옵션 (다음 ggsan 추천 호출에 반영)"
        >
          {multiplierOn ? '✓ ' : ''}추천 multiplier 토글
        </Link>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            supabase/fx_demand_elasticity.sql 적용 필요. (jimscanner_fx_elasticity / _recent_shock /
            _substitution_candidates)
          </p>
        </div>
      )}

      {/* KPI — 최근 7d 환율 충격 */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {CURRENCIES.map((c) => {
          const s = shock.find((x) => x.currency === c)
          const trend = s?.trend ?? 'flat'
          const tone =
            trend === 'up'
              ? 'border-rose-200 bg-rose-50 text-rose-800'
              : trend === 'down'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-gray-200'
          const arrow = trend === 'up' ? '▲' : trend === 'down' ? '▼' : '–'
          return (
            <div key={c} className={`rounded border p-3 ${tone}`}>
              <div className="text-xs opacity-70 flex items-center justify-between">
                <span>{c} (최근 7일)</span>
                <span className="font-mono">{arrow}</span>
              </div>
              <div className="text-2xl font-bold mt-1">{fmtPct(s?.pct_change)}</div>
              <div className="text-[11px] mt-1 opacity-70 font-mono">
                {fmtNum(s?.start_rate, 2)} → {fmtNum(s?.end_rate, 2)} KRW
              </div>
            </div>
          )
        })}
      </section>

      {/* 1) 환율-수요 lag heatmap */}
      <section className="rounded border border-gray-200 p-4 space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold">📊 lag heatmap · {selectedCurrency} → 카테고리 수요</h2>
          <span className="text-[11px] text-gray-500">β (elasticity 계수) · 표본 ≥ 6일</span>
        </div>
        {categories.length === 0 ? (
          <div className="text-xs text-gray-500 py-6 text-center">
            데이터 부족. 환율 로그 / trends_keywords 누적 후 자동 채워짐.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] border-collapse">
              <thead>
                <tr>
                  <th className="text-left p-1 font-medium text-gray-500 sticky left-0 bg-white">카테고리</th>
                  {lags.map((l) => (
                    <th key={l} className="p-1 font-mono text-gray-500 text-center w-9">
                      +{l}d
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {categories.map((cat) => (
                  <tr key={cat} className="border-t border-gray-100">
                    <td className="p-1 font-medium sticky left-0 bg-white whitespace-nowrap">{cat}</td>
                    {lags.map((l) => {
                      const cell = byKey.get(`${cat}|${l}`)
                      const beta = cell?.beta == null ? null : Number(cell.beta)
                      return (
                        <td
                          key={l}
                          className={`p-1 text-center font-mono ${betaColor(beta)}`}
                          title={
                            cell
                              ? `β=${fmtNum(beta, 2)} · r=${fmtNum(cell.correlation, 2)} · n=${cell.sample_count}`
                              : 'no data'
                          }
                        >
                          {beta == null ? '·' : fmtNum(beta, 1)}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-gray-500">
          β &gt; 0 : 환율 ↑ 시 (lag 일 뒤) 카테고리 수요 ↑. β &lt; 0 : 환율 ↑ 시 수요 ↓. 자사 직구는 환율 ↑ 에
          음의 반응이 보통.
        </p>
      </section>

      {/* 2) 카테고리별 elasticity rank */}
      <section className="rounded border border-gray-200 p-4 space-y-3">
        <h2 className="text-base font-semibold">🏆 카테고리별 elasticity rank · {selectedCurrency}</h2>
        {rankRows.length === 0 ? (
          <div className="text-xs text-gray-500 py-6 text-center">데이터 부족</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-gray-500 border-b border-gray-200">
              <tr>
                <th className="text-left py-2">#</th>
                <th className="text-left py-2">카테고리</th>
                <th className="text-right py-2">best lag</th>
                <th className="text-right py-2">β</th>
                <th className="text-right py-2">상관계수 r</th>
              </tr>
            </thead>
            <tbody>
              {rankRows.slice(0, 20).map((r, i) => (
                <tr key={r.cat} className="border-b border-gray-100">
                  <td className="py-1.5 font-mono text-gray-400">{i + 1}</td>
                  <td className="py-1.5 font-medium">{r.cat}</td>
                  <td className="py-1.5 text-right font-mono text-gray-600">+{r.lag}d</td>
                  <td className={`py-1.5 text-right font-mono font-bold ${r.beta >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                    {fmtNum(r.beta, 2)}
                  </td>
                  <td className="py-1.5 text-right font-mono text-gray-600">{fmtNum(r.corr, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* 3) 최근 7d FX shock → 다음 14d 카테고리 수요 예측 */}
      <section className="rounded border border-gray-200 p-4 space-y-3">
        <h2 className="text-base font-semibold">
          🔮 환율 충격 → 다음 14d 카테고리 수요 예측 (top 8)
        </h2>
        <div className="text-xs text-gray-500">
          최근 7일 {selectedCurrency} 변화율{' '}
          <code className="font-mono">{fmtPct(shockRow?.pct_change)}</code> × β →
          demand_index 예상 변화량
        </div>
        {forecastRows.length === 0 ? (
          <div className="text-xs text-gray-500 py-6 text-center">예측 가능한 카테고리 없음</div>
        ) : (
          <div className="space-y-1.5">
            {(() => {
              const maxAbs = Math.max(...forecastRows.map((r) => Math.abs(r.expected_delta)), 0.001)
              return forecastRows.map((r) => {
                const pct = Math.min(100, (Math.abs(r.expected_delta) / maxAbs) * 100)
                const positive = r.expected_delta >= 0
                return (
                  <div key={r.category_top} className="flex items-center gap-2 text-xs">
                    <div className="w-32 truncate">{r.category_top}</div>
                    <div className="w-12 text-right font-mono text-gray-500">+{r.lag}d</div>
                    <div className="flex-1 h-4 bg-gray-50 rounded overflow-hidden relative">
                      <div
                        className={`h-full ${positive ? 'bg-emerald-500' : 'bg-rose-500'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div
                      className={`w-20 text-right font-mono font-semibold ${
                        positive ? 'text-emerald-700' : 'text-rose-700'
                      }`}
                    >
                      {positive ? '+' : ''}
                      {fmtNum(r.expected_delta, 2)}
                    </div>
                  </div>
                )
              })
            })()}
          </div>
        )}
      </section>

      {/* 4) 위탁 대체수요 후보 + ggsan 매칭 패널 */}
      <section className="rounded border border-amber-200 bg-amber-50/40 p-4 space-y-3">
        <h2 className="text-base font-semibold">
          🎯 &quot;환율 ↑ · 직구 둔화 → 국내 위탁 대체수요 ↑&quot; 카테고리 ({selectedCurrency})
        </h2>
        <div className="text-[11px] text-gray-600">
          β_demand &gt; 0 (FX → 카테고리 수요 ↑) 이면서 β_gsc &lt; 0 (FX → 자사 직구 클릭 ↓) 인 카테고리.
          substitution_score = β_demand × (-β_gsc).
        </div>
        {subs.length === 0 ? (
          <div className="text-xs text-gray-500 py-6 text-center">대체수요 시그널 없음 (정상 — 환율 안정 구간일 수 있음)</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-gray-500 border-b border-amber-200">
              <tr>
                <th className="text-left py-2">#</th>
                <th className="text-left py-2">카테고리</th>
                <th className="text-right py-2">best lag</th>
                <th className="text-right py-2">β_demand</th>
                <th className="text-right py-2">β_gsc</th>
                <th className="text-right py-2">substitution_score</th>
                <th className="text-right py-2"></th>
              </tr>
            </thead>
            <tbody>
              {subs.slice(0, 15).map((r, i) => (
                <tr key={r.category_top} className="border-b border-amber-100">
                  <td className="py-1.5 font-mono text-gray-400">{i + 1}</td>
                  <td className="py-1.5 font-medium">{r.category_top}</td>
                  <td className="py-1.5 text-right font-mono">+{r.best_lag}d</td>
                  <td className="py-1.5 text-right font-mono text-emerald-700">{fmtNum(r.beta_demand, 2)}</td>
                  <td className="py-1.5 text-right font-mono text-rose-700">{fmtNum(r.beta_gsc, 2)}</td>
                  <td className="py-1.5 text-right font-mono font-bold">
                    {fmtNum(r.substitution_score, 2)}
                  </td>
                  <td className="py-1.5 text-right">
                    <Link
                      href={`/admin/trend-radar/recommend?days=30${multiplierOn ? '&multiplier=1' : ''}`}
                      className="text-[11px] text-amber-700 hover:underline"
                    >
                      ggsan 추천 →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {multiplierOn && (
          <div className="text-[11px] text-amber-800 bg-amber-100 rounded px-3 py-2">
            ✓ multiplier 토글 활성. /admin/trend-radar/recommend 호출 시 elasticity-adjusted multiplier
            적용 옵션이 추천 점수에 곱해집니다 (V1 RPC 인자로 전달 — 현재는 UI 토글만 노출, RPC 인자 연동은 다음
            iteration).
          </div>
        )}
      </section>

      {/* 공식 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 elasticity 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          β(currency, category, lag) = COVAR_POP(demand[t+lag], fx_pct[t]) / VAR_POP(fx_pct[t])
          <br />
          substitution_score(category) = β_demand(category, best_lag) × (-β_gsc(currency))
          <br />
          forecast_delta(category) = β × pct_change_7d(currency)
        </code>
        <div className="pt-2">
          데이터 의존: <code>jimscanner_exchange_rate_logs</code>,{' '}
          <code>jimscanner_trends_keywords.volume_relative</code>,{' '}
          <code>jimscanner_gsc_queries.clicks</code>. lag 0~14d cross-correlation.
        </div>
      </section>
    </div>
  )
}
