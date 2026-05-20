import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface SnapshotRow {
  currency: string
  avg_30d: number
  sigma_30d: number
  min_30d: number
  max_30d: number
  n_days: number
  current_rate: number | null
  fx_favor_score: number
  cv_pct: number
}

interface GateRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  is_imminent: boolean
  image_url: string | null
  detail_url: string | null
  source_currency: string
  current_rate: number
  avg_30d: number
  sigma_30d: number
  cv_pct: number
  worst_case_rate: number
  best_case_rate: number
  margin_under_worst: number
  margin_under_best: number
  margin_cliff_pct: number
  fx_favor_score: number
  fx_badge: 'green' | 'yellow' | 'red' | 'gray'
}

interface HistoryRow {
  currency: string
  rate_krw: number
  rate_date: string
}

const CURRENCY_OPTIONS = [
  { v: 'CNY', label: 'CNY (위안)' },
  { v: 'USD', label: 'USD (달러)' },
  { v: 'JPY', label: 'JPY (엔)' },
  { v: 'EUR', label: 'EUR (유로)' },
] as const

const MARGIN_OPTIONS = [
  { v: 0.2, label: '20%' },
  { v: 0.3, label: '30% (기본)' },
  { v: 0.4, label: '40%' },
  { v: 0.5, label: '50%' },
] as const

const SIGMA_OPTIONS = [
  { v: 1.0, label: '±1σ' },
  { v: 2.0, label: '±2σ (기본)' },
  { v: 3.0, label: '±3σ' },
] as const

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/fx-margin' + (qs ? `?${qs}` : '')
}

function badgeStyle(badge: GateRow['fx_badge']): string {
  switch (badge) {
    case 'green': return 'bg-green-100 text-green-800 border-green-200'
    case 'yellow': return 'bg-amber-100 text-amber-800 border-amber-200'
    case 'red': return 'bg-red-100 text-red-800 border-red-200'
    default: return 'bg-gray-100 text-gray-600 border-gray-200'
  }
}

function badgeIcon(badge: GateRow['fx_badge']): string {
  switch (badge) {
    case 'green': return '🟢 진입 윈도우'
    case 'yellow': return '🟡 중립'
    case 'red': return '🔴 보류 권장'
    default: return '⚪ N/A'
  }
}

async function fetchAll(opts: { margin: number; sigma: number; currency: string }) {
  const sb = createAdminClient()

  // 1) 통화별 30d 변동성 스냅샷
  const { data: snap } = await sb
    .from('jimscanner_fx_margin_snapshot' as never)
    .select('*')
    .order('currency')

  // 2) 핀 단위 마진 게이트
  const { data: gate, error: gateErr } = await sb.rpc('jimscanner_fx_margin_gate' as never, {
    margin_pct: opts.margin,
    sigma_mult: opts.sigma,
    source_currency: opts.currency,
    cate_filter: null,
    result_limit: 200,
  } as never)

  // 3) 환율 히스토리 (디커플링 차트용, 최근 90일)
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)
  const { data: hist } = await sb
    .from('jimscanner_exchange_rate_history')
    .select('currency, rate_krw, rate_date')
    .gte('rate_date', since)
    .order('rate_date', { ascending: true })

  return {
    snapshot: ((snap ?? []) as unknown as SnapshotRow[]).map((s) => ({
      ...s,
      avg_30d: Number(s.avg_30d),
      sigma_30d: Number(s.sigma_30d),
      min_30d: Number(s.min_30d),
      max_30d: Number(s.max_30d),
      current_rate: s.current_rate == null ? null : Number(s.current_rate),
      fx_favor_score: Number(s.fx_favor_score),
      cv_pct: Number(s.cv_pct),
    })),
    gate: ((gate ?? []) as unknown as GateRow[]).map((g) => ({
      ...g,
      current_rate: Number(g.current_rate),
      avg_30d: Number(g.avg_30d),
      sigma_30d: Number(g.sigma_30d),
      cv_pct: Number(g.cv_pct),
      worst_case_rate: Number(g.worst_case_rate),
      best_case_rate: Number(g.best_case_rate),
      margin_under_worst: Number(g.margin_under_worst),
      margin_under_best: Number(g.margin_under_best),
      margin_cliff_pct: Number(g.margin_cliff_pct),
      fx_favor_score: Number(g.fx_favor_score),
    })),
    history: (hist ?? []) as HistoryRow[],
    error: gateErr?.message ?? null,
  }
}

