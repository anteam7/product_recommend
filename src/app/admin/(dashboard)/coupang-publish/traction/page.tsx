import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// ─── 타입 ───
interface ListingMeta {
  id: string
  registered_title: string
  display_category_code: number
  display_category_name: string | null
  list_price_krw: number
  registered_at: string | null
  seller_product_id: number | null
  product_id: number | null
  status: string
}

interface TractionRow {
  listing_id: string
  snapshot_date: string
  days_since_publish: number
  impressions: number
  clicks: number
  carts: number
  orders: number
  revenue_krw: number
}

interface BenchmarkRow {
  display_category_code: number
  price_bucket: string
  days_since_publish: number
  sample_n: number
  p25_impr: number | null
  p50_impr: number | null
  p75_impr: number | null
  p25_orders: number | null
  p50_orders: number | null
  p75_orders: number | null
}

interface DeprecateRow {
  id: number
  listing_id: string
  reason: string
  checkpoint_day: number
  metric: string
  benchmark_p25: number | null
  actual_value: number | null
  status: 'pending' | 'dismissed' | 'acted'
  acted_action: string | null
  acted_at: string | null
  created_at: string
}

interface RunRow {
  id: number
  started_at: string
  finished_at: string | null
  status: string
  total_skus: number
  upserted: number
  errors: number
  queued_count: number
}

function priceBucket(p: number) {
  if (p < 10000) return '<10k'
  if (p < 30000) return '10-30k'
  if (p < 50000) return '30-50k'
  if (p < 100000) return '50-100k'
  return '100k+'
}

function pad2(n: number) {
  return n.toString().padStart(2, '0')
}

