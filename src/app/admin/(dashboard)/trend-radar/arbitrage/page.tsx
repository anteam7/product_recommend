import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface ChannelEntry {
  channel: string
  price: number
  normalized_unit_price: number
  url: string | null
  image_url: string | null
  fetched_at: string
  moq: number | null
}

interface DispersionRow {
  product_id: string
  canonical_name: string
  category_top: string | null
  brand: string | null
  channels: ChannelEntry[]
  channel_count: number
  min_price: number
  max_price: number
  mean_price: number
  stddev_price: number
  cv: number
  gap_pct: number
  est_margin_krw: number
  est_margin_pct: number
  best_buy_channel: string
  best_sell_channel: string
}

const CV_OPTIONS = [
  { v: 0.05, label: '0.05 (느슨)' },
  { v: 0.1, label: '0.10 (기본)' },
  { v: 0.2, label: '0.20 (강함)' },
  { v: 0.4, label: '0.40 (극단)' },
] as const

const TOP_OPTIONS = [
  { v: 30, label: '30' },
  { v: 50, label: '50 (기본)' },
  { v: 100, label: '100' },
] as const

function channelLabel(c: string): string {
  switch (c) {
    case 'ggsan': return '🏬 ggsan'
    case 'aliexpress':
    case 'aliex_best': return '🅰 알리'
    case 'domeggook':
    case 'domeggook_main': return '🅳 도매꾹'
    case 'musinsa_best': return '🅼 무신사'
    case 'naver_shopping_hot': return '🛍 네이버'
    case '1688': return '🇨🇳 1688'
    case 'temu': return '🛒 테무'
    case 'ownerclan': return '📦 오너클랜'
    default: return c
  }
}

function channelColor(c: string): string {
  switch (c) {
    case 'ggsan': return 'bg-amber-100 text-amber-800'
    case 'aliexpress':
    case 'aliex_best': return 'bg-orange-100 text-orange-800'
    case 'domeggook':
    case 'domeggook_main': return 'bg-purple-100 text-purple-800'
    case 'musinsa_best': return 'bg-zinc-200 text-zinc-800'
    case 'naver_shopping_hot': return 'bg-green-100 text-green-800'
    case '1688': return 'bg-red-100 text-red-800'
    default: return 'bg-gray-100 text-gray-700'
  }
}

async function fetchDispersion(opts: { topN: number; minCv: number }) {
  const sb = createAdminClient()
  // RPC 는 supabase/price_dispersion.sql 에 정의. generated 타입 미반영 — `npm run gen:types` 시 캐스팅 제거
  const { data, error } = await sb.rpc('rpc_jimscanner_price_dispersion' as never, {
    top_n: opts.topN,
    min_cv: opts.minCv,
  } as never)
  if (error) {
    return { rows: [] as DispersionRow[], error: error.message }
  }
  return { rows: (data ?? []) as DispersionRow[], error: null as string | null }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/arbitrage' + (qs ? `?${qs}` : '')
}

export default async function ArbitragePage({
  searchParams,
}: {
  searchParams: Promise<{ top?: string; cv?: string }>
}) {
  const sp = await searchParams
  const topN = parseInt(sp.top ?? '50', 10)
  const validTop = TOP_OPTIONS.some((o) => o.v === topN) ? topN : 50
  const minCv = parseFloat(sp.cv ?? '0.10')
  const validCv = CV_OPTIONS.some((o) => Math.abs(o.v - minCv) < 0.001) ? minCv : 0.1

  const current: Record<string, string> = {
    top: String(validTop),
    cv: String(validCv),
  }

  const { rows, error } = await fetchDispersion({ topN: validTop, minCv: validCv })

  const total = rows.length
  const avgCv = rows.length > 0 ? rows.reduce((s, r) => s + Number(r.cv), 0) / rows.length : 0
  const profitable = rows.filter((r) => Number(r.est_margin_krw) > 0).length
  const totalMargin = rows.reduce((s, r) => s + Number(r.est_margin_krw), 0)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">💱 멀티채널 가격분산 차익 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            ggsan · aliex · domeggook · 1688 · musinsa · naver 채널 가격 사다리 + CV + 실현 마진
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900">
        <strong>읽는 법</strong> · CV(분산계수) = stddev/mean. 클수록 채널 간 가격 흩어짐 큼 = 차익 기회.
        실현 마진 = (최고가 × 0.88) − 최저가 − 3,000원 (수수료 12% + 배송 3k 가정). MOQ 있으면 단가로 정규화.
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">최소 CV</span>
            {CV_OPTIONS.map((o) => (
              <Link
                key={o.v}
                href={buildHref(current, { cv: String(o.v) })}
                className={`px-2 py-1 text-xs rounded ${Math.abs(validCv - o.v) < 0.001 ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {o.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">상위</span>
            {TOP_OPTIONS.map((o) => (
              <Link
                key={o.v}
                href={buildHref(current, { top: String(o.v) })}
                className={`px-2 py-1 text-xs rounded ${validTop === o.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {o.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="후보 상품" value={total} />
        <Kpi label="평균 CV" value={avgCv.toFixed(3)} />
        <Kpi label="흑자 가능" value={profitable} highlight={profitable > 0} />
        <Kpi label="합산 마진 (원)" value={Math.round(totalMargin).toLocaleString()} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>rpc_jimscanner_price_dispersion</code> / VIEW{' '}
            <code>jimscanner_price_dispersion</code> 가 DB 에 적용 안 됐을 가능성.{' '}
            <code>supabase/price_dispersion.sql</code> 적용 필요.
          </p>
        </div>
      )}

      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">조건에 맞는 차익 후보 없음</div>
          <div className="text-xs text-gray-400">
            데이터 부족 가능성: 1) <code>jimscanner_trends_supplier</code> 가 비어있거나 2채널 미만 ·
            2) ggsan alias 미매핑.
            <br />
            CV 0.05 로 낮추거나 alias 매핑(#12) 진행 후 재시도.
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <ArbitrageCard key={r.product_id} row={r} />
          ))}
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          CV = stddev_pop(normalized_unit_price) / mean(normalized_unit_price)
          <br />
          gap_pct = (max − min) / min × 100
          <br />
          est_margin_krw = max × (1 − 0.12) − min − 3000   {/* 수수료 + 배송 */}
          <br />
          normalized_unit_price = MOQ 가 있으면 price / MOQ, 없으면 price
        </code>
        <div className="pt-2">
          <strong>한계:</strong> alias(#12) · vision twin(#11) 미매핑 SKU 는 채널 1개로 잡혀 CV 계산 X.
          매핑 풍부해질수록 후보 풍부해짐.
        </div>
      </section>
    </div>
  )
}

