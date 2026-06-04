import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// jimscanner_ggsan_stockout_cadence RPC (supabase/ggsan_stockout_cadence_rpc.sql)
// 반환 행 — generated 타입 미반영이라 `as never` 캐스팅 (gen:types 후 해제)
interface CadenceRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  is_imminent: boolean
  image_url: string | null
  detail_url: string | null
  current_status: string | null
  obs_count: number
  observed_span_days: number
  soldout_entries: number
  imminent_obs: number
  avg_stock_life_hours: number | null
  avg_restock_delay_hours: number | null
  soldout_per_30d: number
  cadence_score: number
}

interface HistoryPoint {
  goods_no: string
  status: string | null
  observed_at: string
}

const DAYS_OPTIONS = [
  { v: 30, label: '30일' },
  { v: 60, label: '60일' },
  { v: 90, label: '90일 (기본)' },
  { v: 180, label: '180일' },
] as const

// status → 띠 색 (품절 = 진한 음영)
const STATUS_COLOR: Record<string, string> = {
  active: '#bbf7d0', // green-200
  sold_out: '#1f2937', // gray-800 (품절 구간 음영)
  imminent: '#fdba74', // orange-300 (마감임박)
  removed: '#e5e7eb', // gray-200
}
const STATUS_LABEL: Record<string, string> = {
  active: '판매중',
  sold_out: '품절',
  imminent: '임박특가',
  removed: '내림',
}

async function fetchData(days: number) {
  const sb = createAdminClient()

  const { data, error } = await sb.rpc('jimscanner_ggsan_stockout_cadence' as never, {
    days_window: days,
    min_soldout: 1,
    result_limit: 300,
  } as never)

  if (error) {
    return { rows: [] as CadenceRow[], timelines: new Map<string, HistoryPoint[]>(), error: error.message, days }
  }

  const rows = ((data ?? []) as CadenceRow[]).slice(0, 60)

  // 상위 표시 상품의 status 타임라인 (품절 구간 음영용)
  const timelines = new Map<string, HistoryPoint[]>()
  const ids = rows.map((r) => r.goods_no)
  if (ids.length > 0) {
    const sinceIso = new Date(Date.now() - days * 86400_000).toISOString()
    const { data: hist } = await sb
      .from('jimscanner_ggsan_price_history')
      .select('goods_no, status, observed_at')
      .in('goods_no', ids)
      .gte('observed_at', sinceIso)
      .order('observed_at', { ascending: true })
      .limit(20000)
    for (const h of (hist ?? []) as HistoryPoint[]) {
      const arr = timelines.get(h.goods_no) ?? []
      arr.push(h)
      timelines.set(h.goods_no, arr)
    }
  }

  return { rows, timelines, error: null as string | null, days }
}

function fmtHours(h: number | null): string {
  if (h == null) return '—'
  if (h < 48) return `${h.toFixed(0)}시간`
  return `${(h / 24).toFixed(1)}일`
}

// status 시계열 → 좌→우 비율 세그먼트(품절 구간 음영). 마지막 상태는 days_window 끝까지 연장.
function buildSegments(points: HistoryPoint[], days: number) {
  if (points.length === 0) return [] as { status: string; pct: number }[]
  const start = Date.now() - days * 86400_000
  const end = Date.now()
  const total = end - start
  const segs: { status: string; pct: number }[] = []
  for (let i = 0; i < points.length; i++) {
    const t = new Date(points[i].observed_at).getTime()
    const next = i + 1 < points.length ? new Date(points[i + 1].observed_at).getTime() : end
    const from = Math.max(t, start)
    const width = Math.max(next - from, 0)
    if (width <= 0) continue
    segs.push({ status: points[i].status ?? 'active', pct: (width / total) * 100 })
  }
  return segs
}

