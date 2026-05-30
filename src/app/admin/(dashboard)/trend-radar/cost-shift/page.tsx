import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// jimscanner_ggsan_cost_shift 뷰 (supabase/ggsan_cost_shift.sql).
// 타입 미생성 — select 결과를 아래 인터페이스로 캐스팅한다(`as any` 경유).
interface CostShiftRow {
  goods_no: string
  title: string
  cate_label: string | null
  is_imminent: boolean
  last_changed_at: string
  cur_price: number
  cur_at: string
  prev_price: number
  prev_at: string
  price_delta: number
  price_delta_pct: number | null
  direction: 'drop' | 'rise'
  seller_product_id: string | null
  registered_title: string | null
  listing_status: string | null
  list_price_krw: number | null
  prev_margin_krw: number | null
  cur_margin_krw: number | null
  prev_margin_pct: number | null
  cur_margin_pct: number | null
  margin_delta_pct: number | null
  is_published: boolean
}

interface HistPoint {
  goods_no: string
  price_krw: number | null
  observed_at: string
}

const won = (n: number | null | undefined) => (n == null ? '–' : `${n.toLocaleString()}원`)
const pct = (n: number | null | undefined) => (n == null ? '–' : `${n > 0 ? '+' : ''}${n}%`)

async function fetchData() {
  const sb = createAdminClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rowsRaw } = await (sb as any)
    .from('jimscanner_ggsan_cost_shift')
    .select('*')
    .limit(500)
  const rows = (rowsRaw ?? []) as CostShiftRow[]

  // 스파크라인용 가격 시계열 (보이는 goods_no 한정)
  const goodsNos = rows.map((r) => r.goods_no)
  let hist: HistPoint[] = []
  if (goodsNos.length) {
    const { data: h } = await sb
      .from('jimscanner_ggsan_price_history')
      .select('goods_no, price_krw, observed_at')
      .in('goods_no', goodsNos)
      .order('observed_at', { ascending: true })
    hist = (h ?? []) as HistPoint[]
  }
  const histMap = new Map<string, number[]>()
  for (const p of hist) {
    if (p.price_krw == null) continue
    const arr = histMap.get(p.goods_no) ?? []
    arr.push(p.price_krw)
    histMap.set(p.goods_no, arr)
  }
  return { rows, histMap }
}

