import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface RepurchaseRow {
  product_id: string
  title: string
  category_top: string
  category_mid: string | null
  brand: string | null
  intent_label: string | null
  cycle_days: number | null
  acf_peak: number | null
  confidence: number | null
  repurchase_index: number | null
  ltv_score: number | null
  acf_peaks: Array<{ lag: number; value: number }> | null
  series_length: number | null
  avg_volume: number | null
  computed_at: string | null
}

const CYCLE_BUCKETS: { v: string; label: string; lo: number; hi: number }[] = [
  { v: 'all', label: '전체', lo: 0, hi: 9999 },
  { v: 'week', label: '주 단위 (5~9일)', lo: 5, hi: 9 },
  { v: 'biweek', label: '격주 (10~17일)', lo: 10, hi: 17 },
  { v: 'month', label: '월 단위 (21~35일)', lo: 21, hi: 35 },
]

async function fetchRows(opts: { cate: string; bucket: string }) {
  const sb = createAdminClient()
  // 뷰는 generated types 미반영 — `npm run gen:types` 시 캐스팅 제거
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = (sb as any)
    .from('jimscanner_trends_repurchase')
    .select(
      'product_id, title, category_top, category_mid, brand, intent_label, cycle_days, acf_peak, confidence, repurchase_index, ltv_score, acf_peaks, series_length, avg_volume, computed_at',
    )
    .order('ltv_score', { ascending: false, nullsFirst: false })
    .limit(300)

  if (opts.cate && opts.cate !== 'all') {
    query = query.eq('category_top', opts.cate)
  }
  const bucket = CYCLE_BUCKETS.find((b) => b.v === opts.bucket) ?? CYCLE_BUCKETS[0]
  if (bucket.v !== 'all') {
    query = query.gte('cycle_days', bucket.lo).lte('cycle_days', bucket.hi)
  }

  const { data, error } = await query
  if (error) return { rows: [] as RepurchaseRow[], error: error.message }
  return { rows: (data ?? []) as RepurchaseRow[], error: null as string | null }
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
  return '/admin/trend-radar/repurchase' + (qs ? `?${qs}` : '')
}

