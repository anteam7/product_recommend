import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  computeImitationDecay,
  aggregateCategoryHalfLife,
  isImitationSpike,
  type ImitationObservation,
} from '@/lib/scoring/imitation-decay'

export const dynamic = 'force-dynamic'

type TrackRow = {
  product_id: string
  observed_at: string
  observed_date: string
  serp_listing_count: number
  new_listings_24h: number
  median_price_krw: number | null
  serp_source: string
  query: string | null
}
type ProductRow = {
  id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
}

async function fetchData() {
  const sb = createAdminClient()

  // 최근 60일 추적 row (전체)
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString()
  const { data: tracks } = await sb
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from('jimscanner_trends_imitation_track' as any)
    .select('product_id, observed_at, observed_date, serp_listing_count, new_listings_24h, median_price_krw, serp_source, query')
    .gte('observed_at', since)
    .order('observed_at', { ascending: true })

  const trackRows = ((tracks ?? []) as unknown as TrackRow[]) ?? []

  const productIds = Array.from(new Set(trackRows.map((t) => t.product_id)))
  let products: ProductRow[] = []
  if (productIds.length > 0) {
    const { data: prods } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top, category_mid')
      .in('id', productIds)
    products = (prods ?? []) as ProductRow[]
  }
  const productMap = new Map<string, ProductRow>()
  for (const p of products) productMap.set(p.id, p)

  // group track rows by product_id
  const byProduct = new Map<string, TrackRow[]>()
  for (const t of trackRows) {
    const arr = byProduct.get(t.product_id) ?? []
    arr.push(t)
    byProduct.set(t.product_id, arr)
  }

  // compute decay per product
  const perProduct = Array.from(byProduct.entries()).map(([pid, rows]) => {
    const obs: ImitationObservation[] = rows.map((r) => ({
      observed_at: r.observed_at,
      serp_listing_count: r.serp_listing_count,
    }))
    const result = computeImitationDecay(obs)
    const product = productMap.get(pid)
    const latest = rows[rows.length - 1]
    return { pid, product, rows, result, latest }
  })

  // 카테고리 평균 half-life
  const catAvg = aggregateCategoryHalfLife(
    perProduct
      .filter((p) => p.product)
      .map((p) => ({ category_top: p.product!.category_top, result: p.result })),
  )

  // 카테고리별 new_listings_24h 분포 (spike 판정용)
  const catSamples = new Map<string, number[]>()
  for (const p of perProduct) {
    if (!p.product) continue
    const arr = catSamples.get(p.product.category_top) ?? []
    arr.push(p.latest.new_listings_24h)
    catSamples.set(p.product.category_top, arr)
  }

  const enriched = perProduct.map((p) => {
    const samples = (p.product && catSamples.get(p.product.category_top)) ?? []
    const spike = isImitationSpike(p.latest.new_listings_24h, samples)
    return { ...p, spike }
  })

  enriched.sort((a, b) => {
    const aw = a.result.entry_window_days ?? 9999
    const bw = b.result.entry_window_days ?? 9999
    return aw - bw
  })

  return { perProduct: enriched, catAvg }
}

