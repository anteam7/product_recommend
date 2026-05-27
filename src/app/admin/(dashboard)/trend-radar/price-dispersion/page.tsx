import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface SpreadRow {
  sku_key: string
  marketplace_count: number
  min_price: number
  max_price: number
  mean_price: number
  median_price: number
  p25_price: number
  p75_price: number
  sd_price: number | null
  spread: number
  cov_pct: number
  spread_pct: number
  min_marketplace: string
  max_marketplace: string
  last_observed_at: string
  ggsan_goods_no: string | null
  ggsan_title?: string | null
  ggsan_wholesale_price?: number | null
  arbitrage_margin_pct?: number | null
  is_arbitrage_candidate?: boolean
}

const COV_OPTIONS = [
  { v: 0, label: '전체' },
  { v: 10, label: 'CoV ≥ 10%' },
  { v: 15, label: 'CoV ≥ 15% (기본)' },
  { v: 25, label: 'CoV ≥ 25%' },
] as const

const SPREAD_OPTIONS = [
  { v: 0, label: '전체' },
  { v: 10, label: 'spread ≥ 10%' },
  { v: 20, label: 'spread ≥ 20%' },
  { v: 30, label: 'spread ≥ 30%' },
] as const

const MARKETPLACE_LABEL: Record<string, string> = {
  coupang: '쿠팡',
  danawa: '다나와',
  '11st': '11번가',
  gmarket: 'G마켓',
  naver_smartstore: '스마트스토어',
  ggsan_wholesale: 'ggsan',
}

function fmtKRW(v: number | null | undefined): string {
  if (v == null) return '-'
  return `${Math.round(v).toLocaleString()}원`
}

function marketLabel(m: string | null | undefined): string {
  if (!m) return '-'
  return MARKETPLACE_LABEL[m] ?? m
}

async function fetchSpread(opts: { minCov: number; minSpread: number; arbitrageOnly: boolean }) {
  const sb = createAdminClient()
  // view 는 supabase/marketplace_prices.sql 적용 후 사용 가능. generated types 미반영.
  const { data, error } = await (sb as any)
    .from('jimscanner_marketplace_arbitrage')
    .select('*')
    .gte('cov_pct', opts.minCov)
    .gte('spread_pct', opts.minSpread)
    .order('spread_pct', { ascending: false })
    .limit(500)

  if (error) {
    return { rows: [] as SpreadRow[], error: error.message }
  }
  let rows = (data ?? []) as SpreadRow[]
  if (opts.arbitrageOnly) rows = rows.filter((r) => r.is_arbitrage_candidate)
  return { rows, error: null as string | null }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/price-dispersion' + (qs ? `?${qs}` : '')
}