// ─── 데이터 페치 ───
async function fetchAll() {
  // 신규 테이블 — generated types 미반영
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any

  // 30일 이내 발행된 활성 SKU
  const since = new Date(Date.now() - 31 * 86_400_000).toISOString()
  const { data: listings } = await sb
    .from('jimscanner_coupang_listings')
    .select(
      'id, registered_title, display_category_code, display_category_name, list_price_krw, registered_at, seller_product_id, product_id, status',
    )
    .not('registered_at', 'is', null)
    .gte('registered_at', since)
    .order('registered_at', { ascending: false })
    .limit(200)

  const listingsArr = ((listings ?? []) as ListingMeta[]).filter((l) => !!l.registered_at)
  const listingIds = listingsArr.map((l) => l.id)

  // 일별 traction
  let tractions: TractionRow[] = []
  if (listingIds.length > 0) {
    const { data } = await sb
      .from('jimscanner_coupang_sku_traction_daily')
      .select(
        'listing_id, snapshot_date, days_since_publish, impressions, clicks, carts, orders, revenue_krw',
      )
      .in('listing_id', listingIds)
      .order('days_since_publish', { ascending: true })
    tractions = (data ?? []) as TractionRow[]
  }

  // 벤치마크 분위 — 카테고리×버킷별로 가져와 매칭
  const catCodes = [...new Set(listingsArr.map((l) => l.display_category_code).filter(Boolean))]
  let benchmarks: BenchmarkRow[] = []
  if (catCodes.length > 0) {
    const { data } = await sb
      .from('jimscanner_coupang_traction_benchmarks')
      .select(
        'display_category_code, price_bucket, days_since_publish, sample_n, p25_impr, p50_impr, p75_impr, p25_orders, p50_orders, p75_orders',
      )
      .in('display_category_code', catCodes)
    benchmarks = (data ?? []) as BenchmarkRow[]
  }

  // pending auto-deprecate 큐
  const { data: queue } = await sb
    .from('jimscanner_coupang_deprecate_queue')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(50)

  // 최근 cron run
  const { data: runs } = await sb
    .from('jimscanner_coupang_traction_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(1)

  return {
    listings: listingsArr,
    tractions,
    benchmarks,
    queue: (queue ?? []) as DeprecateRow[],
    latestRun: ((runs ?? [])[0] ?? null) as RunRow | null,
  }
}

// ─── 시각화 보조 ───
function findBench(
  benchmarks: BenchmarkRow[],
  catCode: number,
  bucket: string,
  day: number,
): BenchmarkRow | null {
  return (
    benchmarks.find(
      (b) =>
        b.display_category_code === catCode &&
        b.price_bucket === bucket &&
        b.days_since_publish === day,
    ) ?? null
  )
}

function tractionBand(actual: number, bench: BenchmarkRow | null) {
  if (!bench || bench.p25_impr == null) return { label: 'n/a', cls: 'bg-gray-100 text-gray-500' }
  if (actual >= (bench.p75_impr ?? 0)) return { label: 'TOP', cls: 'bg-emerald-100 text-emerald-700' }
  if (actual >= (bench.p50_impr ?? 0)) return { label: '양호', cls: 'bg-green-50 text-green-700' }
  if (actual >= (bench.p25_impr ?? 0)) return { label: '평균', cls: 'bg-amber-100 text-amber-700' }
  return { label: 'P25↓', cls: 'bg-rose-100 text-rose-700' }
}

function Sparkline({ values, max }: { values: number[]; max: number }) {
  if (values.length === 0 || max === 0) return <span className="text-gray-300 text-xs">no data</span>
  const w = 80
  const h = 20
  const step = values.length > 1 ? w / (values.length - 1) : w
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(' ')
  return (
    <svg width={w} height={h} className="inline-block align-middle">
      <polyline fill="none" stroke="#0ea5e9" strokeWidth="1.5" points={pts} />
    </svg>
  )
}

function BenchOverlay({
  values,
  p25,
  p50,
  p75,
}: {
  values: number[]
  p25: number | null
  p50: number | null
  p75: number | null
}) {
  const max = Math.max(1, ...values, p75 ?? 0, p50 ?? 0, p25 ?? 0)
  const w = 220
  const h = 50
  const step = values.length > 1 ? w / (values.length - 1) : w
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(' ')
  const hline = (v: number | null, color: string) =>
    v == null ? null : (
      <line x1={0} x2={w} y1={h - (v / max) * h} y2={h - (v / max) * h} stroke={color} strokeDasharray="3,3" strokeWidth={1} />
    )
  return (
    <svg width={w} height={h} className="block">
      {hline(p75, '#10b981')}
      {hline(p50, '#9ca3af')}
      {hline(p25, '#f43f5e')}
      <polyline fill="none" stroke="#0ea5e9" strokeWidth="1.8" points={pts} />
    </svg>
  )
}

// ─── 페이지 ───
export default async function CoupangPublishTractionPage() {
  const { listings, tractions, benchmarks, queue, latestRun } = await fetchAll()

  // listing_id 별 traction trajectory
  const traj = new Map<string, TractionRow[]>()
  for (const t of tractions) {
    const arr = traj.get(t.listing_id) ?? []
    arr.push(t)
    traj.set(t.listing_id, arr)
  }

  const rows = listings.map((l) => {
    const t = traj.get(l.id) ?? []
    const latest = t.length > 0 ? t[t.length - 1] : null
    const bucket = priceBucket(l.list_price_krw ?? 0)
    const bench = latest
      ? findBench(benchmarks, l.display_category_code, bucket, latest.days_since_publish)
      : null
    const band = latest ? tractionBand(latest.impressions, bench) : { label: 'n/a', cls: 'bg-gray-100 text-gray-500' }

    // D+7 / D+14 / D+21 체크포인트
    const checkpoint = (day: number) => {
      const row = t.find((x) => x.days_since_publish === day)
      const bm = findBench(benchmarks, l.display_category_code, bucket, day)
      if (!row || !bm || bm.p25_impr == null) return { row, bm, status: 'pending' as const }
      if (row.impressions >= (bm.p50_impr ?? 0)) return { row, bm, status: 'ok' as const }
      if (row.impressions >= bm.p25_impr) return { row, bm, status: 'avg' as const }
      return { row, bm, status: 'fail' as const }
    }

    return {
      listing: l,
      trajectory: t,
      latest,
      bench,
      band,
      bucket,
      cp7: checkpoint(7),
      cp14: checkpoint(14),
      cp21: checkpoint(21),
    }
  })

  // 요약 카드
  const total = rows.length
  const withData = rows.filter((r) => r.trajectory.length > 0).length
  const belowP25 = rows.filter((r) => r.band.label === 'P25↓').length
  const top = rows.filter((r) => r.band.label === 'TOP').length
  const pendingDeprecate = queue.length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">신규 발행 SKU Traction 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            발행 후 30일 곡선 × 카테고리·가격대 P25/P50/P75 벤치마크 — 손절·재공정 의사결정 보드
          </p>
        </div>
        <Link
          href="/admin/coupang-publish"
          className="text-sm text-blue-700 hover:underline"
        >
          ← 등록 상품 관리로
        </Link>
      </header>

      {/* 요약 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: '추적 SKU', value: total, cls: 'bg-white' },
          { label: '데이터 있음', value: withData, cls: 'bg-sky-50' },
          { label: 'TOP (P75↑)', value: top, cls: 'bg-emerald-50 text-emerald-700' },
          { label: 'P25 미달', value: belowP25, cls: 'bg-rose-50 text-rose-700' },
          { label: '손절 큐 (pending)', value: pendingDeprecate, cls: 'bg-amber-50 text-amber-700' },
        ].map((c) => (
          <div key={c.label} className={`rounded border p-3 ${c.cls}`}>
            <div className="text-[11px] text-gray-500">{c.label}</div>
            <div className="text-xl font-bold tabular-nums mt-1">{c.value.toLocaleString()}</div>
          </div>
        ))}
      </div>

      {/* 최근 cron 실행 */}
      {latestRun && (
        <div className="text-xs text-gray-500">
          최근 traction 적재:{' '}
          <span className="text-gray-700 font-medium">
            {new Date(latestRun.started_at).toLocaleString('ko-KR')}
          </span>{' '}
          · {latestRun.status} · upserted={latestRun.upserted} · queued={latestRun.queued_count} ·
          errors={latestRun.errors}
        </div>
      )}

      {/* 손절 큐 */}
      {queue.length > 0 && (
        <section className="bg-amber-50/60 border border-amber-200 rounded p-4">
          <h2 className="text-sm font-semibold text-amber-800 mb-2">
            🚨 자동 손절 큐 — D+7/D+14/D+21 P25 미달 SKU ({queue.length}건)
          </h2>
          <ul className="text-xs text-amber-900 space-y-1 max-h-40 overflow-y-auto">
            {queue.slice(0, 20).map((q) => {
              const l = listings.find((x) => x.id === q.listing_id)
              return (
                <li key={q.id} className="flex items-start gap-2">
                  <span className="inline-block min-w-[2.5rem] px-1.5 py-0.5 rounded bg-amber-200 text-amber-900 font-semibold text-center">
                    D+{q.checkpoint_day}
                  </span>
                  <span className="truncate flex-1">
                    {l ? l.registered_title : `listing=${q.listing_id.slice(0, 8)}`} —{' '}
                    <span className="text-amber-700">{q.reason}</span>
                  </span>
                </li>
              )
            })}
          </ul>
          <p className="text-[11px] text-amber-700 mt-2">
            * 운영자 액션은 향후 1-click API 와 연결 (deactivate / reprice / relist_fix).
          </p>
        </section>
      )}

      {/* 메인 테이블 */}
      <div className="overflow-x-auto bg-white border rounded">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-xs">
            <tr>
              <th className="px-3 py-2 text-left font-semibold w-[26%]">상품명</th>
              <th className="px-3 py-2 text-center font-semibold">발행</th>
              <th className="px-3 py-2 text-center font-semibold">최신 D+N</th>
              <th className="px-3 py-2 text-center font-semibold">노출 곡선 vs 벤치</th>
              <th className="px-3 py-2 text-right font-semibold">노출/클릭/주문</th>
              <th className="px-3 py-2 text-center font-semibold">D+7</th>
              <th className="px-3 py-2 text-center font-semibold">D+14</th>
              <th className="px-3 py-2 text-center font-semibold">D+21</th>
              <th className="px-3 py-2 text-center font-semibold">밴드</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-12 text-center text-gray-400 text-sm">
                  최근 30일 이내 발행된 SKU 가 없습니다.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const values = r.trajectory.map((x) => x.impressions)
              const sparkMax = Math.max(1, ...values)
              const cpCell = (cp: typeof r.cp7) => {
                if (!cp.row) {
                  return <span className="text-gray-300">·</span>
                }
                const v = cp.row.impressions.toLocaleString()
                if (cp.status === 'ok') {
                  return <span className="text-emerald-700 font-medium">{v}</span>
                }
                if (cp.status === 'avg') {
                  return <span className="text-amber-700">{v}</span>
                }
                if (cp.status === 'fail') {
                  return (
                    <span className="text-rose-700 font-semibold" title={`P25=${cp.bm?.p25_impr ?? '?'}`}>
                      {v} ↓
                    </span>
                  )
                }
                return <span className="text-gray-500">{v}</span>
              }
              return (
                <tr key={r.listing.id} className="border-t hover:bg-sky-50/30 align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-900 line-clamp-2">{r.listing.registered_title}</div>
                    <div className="text-[11px] text-gray-500 mt-0.5">
                      {r.listing.display_category_name && <span>{r.listing.display_category_name}</span>}
                      <span className="ml-1.5 text-gray-400">· {r.bucket}</span>
                      {r.listing.product_id && (
                        <a
                          href={`https://www.coupang.com/vp/products/${r.listing.product_id}`}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="ml-1.5 text-blue-700 hover:underline"
                        >
                          쿠팡↗
                        </a>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-center text-xs text-gray-500 tabular-nums">
                    {r.listing.registered_at
                      ? (() => {
                          const d = new Date(r.listing.registered_at)
                          return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
                        })()
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {r.latest ? (
                      <span className="inline-block px-2 py-0.5 rounded text-xs bg-blue-100 text-blue-700 font-medium">
                        D+{r.latest.days_since_publish}
                      </span>
                    ) : (
                      <span className="text-gray-300 text-xs">대기</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {r.trajectory.length > 0 ? (
                      <BenchOverlay
                        values={values}
                        p25={r.bench?.p25_impr ?? null}
                        p50={r.bench?.p50_impr ?? null}
                        p75={r.bench?.p75_impr ?? null}
                      />
                    ) : (
                      <Sparkline values={[]} max={sparkMax} />
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs">
                    {r.latest ? (
                      <>
                        <div className="text-gray-900">
                          {r.latest.impressions.toLocaleString()}
                        </div>
                        <div className="text-[10px] text-gray-500">
                          C {r.latest.clicks.toLocaleString()} · O {r.latest.orders.toLocaleString()}
                        </div>
                      </>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center text-xs tabular-nums">{cpCell(r.cp7)}</td>
                  <td className="px-3 py-2 text-center text-xs tabular-nums">{cpCell(r.cp14)}</td>
                  <td className="px-3 py-2 text-center text-xs tabular-nums">{cpCell(r.cp21)}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${r.band.cls}`}>
                      {r.band.label}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-gray-400">
        * 벤치마크는 동일 <code>display_category_code</code> × 가격버킷 × D+N 의 자기 SKU 모집단 P25/P50/P75.
        샘플 n&lt;5 인 경우 표시되지 않음.{' '}
        <code>scripts/coupang-traction-daily.mjs</code> 가 매일 03:00 KST 적재.
      </p>
    </div>
  )
}