function Sparkline({ rows }: { rows: TrackRow[] }) {
  if (rows.length < 2) return <span className="text-xs text-gray-400">데이터 부족</span>
  const counts = rows.map((r) => r.serp_listing_count)
  const max = Math.max(...counts, 1)
  const min = Math.min(...counts, 0)
  const w = 120
  const h = 28
  const span = Math.max(1, max - min)
  const pts = counts.map((c, i) => {
    const x = (i / (counts.length - 1)) * w
    const y = h - ((c - min) / span) * h
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  return (
    <svg width={w} height={h} className="inline-block">
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        points={pts.join(' ')}
        className="text-amber-600"
      />
    </svg>
  )
}

function SeverityBadge({ sev }: { sev: 'safe' | 'narrow' | 'closing' | 'unknown' }) {
  const map = {
    safe: 'bg-emerald-100 text-emerald-700',
    narrow: 'bg-amber-100 text-amber-700',
    closing: 'bg-red-100 text-red-700',
    unknown: 'bg-gray-100 text-gray-500',
  }
  const label = { safe: '여유', narrow: '좁아짐', closing: '마감임박', unknown: '?' }
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${map[sev]}`}>
      {label[sev]}
    </span>
  )
}

export default async function ImitationPage() {
  const { perProduct, catAvg } = await fetchData()

  const spikes = perProduct.filter((p) => p.spike.spike)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">모방 클리프 추적기</h1>
          <p className="text-sm text-gray-500 mt-1">
            핀 상품 SERP 카피캣 증가속도 → 진입 윈도우 D-day · 카피캣 +1σ 도달 시 빨간 배너
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 대시보드
        </Link>
      </header>

      {spikes.length > 0 && (
        <div className="rounded border border-red-300 bg-red-50 p-4 space-y-2">
          <div className="text-sm font-bold text-red-700">
            🚨 카피캣 +1σ 도달: {spikes.length}건 — 액션 권고
          </div>
          <ul className="text-sm text-red-900 space-y-1">
            {spikes.map((s) => (
              <li key={s.pid}>
                <strong>{s.product?.canonical_name ?? s.pid}</strong> — 24h 신규{' '}
                {s.spike.threshold > 0
                  ? `${s.latest.new_listings_24h} (임계 ${s.spike.threshold.toFixed(1)})`
                  : `${s.latest.new_listings_24h}`}{' '}
                · 권고: <em>가격 조정 / 번들 전환 / exit</em>
              </li>
            ))}
          </ul>
        </div>
      )}

      <section>
        <h2 className="text-sm font-semibold mb-2">카테고리 평균 모방 반감기 (참고선)</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Object.entries(catAvg).map(([cat, v]) => (
            <div key={cat} className="rounded border border-gray-200 p-3">
              <div className="text-xs text-gray-500 uppercase">{cat}</div>
              <div className="mt-1 text-2xl font-bold">
                {v.avg_half_life_days ? `${v.avg_half_life_days.toFixed(1)}일` : '—'}
              </div>
              <div className="text-[10px] text-gray-400">samples {v.samples}</div>
            </div>
          ))}
          {Object.keys(catAvg).length === 0 && (
            <div className="col-span-4 text-sm text-gray-400">관측 데이터 부족 — cron 가동 후 표시</div>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold mb-2">핀별 카피캣 진입 윈도우</h2>
        {perProduct.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
            <p className="text-base font-medium">추적 데이터 없음</p>
            <p className="text-sm mt-2">
              /api/cron/track-imitation 이 한 번 이상 실행되어야 표시됩니다.
            </p>
          </div>
        ) : (
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">상품</th>
                  <th className="px-3 py-2 text-left">카테고리</th>
                  <th className="px-3 py-2 text-right">현재 SERP</th>
                  <th className="px-3 py-2 text-right">24h 신규</th>
                  <th className="px-3 py-2 text-center">추이</th>
                  <th className="px-3 py-2 text-right">반감기</th>
                  <th className="px-3 py-2 text-right">D-day</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {perProduct.map((p) => (
                  <tr key={p.pid}>
                    <td className="px-3 py-2">
                      {p.product ? (
                        <Link
                          href={`/admin/trend-radar/products/${p.pid}`}
                          className="font-medium hover:underline"
                        >
                          {p.product.canonical_name}
                        </Link>
                      ) : (
                        <span className="text-gray-400 font-mono text-xs">{p.pid.slice(0, 8)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500">
                      {p.product?.category_top ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{p.latest.serp_listing_count}</td>
                    <td className="px-3 py-2 text-right font-mono">
                      {p.spike.spike ? (
                        <span className="text-red-700 font-bold">+{p.latest.new_listings_24h}</span>
                      ) : (
                        <span>+{p.latest.new_listings_24h}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <Sparkline rows={p.rows} />
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {p.result.imitation_half_life_days
                        ? `${p.result.imitation_half_life_days.toFixed(1)}일`
                        : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <SeverityBadge sev={p.result.severity} />
                        <span className="text-xs">{p.result.dday_label}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