export default async function RepurchasePage({
  searchParams,
}: {
  searchParams: Promise<{ cate?: string; bucket?: string; sel?: string }>
}) {
  const sp = await searchParams
  const cate = sp.cate ?? 'all'
  const bucket = sp.bucket ?? 'all'
  const sel = sp.sel ?? ''

  const current: Record<string, string> = { cate, bucket, sel }
  const { rows, error } = await fetchRows({ cate, bucket })

  // 카테고리 옵션 (분포 상위)
  const cateSet = new Map<string, number>()
  for (const r of rows) {
    cateSet.set(r.category_top, (cateSet.get(r.category_top) ?? 0) + 1)
  }
  const cateOptions = ['all', ...Array.from(cateSet.keys()).sort()]

  // KPI
  const total = rows.length
  const withCycle = rows.filter((r) => r.cycle_days != null).length
  const weekly = rows.filter((r) => (r.cycle_days ?? 0) >= 5 && (r.cycle_days ?? 0) <= 9).length
  const monthly = rows.filter((r) => (r.cycle_days ?? 0) >= 21 && (r.cycle_days ?? 0) <= 35).length
  const avgLtv =
    rows.length > 0
      ? rows.reduce((s, r) => s + Number(r.ltv_score ?? 0), 0) / rows.length
      : 0

  // 산점도: 가로 cycle_days (0~35), 세로 avg_volume (log scale)
  const scatterRows = rows.filter((r) => r.cycle_days != null && (r.avg_volume ?? 0) > 0)
  const maxVol = Math.max(1, ...scatterRows.map((r) => r.avg_volume ?? 0))
  const minVol = Math.max(0.1, Math.min(...scatterRows.map((r) => r.avg_volume ?? 0.1)))

  const selRow = sel ? rows.find((r) => r.product_id === sel) ?? null : null

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🔄 재구매 주기 분석</h1>
          <p className="text-sm text-gray-500 mt-1">
            ACF/FFT 자기상관 분석으로 주·월 단위 반복 수요(소모품) 후보를 사전 선별
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <strong>읽는 법</strong> · cycle_days = 시계열 자기상관 1위 peak 의 lag (일). acf_peak ≥
        0.4 + confidence ≥ 0.5 면 신뢰할 만한 반복. LTV = (연 반복 횟수 / 52) × 0.6 + 재구매성지수 ×
        0.4. 일회성 트렌드(cycle null)는 자동 제외.
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-gray-500">주기 버킷</span>
          {CYCLE_BUCKETS.map((b) => (
            <Link
              key={b.v}
              href={buildHref(current, { bucket: b.v, sel: null })}
              className={`px-2 py-1 text-xs rounded ${
                bucket === b.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'
              }`}
            >
              {b.label}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 border-t border-gray-100 pt-2">
          <span className="text-xs text-gray-500 mr-1">카테고리</span>
          {cateOptions.map((c) => (
            <Link
              key={c}
              href={buildHref(current, { cate: c, sel: null })}
              className={`px-2 py-1 text-xs rounded ${
                cate === c ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'
              }`}
            >
              {c === 'all' ? '전체' : c}
              {c !== 'all' && cateSet.get(c) ? ` (${cateSet.get(c)})` : ''}
            </Link>
          ))}
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="후보 상품" value={total} />
        <Kpi label="주기 탐지됨" value={withCycle} />
        <Kpi label="🗓 주 단위" value={weekly} highlight={weekly > 0} />
        <Kpi label="📅 월 단위" value={monthly} highlight={monthly > 0} />
        <Kpi label="평균 LTV" value={avgLtv.toFixed(1)} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          DB 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            뷰 <code>jimscanner_trends_repurchase</code> 미적용 가능성. supabase/trends_v4_repurchase.sql
            적용 + scripts/compute-repurchase-cycle.mjs 1회 실행 필요.
          </p>
        </div>
      )}

      {/* 산점도 */}
      {scatterRows.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-2">
            주기일수 × 검색량 산점도 ({scatterRows.length})
          </h2>
          <Scatter rows={scatterRows} maxVol={maxVol} minVol={minVol} current={current} sel={sel} />
        </section>
      )}

      {/* 선택된 상품 ACF 막대 */}
      {selRow && (
        <section className="rounded border border-amber-300 bg-amber-50/50 p-4 space-y-3">
          <div className="flex items-baseline justify-between">
            <div>
              <h2 className="text-base font-semibold">{selRow.title}</h2>
              <p className="text-xs text-gray-600 mt-0.5">
                {selRow.category_top}
                {selRow.category_mid ? ` / ${selRow.category_mid}` : ''} · cycle {selRow.cycle_days}일 ·
                acf_peak {Number(selRow.acf_peak ?? 0).toFixed(3)} · 신뢰도{' '}
                {Number(selRow.confidence ?? 0).toFixed(2)}
              </p>
            </div>
            <Link
              href={buildHref(current, { sel: null })}
              className="text-xs text-gray-500 hover:text-black"
            >
              닫기 ×
            </Link>
          </div>
          <AcfBars peaks={selRow.acf_peaks ?? []} />
          <div className="text-xs text-gray-500">
            series_length {selRow.series_length} · avg_volume {Number(selRow.avg_volume ?? 0).toFixed(1)} ·
            computed {selRow.computed_at?.slice(0, 19).replace('T', ' ')}
          </div>
        </section>
      )}

      {/* 카테고리별 상위 SKU 랭킹 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">카테고리별 재구매성 상위 ({rows.length})</h2>
        {rows.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-8 text-center text-gray-500 text-sm">
            조건에 맞는 후보 없음 — 시계열이 더 누적되어야 정확.
          </div>
        ) : (
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">상품</th>
                  <th className="px-3 py-2 text-left">카테고리</th>
                  <th className="px-3 py-2 text-right">주기</th>
                  <th className="px-3 py-2 text-right">ACF</th>
                  <th className="px-3 py-2 text-right">신뢰도</th>
                  <th className="px-3 py-2 text-right">재구매지수</th>
                  <th className="px-3 py-2 text-right">LTV</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => (
                  <tr
                    key={r.product_id}
                    className={`hover:bg-amber-50/40 ${sel === r.product_id ? 'bg-amber-50' : ''}`}
                  >
                    <td className="px-3 py-2">
                      <Link
                        href={buildHref(current, { sel: r.product_id })}
                        className="font-medium hover:underline"
                      >
                        {r.title}
                      </Link>
                      {r.intent_label && (
                        <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                          {r.intent_label}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      {r.category_top}
                      {r.category_mid ? ` / ${r.category_mid}` : ''}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {r.cycle_days != null ? (
                        <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-800">
                          {r.cycle_days}일
                        </span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {Number(r.acf_peak ?? 0).toFixed(3)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {Number(r.confidence ?? 0).toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {Number(r.repurchase_index ?? 0).toFixed(1)}
                    </td>
                    <td className="px-3 py-2 text-right font-bold text-amber-700 font-mono">
                      {Number(r.ltv_score ?? 0).toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 산출 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          acf[lag] = Σ (x_i − x̄)(x_{`{i+lag}`} − x̄) / Σ (x_i − x̄)²
          <br />
          cycle_days = argmax_{`{lag≥2}`} acf[lag] (양옆보다 큰 peak)
          <br />
          confidence = 0.5·acf_peak + 0.3·시계열 충만도 + 0.2·SNR(1위-2위)
          <br />
          repurchase_index = acf_peak × confidence × log₁₀(avg_volume+1) / 2 · 100
          <br />
          ltv_score = 0.6·(min(52, 365/cycle)/52) + 0.4·(repurchase_index/100) · 100
        </code>
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
    <div className={`rounded border p-3 ${highlight ? 'border-amber-300 bg-amber-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-amber-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}

function Scatter({
  rows,
  maxVol,
  minVol,
  current,
  sel,
}: {
  rows: RepurchaseRow[]
  maxVol: number
  minVol: number
  current: Record<string, string>
  sel: string
}) {
  const W = 720
  const H = 280
  const padL = 40
  const padR = 16
  const padT = 16
  const padB = 32
  const xMax = 35
  const innerW = W - padL - padR
  const innerH = H - padT - padB

  const logMin = Math.log10(minVol + 1)
  const logMax = Math.log10(maxVol + 1)
  const span = Math.max(0.01, logMax - logMin)

  function buildScatterHref(productId: string) {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(current)) if (v && k !== 'sel') params.set(k, v)
    params.set('sel', productId)
    return '/admin/trend-radar/repurchase?' + params.toString()
  }

  return (
    <div className="rounded border border-gray-200 p-3 overflow-x-auto">
      <svg width={W} height={H} className="block">
        {/* axis */}
        <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="#d4d4d4" />
        <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="#d4d4d4" />
        {/* x ticks */}
        {[7, 14, 21, 28, 35].map((t) => {
          const x = padL + (t / xMax) * innerW
          return (
            <g key={t}>
              <line x1={x} y1={H - padB} x2={x} y2={H - padB + 4} stroke="#9ca3af" />
              <text x={x} y={H - padB + 16} fontSize="10" fill="#6b7280" textAnchor="middle">
                {t}일
              </text>
              <line x1={x} y1={padT} x2={x} y2={H - padB} stroke="#f3f4f6" strokeDasharray="2,2" />
            </g>
          )
        })}
        <text x={padL + innerW / 2} y={H - 4} fontSize="10" fill="#374151" textAnchor="middle">
          cycle_days (lag)
        </text>
        <text
          x={12}
          y={padT + innerH / 2}
          fontSize="10"
          fill="#374151"
          textAnchor="middle"
          transform={`rotate(-90 12 ${padT + innerH / 2})`}
        >
          log(avg_volume)
        </text>

        {/* points */}
        {rows.map((r) => {
          const lag = Math.min(xMax, r.cycle_days ?? 0)
          const vol = r.avg_volume ?? 0.1
          const x = padL + (lag / xMax) * innerW
          const y = padT + innerH - ((Math.log10(vol + 1) - logMin) / span) * innerH
          const radius = 3 + clamp01(Number(r.acf_peak ?? 0)) * 6
          const selected = sel === r.product_id
          return (
            <a key={r.product_id} href={buildScatterHref(r.product_id)}>
              <circle
                cx={x}
                cy={y}
                r={radius}
                fill={selected ? '#d97706' : '#fbbf24'}
                fillOpacity={selected ? 0.95 : 0.5}
                stroke={selected ? '#92400e' : '#f59e0b'}
                strokeWidth={selected ? 2 : 1}
              >
                <title>
                  {r.title} · cycle {r.cycle_days}일 · vol {Number(r.avg_volume ?? 0).toFixed(1)} · LTV{' '}
                  {Number(r.ltv_score ?? 0).toFixed(1)}
                </title>
              </circle>
            </a>
          )
        })}
      </svg>
      <div className="text-[10px] text-gray-500 mt-1">
        원 크기 = ACF peak 강도 · 색 진하기 = 선택 강조. 클릭 → ACF 막대 펼침.
      </div>
    </div>
  )
}

function AcfBars({ peaks }: { peaks: Array<{ lag: number; value: number }> }) {
  if (peaks.length === 0) {
    return <div className="text-xs text-gray-500">peak 없음 (일회성 또는 노이즈)</div>
  }
  const maxV = Math.max(...peaks.map((p) => p.value), 0.0001)
  return (
    <div className="space-y-1">
      <div className="text-xs text-gray-600 font-semibold">ACF 상위 {peaks.length} peak</div>
      {peaks.map((p, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <span className="w-16 font-mono text-gray-700">lag {p.lag}일</span>
          <div className="flex-1 bg-gray-100 h-4 rounded overflow-hidden">
            <div
              className={`h-full ${i === 0 ? 'bg-amber-500' : 'bg-amber-300'}`}
              style={{ width: `${(p.value / maxV) * 100}%` }}
            />
          </div>
          <span className="w-14 text-right font-mono text-gray-700">{p.value.toFixed(3)}</span>
        </div>
      ))}
    </div>
  )
}

function clamp01(x: number) {
  if (Number.isNaN(x) || !Number.isFinite(x)) return 0
  return Math.max(0, Math.min(1, x))
}