function ArbitrageCard({ row }: { row: DispersionRow }) {
  const cv = Number(row.cv)
  const margin = Number(row.est_margin_krw)
  const gap = Number(row.gap_pct)
  const marginPct = Number(row.est_margin_pct)
  const channels = Array.isArray(row.channels) ? row.channels : []
  // 사다리: 정렬된 채널들
  const sorted = [...channels].sort(
    (a, b) => Number(a.normalized_unit_price) - Number(b.normalized_unit_price),
  )
  const min = Number(row.min_price)
  const max = Number(row.max_price)
  const range = Math.max(1, max - min)

  return (
    <div
      className={`rounded border overflow-hidden ${
        margin > 0 ? 'border-emerald-200 bg-emerald-50/30' : 'border-gray-200'
      }`}
    >
      <div className="grid md:grid-cols-[1fr_1.2fr_220px] gap-4 p-4">
        {/* 좌측: 메타 + 채널 칩 */}
        <div className="space-y-2 min-w-0">
          <div className="text-sm font-semibold leading-snug" title={row.canonical_name}>
            {row.canonical_name}
          </div>
          <div className="text-xs text-gray-500">
            {row.category_top ?? '?'}{row.brand ? ` · ${row.brand}` : ''} · 채널 {row.channel_count}개
          </div>
          <div className="flex flex-wrap gap-1 pt-1">
            {sorted.map((c, i) => (
              <a
                key={`${c.channel}-${i}`}
                href={c.url ?? '#'}
                target="_blank"
                rel="noopener"
                className={`px-2 py-0.5 text-[11px] rounded font-mono ${channelColor(c.channel)} hover:opacity-80`}
                title={`MOQ ${c.moq ?? '-'} · ${new Date(c.fetched_at).toLocaleDateString()}`}
              >
                {channelLabel(c.channel)} {Math.round(Number(c.normalized_unit_price)).toLocaleString()}원
              </a>
            ))}
          </div>
        </div>

        {/* 가운데: 가격 사다리 */}
        <div className="space-y-1.5">
          <div className="text-[11px] text-gray-500 flex justify-between">
            <span>최저 {Math.round(min).toLocaleString()}원 ({channelLabel(row.best_buy_channel)})</span>
            <span>최고 {Math.round(max).toLocaleString()}원 ({channelLabel(row.best_sell_channel)})</span>
          </div>
          <div className="space-y-1">
            {sorted.map((c, i) => {
              const p = Number(c.normalized_unit_price)
              const widthPct = ((p - min) / range) * 100
              return (
                <div key={`bar-${i}`} className="flex items-center gap-2">
                  <span className="text-[10px] text-gray-500 w-20 truncate">{channelLabel(c.channel)}</span>
                  <div className="flex-1 h-3 bg-gray-100 rounded overflow-hidden relative">
                    <div
                      className={`h-full ${i === 0 ? 'bg-emerald-500' : i === sorted.length - 1 ? 'bg-red-500' : 'bg-amber-400'}`}
                      style={{ width: `${Math.max(2, widthPct)}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-mono text-gray-700 w-16 text-right">
                    {Math.round(p).toLocaleString()}
                  </span>
                </div>
              )
            })}
          </div>
          <div className="text-[10px] text-gray-400 pt-1">갭 {gap.toFixed(1)}%</div>
        </div>

        {/* 우측: CV / 마진 게이지 */}
        <div className="space-y-2 text-right">
          <Gauge label="CV (분산)" value={cv} max={0.6} format={(v) => v.toFixed(3)} />
          <Gauge
            label="실현 마진"
            value={Math.max(0, marginPct)}
            max={100}
            format={(v) => `${Math.round(margin).toLocaleString()}원`}
            sub={`${marginPct.toFixed(1)}%`}
            color={margin > 0 ? 'bg-emerald-500' : 'bg-gray-300'}
          />
          <div className="text-[10px] text-gray-500 pt-1">
            진입가 추천 ≈ <strong className="text-amber-700">
              {Math.round((min + (max * 0.88)) / 2).toLocaleString()}원
            </strong>
          </div>
        </div>
      </div>
    </div>
  )
}

function Gauge({
  label,
  value,
  max,
  format,
  sub,
  color = 'bg-amber-500',
}: {
  label: string
  value: number
  max: number
  format: (v: number) => string
  sub?: string
  color?: string
}) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100))
  return (
    <div>
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className="text-sm font-mono font-semibold">{format(value)}</div>
      {sub && <div className="text-[10px] text-gray-400">{sub}</div>}
      <div className="h-1.5 bg-gray-100 rounded overflow-hidden mt-1">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
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