/** 서버 렌더 인라인 SVG 스파크라인 — 의존성 없음 */
function Sparkline({ series, color }: { series: number[]; color: string }) {
  const w = 96
  const h = 28
  if (!series || series.length < 2) {
    return <div className="text-[10px] text-gray-300">시계열 부족</div>
  }
  const min = Math.min(...series)
  const max = Math.max(...series)
  const span = max - min || 1
  const step = w / (series.length - 1)
  const pts = series
    .map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`)
    .join(' ')
  const last = series[series.length - 1]
  const cx = w
  const cy = h - ((last - min) / span) * h
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
      <circle cx={cx} cy={cy} r={2.2} fill={color} />
    </svg>
  )
}

function freshness(lastChanged: string): { label: string; cls: string } {
  const days = (Date.now() - new Date(lastChanged).getTime()) / 86_400_000
  if (days < 1) return { label: '오늘', cls: 'bg-emerald-100 text-emerald-700' }
  if (days < 3) return { label: `${Math.floor(days)}일 전`, cls: 'bg-amber-100 text-amber-700' }
  return { label: `${Math.floor(days)}일 전`, cls: 'bg-gray-100 text-gray-500' }
}

function Row({ r, series }: { r: CostShiftRow; series: number[] }) {
  const drop = r.direction === 'drop'
  const color = drop ? '#16a34a' : '#dc2626'
  const fr = freshness(r.last_changed_at)
  return (
    <tr className="border-b border-gray-100 hover:bg-gray-50/60">
      <td className="px-3 py-2 align-top">
        <div className="font-medium text-sm leading-snug line-clamp-2 max-w-[20rem]" title={r.title}>
          {r.registered_title || r.title}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px]">
          <span className="text-gray-400 font-mono">{r.cate_label ?? r.goods_no}</span>
          {r.is_published ? (
            <span className="px-1 rounded bg-blue-50 text-blue-600">발행 {r.listing_status ?? ''}</span>
          ) : (
            <span className="px-1 rounded bg-gray-100 text-gray-400">미발행</span>
          )}
          {r.is_imminent && <span className="px-1 rounded bg-red-600 text-white">임박</span>}
          <span className={`px-1 rounded ${fr.cls}`}>{fr.label}</span>
        </div>
      </td>
      <td className="px-3 py-2 align-middle">
        <Sparkline series={series} color={color} />
      </td>
      <td className="px-3 py-2 align-middle text-right whitespace-nowrap text-sm tabular-nums">
        <div className="text-gray-400 line-through text-xs">{won(r.prev_price)}</div>
        <div className="font-semibold">{won(r.cur_price)}</div>
        <div className={drop ? 'text-emerald-600 text-xs' : 'text-red-600 text-xs'}>
          {drop ? '▼' : '▲'} {won(Math.abs(r.price_delta))} ({pct(r.price_delta_pct)})
        </div>
      </td>
      <td className="px-3 py-2 align-middle text-right whitespace-nowrap text-sm tabular-nums">
        {r.is_published ? (
          <>
            <div className="text-gray-400 text-xs">
              {won(r.prev_margin_krw)} · {pct(r.prev_margin_pct)}
            </div>
            <div className={(r.cur_margin_krw ?? 0) < 0 ? 'font-semibold text-red-600' : 'font-semibold'}>
              {won(r.cur_margin_krw)} · {pct(r.cur_margin_pct)}
            </div>
            <div className={drop ? 'text-emerald-600 text-xs' : 'text-red-600 text-xs'}>
              Δ마진 {pct(r.margin_delta_pct)}
            </div>
          </>
        ) : (
          <span className="text-xs text-gray-300">발행 시 산정</span>
        )}
      </td>
    </tr>
  )
}

function QueueTable({
  title,
  desc,
  rows,
  histMap,
  empty,
}: {
  title: string
  desc: string
  rows: CostShiftRow[]
  histMap: Map<string, number[]>
  empty: string
}) {
  return (
    <section className="rounded border border-gray-200">
      <header className="px-4 py-3 border-b border-gray-100">
        <h2 className="font-bold">{title} <span className="text-gray-400 font-normal text-sm">({rows.length})</span></h2>
        <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
      </header>
      {rows.length === 0 ? (
        <div className="p-8 text-center text-sm text-gray-400">{empty}</div>
      ) : (
        <table className="w-full text-left">
          <thead>
            <tr className="text-[11px] text-gray-400 border-b border-gray-100">
              <th className="px-3 py-2 font-medium">상품</th>
              <th className="px-3 py-2 font-medium">도매가 추이</th>
              <th className="px-3 py-2 font-medium text-right">도매가 변동</th>
              <th className="px-3 py-2 font-medium text-right">기대마진 (전→후)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={r.goods_no} r={r} series={histMap.get(r.goods_no) ?? []} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

export default async function CostShiftPage() {
  const { rows, histMap } = await fetchData()

  // 정렬: 발행 상품(영향 실재) 우선, 변동폭 큰 순
  const sortKey = (r: CostShiftRow) =>
    (r.is_published ? 1000 : 0) + Math.abs(r.margin_delta_pct ?? r.price_delta_pct ?? 0)
  const sorted = [...rows].sort((a, b) => sortKey(b) - sortKey(a))

  const drops = sorted.filter((r) => r.direction === 'drop')
  const rises = sorted.filter((r) => r.direction === 'rise')

  const publishedRises = rises.filter((r) => r.is_published)
  const flipped = publishedRises.filter((r) => (r.cur_margin_krw ?? 0) < 0)

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold">도매가 변동 → 마진 영향 보드</h1>
        <p className="text-sm text-gray-500 mt-1">
          ggsan 도매가 시계열의 최신 vs 직전 변동을 감지해, 발행 리스팅의 기대마진을
          쿠팡 공식(배송비 3,000 · 수수료 10.6% · 부가세 1/11)으로 재계산합니다.
          위탁은 도매가가 곧 원가이므로 공급가 인상이 마진을 직접 깎습니다.
        </p>
      </header>

      {/* 요약 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded border border-emerald-200 bg-emerald-50/50 px-4 py-3">
          <div className="text-xs text-emerald-700">도매가 하락 (기회)</div>
          <div className="text-2xl font-bold text-emerald-700">{drops.length}</div>
        </div>
        <div className="rounded border border-red-200 bg-red-50/50 px-4 py-3">
          <div className="text-xs text-red-700">도매가 인상 (위험)</div>
          <div className="text-2xl font-bold text-red-700">{rises.length}</div>
        </div>
        <div className="rounded border border-gray-200 px-4 py-3">
          <div className="text-xs text-gray-500">발행 + 인상</div>
          <div className="text-2xl font-bold">{publishedRises.length}</div>
        </div>
        <div className="rounded border border-gray-200 px-4 py-3">
          <div className="text-xs text-gray-500">마진 음수 전환</div>
          <div className={`text-2xl font-bold ${flipped.length ? 'text-red-600' : ''}`}>{flipped.length}</div>
        </div>
      </div>

      <QueueTable
        title="🔴 도매가 인상 — 가격 인상·철수 후보"
        desc="공급가가 올라 마진 임계가 하향 돌파된 큐. 발행 상품은 즉시 리프라이싱 또는 철수 검토."
        rows={rises}
        histMap={histMap}
        empty="인상 감지된 상품이 없습니다."
      />

      <QueueTable
        title="🟢 도매가 하락 — 리프라이싱·재발굴 기회"
        desc="공급가가 내려 마진이 확대된 큐. 가격 인하로 바이박스 경쟁력 확보 또는 신규 발굴 대상."
        rows={drops}
        histMap={histMap}
        empty="하락 감지된 상품이 없습니다."
      />

      <p className="text-[11px] text-gray-400">
        데이터 출처: jimscanner_ggsan_cost_shift 뷰 · 직전 가격은 현재가와 다른 가장 최근 관측치 기준 ·
        마진은 발행 리스팅의 판매가 고정 가정.
      </p>
    </div>
  )
}