function Sparkline({ points, width = 220, height = 40 }: { points: number[]; width?: number; height?: number }) {
  if (points.length < 2) return <div className="text-xs text-gray-400">데이터 부족</div>
  const min = Math.min(...points)
  const max = Math.max(...points)
  const range = max - min || 1
  const step = width / (points.length - 1)
  const d = points
    .map((p, i) => {
      const x = i * step
      const y = height - ((p - min) / range) * (height - 4) - 2
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg width={width} height={height} className="block">
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  )
}

export default async function FxMarginPage({
  searchParams,
}: {
  searchParams: Promise<{ margin?: string; sigma?: string; currency?: string }>
}) {
  const sp = await searchParams
  const margin = parseFloat(sp.margin ?? '0.3')
  const validMargin = MARGIN_OPTIONS.some((m) => Math.abs(m.v - margin) < 0.001) ? margin : 0.3
  const sigma = parseFloat(sp.sigma ?? '2.0')
  const validSigma = SIGMA_OPTIONS.some((s) => Math.abs(s.v - sigma) < 0.001) ? sigma : 2.0
  const currency = CURRENCY_OPTIONS.some((c) => c.v === sp.currency) ? (sp.currency as string) : 'CNY'

  const current: Record<string, string> = {
    margin: String(validMargin),
    sigma: String(validSigma),
    currency,
  }

  const { snapshot, gate, history, error } = await fetchAll({
    margin: validMargin,
    sigma: validSigma,
    currency,
  })

  // 통화별 시계열 분리
  const histByCurrency = new Map<string, HistoryRow[]>()
  for (const h of history) {
    const list = histByCurrency.get(h.currency) ?? []
    list.push(h)
    histByCurrency.set(h.currency, list)
  }

  // 진입 윈도우 큐: fx_badge === 'green'
  const entryQueue = gate.filter((g) => g.fx_badge === 'green').slice(0, 30)
  const holdQueue = gate.filter((g) => g.fx_badge === 'red').slice(0, 20)

  // KPI
  const avgCliff = gate.length > 0
    ? gate.reduce((s, g) => s + g.margin_cliff_pct, 0) / gate.length
    : 0
  const cliffOver10 = gate.filter((g) => g.margin_cliff_pct >= 0.1).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">💱 FX 민감 마진 절벽 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            환율 변동성을 외생 입력으로 — ±N×σ 시 마진 절벽 % 산출, 진입 윈도우 D-day 큐.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 한계 */}
      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <strong>V0 한계</strong> · ggsan 도매가는 KRW 표기지만, 원가 통화는 운영자가{' '}
        <strong>가정 통화 (source_currency)</strong> 로 일괄 설정. 향후 핀별 원가 통화 태깅 (LLM 분류) 으로
        교체. 마진 시나리오 = <code>1 − (1 − m) × (new_rate / current_rate)</code>.
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">가정 원가 통화</span>
            {CURRENCY_OPTIONS.map((c) => (
              <Link
                key={c.v}
                href={buildHref(current, { currency: c.v })}
                className={`px-2 py-1 text-xs rounded ${currency === c.v ? 'bg-indigo-100 text-indigo-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {c.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">현재 마진율</span>
            {MARGIN_OPTIONS.map((m) => (
              <Link
                key={m.v}
                href={buildHref(current, { margin: String(m.v) })}
                className={`px-2 py-1 text-xs rounded ${Math.abs(validMargin - m.v) < 0.001 ? 'bg-indigo-100 text-indigo-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {m.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">변동 폭</span>
            {SIGMA_OPTIONS.map((s) => (
              <Link
                key={s.v}
                href={buildHref(current, { sigma: String(s.v) })}
                className={`px-2 py-1 text-xs rounded ${Math.abs(validSigma - s.v) < 0.001 ? 'bg-indigo-100 text-indigo-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {s.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* 에러 */}
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_fx_margin_gate</code> / 뷰 <code>jimscanner_fx_margin_snapshot</code> 미적용 가능성.
            supabase/fx_margin_gate.sql 적용 필요.
          </p>
        </div>
      )}

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="후보 핀 수" value={gate.length} />
        <Kpi
          label={`마진 절벽 ≥ 10pp`}
          value={cliffOver10}
          highlight={cliffOver10 > 0}
        />
        <Kpi label="평균 절벽 (pp)" value={(avgCliff * 100).toFixed(2)} />
        <Kpi label="🟢 진입 윈도우" value={entryQueue.length} highlight={entryQueue.length > 0} />
      </section>

      {/* (1) 핀×통화 마진 민감도 매트릭스 — 통화별 σ·current·favor */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold text-gray-800">
          📊 통화별 30일 변동성 스냅샷
        </h2>
        <div className="rounded border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-3 py-2 text-xs font-semibold text-gray-600 uppercase">통화</th>
                <th className="text-right px-3 py-2 text-xs font-semibold text-gray-600 uppercase">현재</th>
                <th className="text-right px-3 py-2 text-xs font-semibold text-gray-600 uppercase">avg(30d)</th>
                <th className="text-right px-3 py-2 text-xs font-semibold text-gray-600 uppercase">σ(30d)</th>
                <th className="text-right px-3 py-2 text-xs font-semibold text-gray-600 uppercase">CV %</th>
                <th className="text-right px-3 py-2 text-xs font-semibold text-gray-600 uppercase">min~max</th>
                <th className="text-right px-3 py-2 text-xs font-semibold text-gray-600 uppercase">FX favor</th>
                <th className="text-left px-3 py-2 text-xs font-semibold text-gray-600 uppercase">시그널</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-gray-500 text-xs">
                    환율 히스토리 누적 부족. <code>jimscanner_exchange_rate_history</code> 가 비었거나
                    뷰가 미적용 상태.
                  </td>
                </tr>
              ) : (
                snapshot.map((s) => {
                  const fav = s.fx_favor_score
                  const badge: GateRow['fx_badge'] =
                    s.sigma_30d === 0 ? 'gray' : fav >= 0.5 ? 'green' : fav <= -0.5 ? 'red' : 'yellow'
                  return (
                    <tr key={s.currency} className="border-b last:border-b-0">
                      <td className="px-3 py-2 font-semibold">{s.currency}</td>
                      <td className="px-3 py-2 text-right font-mono">
                        {s.current_rate != null ? s.current_rate.toFixed(2) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-gray-600">
                        {s.avg_30d.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-gray-600">
                        ±{s.sigma_30d.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-gray-600">
                        {s.cv_pct.toFixed(2)}%
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-gray-500">
                        {s.min_30d.toFixed(2)} ~ {s.max_30d.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-bold">
                        {fav >= 0 ? '+' : ''}{fav.toFixed(2)}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-block px-2 py-0.5 rounded border text-xs ${badgeStyle(badge)}`}>
                          {badgeIcon(badge)}
                        </span>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* (2) 환율 트렌드 vs 도매가 디커플링 — 30/90일 스파크라인 */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold text-gray-800">
          📈 환율 트렌드 (최근 90일)
          <span className="text-xs font-normal text-gray-500 ml-2">
            ggsan 도매가는 KRW 고정 표기라 환율 변동분이 그대로 마진에 전이됩니다.
          </span>
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {CURRENCY_OPTIONS.map((c) => {
            const series = histByCurrency.get(c.v) ?? []
            const points = series.map((s) => Number(s.rate_krw))
            const first = points[0]
            const last = points[points.length - 1]
            const deltaPct = first && last ? ((last - first) / first) * 100 : 0
            const up = deltaPct > 0
            return (
              <div
                key={c.v}
                className={`rounded border px-4 py-3 ${
                  currency === c.v ? 'border-indigo-300 bg-indigo-50/40' : 'border-gray-200'
                }`}
              >
                <div className="flex items-baseline justify-between mb-1">
                  <div className="text-sm font-semibold">{c.label}</div>
                  <div className={`text-xs font-mono ${up ? 'text-red-600' : 'text-blue-600'}`}>
                    90d {up ? '▲' : '▼'} {deltaPct.toFixed(2)}%
                  </div>
                </div>
                <div className={up ? 'text-red-500' : 'text-blue-500'}>
                  <Sparkline points={points} />
                </div>
                <div className="text-[10px] text-gray-400 mt-1 font-mono">
                  {series.length > 0 && (
                    <>
                      {series[0].rate_date} → {series[series.length - 1].rate_date} · n={series.length}
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {/* (3) 진입 윈도우 큐 — fx_badge=green */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold text-gray-800">
          🟢 진입 윈도우 큐
          <span className="text-xs font-normal text-gray-500 ml-2">
            현재 {currency} 가 30일 평균보다 σ/2 이상 낮음 — 우호 구간
          </span>
        </h2>
        {entryQueue.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-8 text-center text-gray-500 text-sm">
            우호 구간 핀 없음. {currency} 가 평균 환율 이하로 내려갈 때까지 대기.
          </div>
        ) : (
          <div className="space-y-2">
            {entryQueue.map((r, i) => (
              <FxPinRow key={r.goods_no} row={r} rank={i + 1} marginPct={validMargin} />
            ))}
          </div>
        )}
      </section>

      {/* (4) 보류 권장 큐 */}
      {holdQueue.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-gray-800">
            🔴 보류 권장 큐
            <span className="text-xs font-normal text-gray-500 ml-2">
              {currency} 가 평균 환율보다 σ/2 이상 높음 — 진입 시 절벽 위험
            </span>
          </h2>
          <div className="space-y-2">
            {holdQueue.map((r, i) => (
              <FxPinRow key={r.goods_no} row={r} rank={i + 1} marginPct={validMargin} />
            ))}
          </div>
        </section>
      )}

      {/* 공식 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 FX Margin Gate 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          worst_case_rate = current_rate + sigma_mult × σ_30d<br />
          best_case_rate  = current_rate − sigma_mult × σ_30d<br />
          margin_under_worst = 1 − (1 − m) × (worst_case_rate / current_rate)<br />
          margin_cliff_pct   = m − margin_under_worst   (positive = 마진 손실 pp)<br />
          fx_favor_score = (avg_30d − current_rate) / σ_30d<br />
          fx_badge = score≥+0.5 → 🟢 · |score|&lt;0.5 → 🟡 · score≤−0.5 → 🔴
        </code>
        <div className="pt-2">
          <strong>V1 보강 예정:</strong> 핀별 원가 통화 LLM 태깅 · 카테고리별 통화 비중 가중평균
          · 환율 시계열 ARIMA 단기 예보 · 마진 절벽 ≥ 임계치 핀에 자동 핀 토글
        </div>
      </section>
    </div>
  )
}

function FxPinRow({
  row,
  rank,
  marginPct,
}: {
  row: GateRow
  rank: number
  marginPct: number
}) {
  const cliffPp = row.margin_cliff_pct * 100
  const worstPp = row.margin_under_worst * 100
  const bestPp = row.margin_under_best * 100
  const basePp = marginPct * 100
  return (
    <a
      href={row.detail_url ?? '#'}
      target="_blank"
      rel="noopener"
      className={`block rounded border px-3 py-2 hover:shadow-sm transition-all ${
        row.fx_badge === 'green'
          ? 'border-green-200 bg-green-50/40 hover:bg-green-50'
          : row.fx_badge === 'red'
            ? 'border-red-200 bg-red-50/40 hover:bg-red-50'
            : 'border-gray-200 hover:bg-gray-50'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="w-8 text-center text-sm font-mono text-gray-400 pt-1">{rank}</div>
        <div className="w-16 h-16 bg-gray-100 rounded overflow-hidden flex-shrink-0 relative">
          {row.image_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={row.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
          )}
          {row.is_imminent && (
            <span className="absolute top-0 left-0 bg-red-600 text-white text-[9px] px-1 leading-tight rounded-br">
              임박
            </span>
          )}
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="text-sm font-medium leading-snug truncate" title={row.title}>
            {row.title}
          </div>
          <div className="text-xs text-gray-500">
            {row.cate_label ?? row.cate_cd} · {row.goods_no}
          </div>
          <div className="flex flex-wrap gap-2 text-xs pt-1">
            <span className={`px-2 py-0.5 rounded border ${badgeStyle(row.fx_badge)}`}>
              {badgeIcon(row.fx_badge)} (score {row.fx_favor_score >= 0 ? '+' : ''}
              {row.fx_favor_score.toFixed(2)})
            </span>
            <span className="bg-gray-100 text-gray-700 px-2 py-0.5 rounded">
              {row.source_currency} 현재 {row.current_rate.toFixed(2)} · σ ±{row.sigma_30d.toFixed(2)}
            </span>
          </div>
        </div>
        <div className="text-right flex-shrink-0 space-y-0.5 min-w-[180px]">
          <div className="text-sm font-bold">
            {row.price_krw ? `${row.price_krw.toLocaleString()}원` : '가격 X'}
          </div>
          <div className="text-[10px] text-gray-500 font-mono">기본 마진 {basePp.toFixed(1)}pp</div>
          <div className="text-[11px] font-mono">
            <span className="text-blue-600">best {bestPp.toFixed(1)}pp</span>
            {' · '}
            <span className={`font-bold ${cliffPp >= 10 ? 'text-red-700' : 'text-red-500'}`}>
              worst {worstPp.toFixed(1)}pp
            </span>
          </div>
          <div
            className={`text-xs font-mono font-bold ${
              cliffPp >= 10 ? 'text-red-700' : cliffPp >= 5 ? 'text-amber-700' : 'text-gray-600'
            }`}
          >
            절벽 {cliffPp >= 0 ? '−' : '+'}
            {Math.abs(cliffPp).toFixed(2)}pp
          </div>
        </div>
      </div>
    </a>
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
    <div className={`rounded border p-3 ${highlight ? 'border-indigo-300 bg-indigo-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-indigo-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