export default async function PriceDispersionPage({
  searchParams,
}: {
  searchParams: Promise<{ cov?: string; spread?: string; arbitrage?: string }>
}) {
  const sp = await searchParams
  const cov = parseInt(sp.cov ?? '15', 10)
  const validCov = COV_OPTIONS.some((c) => c.v === cov) ? cov : 15
  const spread = parseInt(sp.spread ?? '0', 10)
  const validSpread = SPREAD_OPTIONS.some((s) => s.v === spread) ? spread : 0
  const arbitrageOnly = sp.arbitrage === '1'

  const current: Record<string, string> = {
    cov: String(validCov),
    spread: String(validSpread),
    arbitrage: arbitrageOnly ? '1' : '',
  }

  const { rows, error } = await fetchSpread({
    minCov: validCov,
    minSpread: validSpread,
    arbitrageOnly,
  })

  // KPI
  const total = rows.length
  const arbCount = rows.filter((r) => r.is_arbitrage_candidate).length
  const highCovCount = rows.filter((r) => r.cov_pct >= 15 && r.spread_pct >= 15).length
  const avgCov =
    rows.length > 0 ? rows.reduce((s, r) => s + Number(r.cov_pct), 0) / rows.length : 0
  const avgSpread =
    rows.length > 0 ? rows.reduce((s, r) => s + Number(r.spread_pct), 0) / rows.length : 0

  // 산점도 데이터 — x=median, y=CoV, 색=arbitrage 후보 여부
  const maxMedian = rows.length > 0 ? Math.max(...rows.map((r) => Number(r.median_price))) : 1
  const maxCov = rows.length > 0 ? Math.max(...rows.map((r) => Number(r.cov_pct)), 50) : 50

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">💱 멀티마켓 가격 분산 차익 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            동일 SKU 의 쿠팡 · 다나와 · 11번가 · G마켓 · 스마트스토어 가격 분산도 (CoV·spread) ·
            ggsan 도매가 ≤ 마켓 최저가 = 즉시 매입 후보
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 알림 */}
      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <strong>신호 임계</strong> · CoV ≥ 15% AND spread ≥ 마진손익분기(20%) →
        같은 SKU 인데 마켓 간 격차 충분히 큼. ggsan 도매가가 최저가 마켓보다 낮으면 즉시 위탁 후보로.
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 space-y-2">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">CoV</span>
            {COV_OPTIONS.map((c) => (
              <Link
                key={c.v}
                href={buildHref(current, { cov: String(c.v) })}
                className={`px-2 py-1 text-xs rounded ${
                  validCov === c.v
                    ? 'bg-amber-100 text-amber-700 font-semibold'
                    : 'text-gray-500 hover:text-black'
                }`}
              >
                {c.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">spread</span>
            {SPREAD_OPTIONS.map((s) => (
              <Link
                key={s.v}
                href={buildHref(current, { spread: String(s.v) })}
                className={`px-2 py-1 text-xs rounded ${
                  validSpread === s.v
                    ? 'bg-amber-100 text-amber-700 font-semibold'
                    : 'text-gray-500 hover:text-black'
                }`}
              >
                {s.label}
              </Link>
            ))}
          </div>
          <Link
            href={buildHref(current, { arbitrage: arbitrageOnly ? null : '1' })}
            className={`px-3 py-1 text-xs rounded ${
              arbitrageOnly
                ? 'bg-red-100 text-red-700 font-semibold'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {arbitrageOnly ? '✓ ' : ''}ggsan 차익 후보만
          </Link>
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="멀티마켓 SKU" value={total} />
        <Kpi label="🔥 차익 후보" value={arbCount} highlight={arbCount > 0} />
        <Kpi label="신호 조건 충족" value={highCovCount} />
        <Kpi label="평균 CoV%" value={avgCov.toFixed(1)} />
        <Kpi label="평균 spread%" value={avgSpread.toFixed(1)} />
      </section>

      {/* 에러 */}
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          DB 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            view <code>jimscanner_marketplace_arbitrage</code> 미적용 가능성. supabase/marketplace_prices.sql
            적용 필요.
          </p>
        </div>
      )}

      {/* 산점도 */}
      {!error && rows.length > 0 && (
        <section className="rounded border border-gray-200 p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-2">
            가격 분산 산점도{' '}
            <span className="text-xs font-normal text-gray-500">
              (x = 중앙가, y = CoV%, 빨강 = ggsan 차익 후보)
            </span>
          </h2>
          <ScatterPlot rows={rows} maxX={maxMedian} maxY={maxCov} />
        </section>
      )}

      {/* 표 */}
      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">조건 충족 SKU 없음</div>
          <div className="text-xs text-gray-400">
            적재 부족 가능성: 1) scripts/coupang-market-prices.mjs 미실행 ·
            2) 다나와 시장가 수집기 아직 도입 안 됨 · 3) 매칭(sku_key) 통합 키 미발급
            <br />
            CoV / spread 임계를 낮춰서 누적 데이터 점검.
          </div>
        </div>
      ) : (
        !error && (
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">#</th>
                  <th className="px-3 py-2 text-left">SKU / ggsan 상품</th>
                  <th className="px-3 py-2 text-right">마켓수</th>
                  <th className="px-3 py-2 text-right">최저가</th>
                  <th className="px-3 py-2 text-right">중앙가</th>
                  <th className="px-3 py-2 text-right">최고가</th>
                  <th className="px-3 py-2 text-right">spread%</th>
                  <th className="px-3 py-2 text-right">CoV%</th>
                  <th className="px-3 py-2 text-left">최저가 마켓</th>
                  <th className="px-3 py-2 text-left">최고가 마켓</th>
                  <th className="px-3 py-2 text-right">ggsan 도매</th>
                  <th className="px-3 py-2 text-right">예상마진%</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.slice(0, 200).map((r, i) => (
                  <tr
                    key={r.sku_key}
                    className={r.is_arbitrage_candidate ? 'bg-red-50/40' : ''}
                  >
                    <td className="px-3 py-2 text-gray-400 font-mono">{i + 1}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium truncate max-w-[280px]" title={r.ggsan_title ?? r.sku_key}>
                        {r.ggsan_title ?? r.sku_key}
                      </div>
                      {r.ggsan_goods_no && (
                        <div className="text-[10px] text-gray-400">ggsan #{r.ggsan_goods_no}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{r.marketplace_count}</td>
                    <td className="px-3 py-2 text-right font-mono">{fmtKRW(r.min_price)}</td>
                    <td className="px-3 py-2 text-right font-mono">{fmtKRW(r.median_price)}</td>
                    <td className="px-3 py-2 text-right font-mono">{fmtKRW(r.max_price)}</td>
                    <td className="px-3 py-2 text-right font-mono font-bold">
                      {Number(r.spread_pct).toFixed(1)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {Number(r.cov_pct).toFixed(1)}
                    </td>
                    <td className="px-3 py-2 text-blue-700">{marketLabel(r.min_marketplace)}</td>
                    <td className="px-3 py-2 text-red-700">{marketLabel(r.max_marketplace)}</td>
                    <td className="px-3 py-2 text-right font-mono">
                      {fmtKRW(r.ggsan_wholesale_price ?? null)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-mono ${
                        r.is_arbitrage_candidate ? 'text-red-700 font-bold' : 'text-gray-500'
                      }`}
                    >
                      {r.arbitrage_margin_pct != null
                        ? `${Number(r.arbitrage_margin_pct).toFixed(1)}%`
                        : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* 공식 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 분산도 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          effective_price = price + ship_fee (마켓·판매자별 1포인트, 자연 검색 상위 평균/최저가)
          <br />
          CoV% = (stddev(effective_price) / mean(effective_price)) × 100
          <br />
          spread% = ((max - min) / min) × 100
          <br />
          arbitrage_margin% = ((min_marketplace_price - ggsan_wholesale) / ggsan_wholesale) × 100
        </code>
        <div className="pt-2">
          <strong>V1 보강 예정:</strong> 일검색량 가중 점크기 · 카테고리별 색상 분리 · 핀 큐
          (jimscanner_trends_pins) 직접 추가 버튼 · 적재 cron job 상태 위젯
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
    <div className={`rounded border p-3 ${highlight ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-red-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}

function ScatterPlot({
  rows,
  maxX,
  maxY,
}: {
  rows: SpreadRow[]
  maxX: number
  maxY: number
}) {
  const W = 720
  const H = 280
  const PAD_L = 50
  const PAD_R = 12
  const PAD_T = 12
  const PAD_B = 30
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B

  const xOf = (v: number) => PAD_L + (Math.min(v, maxX) / Math.max(maxX, 1)) * innerW
  const yOf = (v: number) => PAD_T + innerH - (Math.min(v, maxY) / Math.max(maxY, 1)) * innerH

  // 임계선 (CoV 15%)
  const yThreshold = yOf(15)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      {/* 축 */}
      <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={PAD_T + innerH} stroke="#d1d5db" />
      <line x1={PAD_L} y1={PAD_T + innerH} x2={PAD_L + innerW} y2={PAD_T + innerH} stroke="#d1d5db" />
      {/* CoV=15% 임계선 */}
      <line
        x1={PAD_L}
        y1={yThreshold}
        x2={PAD_L + innerW}
        y2={yThreshold}
        stroke="#f59e0b"
        strokeDasharray="3 3"
      />
      <text x={PAD_L + innerW - 60} y={yThreshold - 4} fontSize="9" fill="#b45309">
        CoV 15% 임계
      </text>
      {/* y 라벨 */}
      <text x={6} y={PAD_T + 8} fontSize="9" fill="#6b7280">
        CoV%
      </text>
      <text x={6} y={PAD_T + innerH} fontSize="9" fill="#6b7280">
        0
      </text>
      <text x={6} y={PAD_T + 12} fontSize="9" fill="#6b7280">
        {Math.round(maxY)}
      </text>
      {/* x 라벨 */}
      <text x={PAD_L} y={H - 6} fontSize="9" fill="#6b7280">
        0원
      </text>
      <text x={PAD_L + innerW - 40} y={H - 6} fontSize="9" fill="#6b7280">
        {Math.round(maxX).toLocaleString()}원
      </text>
      <text x={PAD_L + innerW / 2 - 20} y={H - 6} fontSize="9" fill="#6b7280">
        중앙가 →
      </text>

      {/* 점 */}
      {rows.slice(0, 300).map((r) => {
        const cx = xOf(Number(r.median_price))
        const cy = yOf(Number(r.cov_pct))
        const arb = r.is_arbitrage_candidate
        return (
          <circle
            key={r.sku_key}
            cx={cx}
            cy={cy}
            r={arb ? 5 : 3}
            fill={arb ? '#dc2626' : '#3b82f6'}
            fillOpacity={arb ? 0.85 : 0.55}
          >
            <title>
              {r.ggsan_title ?? r.sku_key}
              {'\n'}중앙가 {fmtKRW(r.median_price)} · CoV {Number(r.cov_pct).toFixed(1)}% · spread{' '}
              {Number(r.spread_pct).toFixed(1)}%
              {'\n'}최저 {marketLabel(r.min_marketplace)} {fmtKRW(r.min_price)} → 최고{' '}
              {marketLabel(r.max_marketplace)} {fmtKRW(r.max_price)}
              {r.is_arbitrage_candidate
                ? `\n🔥 ggsan 도매 ${fmtKRW(r.ggsan_wholesale_price ?? null)} → 마진 ${Number(r.arbitrage_margin_pct ?? 0).toFixed(1)}%`
                : ''}
            </title>
          </circle>
        )
      })}
    </svg>
  )
}