export default async function StockoutOraclePage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>
}) {
  const sp = await searchParams
  const days = Number(sp.days) || 90
  const { rows, timelines, error } = await fetchData(days)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">품절 캐던스 오라클</h1>
          <p className="mt-1 max-w-3xl text-sm text-gray-500">
            도매(ggsan) <b>품절 주기</b>를 버즈가 아닌 <b>공급측 소진(sell-through)</b> 하드 신호로 재해석.
            자주·빠르게 품절나고 빠르게 재입고될수록 누군가 실제로 도매에서 계속 사간다는 뜻 →
            협찬·어뷰징 불가능한 실수요 증거. 버즈는 약해도 숨은 실수요 상품을 발굴한다.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 underline hover:text-black">
          ← 대시보드
        </Link>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-gray-500">관측기간:</span>
        {DAYS_OPTIONS.map((o) => (
          <Link
            key={o.v}
            href={`?days=${o.v}`}
            className={`rounded border px-3 py-1 text-sm ${
              days === o.v ? 'border-black bg-black text-white' : 'border-gray-300 text-gray-700 hover:border-black'
            }`}
          >
            {o.label}
          </Link>
        ))}
        <div className="ml-auto flex items-center gap-3 text-xs text-gray-500">
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <span key={k} className="flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded-sm" style={{ background: STATUS_COLOR[k] }} />
              {v}
            </span>
          ))}
        </div>
      </div>

      {error ? (
        <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
          RPC 호출 실패: {error}
          <div className="mt-1 text-xs text-amber-700">
            supabase/ggsan_stockout_cadence_rpc.sql 적용 후 사용 가능.
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 품절 전이 데이터가 충분치 않음. ggsan 가격수집 누적 후 다시 방문.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">상품</th>
                <th className="px-3 py-2 text-right">
                  검증도
                  <div className="font-normal normal-case text-gray-400">cadence</div>
                </th>
                <th className="px-3 py-2 text-right">품절횟수</th>
                <th className="px-3 py-2 text-right">30일환산</th>
                <th className="px-3 py-2 text-right">재고수명</th>
                <th className="px-3 py-2 text-right">재입고지연</th>
                <th className="px-3 py-2 text-right">임박</th>
                <th className="px-3 py-2 w-[28%]">status 타임라인 (품절=음영)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r, i) => {
                const segs = buildSegments(timelines.get(r.goods_no) ?? [], days)
                return (
                  <tr key={r.goods_no} className="hover:bg-gray-50">
                    <td className="px-3 py-2 text-gray-400">{i + 1}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        {r.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={r.image_url} alt="" className="h-10 w-10 rounded object-cover" />
                        ) : (
                          <div className="h-10 w-10 rounded bg-gray-100" />
                        )}
                        <div className="min-w-0">
                          <div className="max-w-[22rem] truncate font-medium" title={r.title}>
                            {r.detail_url ? (
                              <a
                                href={r.detail_url}
                                target="_blank"
                                rel="noreferrer"
                                className="hover:underline"
                              >
                                {r.title}
                              </a>
                            ) : (
                              r.title
                            )}
                          </div>
                          <div className="text-xs text-gray-400">
                            {r.cate_label ?? r.cate_cd ?? '—'}
                            {r.price_krw ? ` · ${r.price_krw.toLocaleString()}원` : ''}
                            {r.current_status ? ` · ${STATUS_LABEL[r.current_status] ?? r.current_status}` : ''}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-semibold text-gray-900">
                      {r.cadence_score?.toFixed(2) ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right">{r.soldout_entries}</td>
                    <td className="px-3 py-2 text-right text-gray-600">
                      {r.soldout_per_30d?.toFixed(1) ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-600">{fmtHours(r.avg_stock_life_hours)}</td>
                    <td className="px-3 py-2 text-right text-gray-600">{fmtHours(r.avg_restock_delay_hours)}</td>
                    <td className="px-3 py-2 text-right text-gray-600">{r.imminent_obs || ''}</td>
                    <td className="px-3 py-2">
                      <div
                        className="flex h-4 w-full overflow-hidden rounded border border-gray-200"
                        title={`관측 ${r.obs_count}회 · ${r.observed_span_days?.toFixed(0)}일`}
                      >
                        {segs.length === 0 ? (
                          <div className="w-full bg-gray-100" />
                        ) : (
                          segs.map((s, si) => (
                            <div
                              key={si}
                              style={{ width: `${s.pct}%`, background: STATUS_COLOR[s.status] ?? '#e5e7eb' }}
                              title={STATUS_LABEL[s.status] ?? s.status}
                            />
                          ))
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-gray-400">
        검증도(cadence_score) = 품절빈도(30일 환산) × 빠른 재입고 보너스 × 임박특가 가산.
        기존 trend_score(버즈) 대비 공급측 검증 축 — 둘을 교차하면 버즈+공급 동시 강세(확실)와
        버즈 약·공급 강(숨은 실수요)을 구분할 수 있다.
      </p>
    </div>
  )
}
