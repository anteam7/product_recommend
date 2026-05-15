import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

const CHANNELS = ['smartstore', 'coupang', '11st', 'gmarket', 'auction', 'wemap'] as const
type Channel = (typeof CHANNELS)[number]

interface FootprintRow {
  product_id: string
  channel: Channel
  listing_count: number
  min_price: number | null
  median_price: number | null
  max_price: number | null
  top_seller: string | null
  collected_at: string
}

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
}

interface ScoreRow {
  product_id: string
  final_score: number
  computed_at: string
}

interface MatrixRow {
  id: string
  name: string
  category: string
  final_score: number
  per_channel: Partial<Record<Channel, FootprintRow>>
  whitespace_count: number
  price_spread_pct: number | null
}

async function fetchData() {
  const sb = createAdminClient()

  // 최신 footprint (product × channel 별 가장 최근 row)
  // 단순화를 위해 최근 14일 footprint 만 가져와서 메모리에서 dedupe.
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
  const { data: fpData } = await (sb as any)
    .from('jimscanner_trends_channel_footprint')
    .select(
      'product_id, channel, listing_count, min_price, median_price, max_price, top_seller, collected_at',
    )
    .gte('collected_at', since)
    .order('collected_at', { ascending: false })
    .limit(5000)

  const latestKey = new Map<string, FootprintRow>()
  for (const r of (fpData ?? []) as FootprintRow[]) {
    const k = `${r.product_id}__${r.channel}`
    if (!latestKey.has(k)) latestKey.set(k, r)
  }

  const productIds = Array.from(new Set(Array.from(latestKey.values()).map((r) => r.product_id)))

  if (productIds.length === 0) {
    return { rows: [] as MatrixRow[], collectedSample: null as string | null }
  }

  const [{ data: prodData }, { data: scoreData }] = await Promise.all([
    sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top')
      .in('id', productIds),
    sb
      .from('jimscanner_trends_scores')
      .select('product_id, final_score, computed_at')
      .in('product_id', productIds)
      .order('computed_at', { ascending: false })
      .limit(productIds.length * 5),
  ])

  const byProd = new Map((prodData ?? []).map((p: any) => [p.id, p as ProductRow]))
  const scoreByProd = new Map<string, number>()
  for (const s of (scoreData ?? []) as ScoreRow[]) {
    if (!scoreByProd.has(s.product_id)) scoreByProd.set(s.product_id, s.final_score)
  }

  // 매트릭스 빌드
  const matrixByProd = new Map<string, MatrixRow>()
  for (const fp of latestKey.values()) {
    const prod = byProd.get(fp.product_id)
    if (!prod) continue
    let mr = matrixByProd.get(fp.product_id)
    if (!mr) {
      mr = {
        id: fp.product_id,
        name: prod.canonical_name,
        category: prod.category_top,
        final_score: scoreByProd.get(fp.product_id) ?? 0,
        per_channel: {},
        whitespace_count: 0,
        price_spread_pct: null,
      }
      matrixByProd.set(fp.product_id, mr)
    }
    mr.per_channel[fp.channel] = fp
  }

  for (const mr of matrixByProd.values()) {
    let whitespace = 0
    const medians: number[] = []
    for (const ch of CHANNELS) {
      const f = mr.per_channel[ch]
      if (!f || f.listing_count === 0) whitespace++
      if (f?.median_price) medians.push(Number(f.median_price))
    }
    mr.whitespace_count = whitespace
    if (medians.length >= 2) {
      const min = Math.min(...medians)
      const max = Math.max(...medians)
      mr.price_spread_pct = min > 0 ? ((max - min) / min) * 100 : null
    }
  }

  const rows = Array.from(matrixByProd.values()).sort((a, b) => {
    // 빈 마켓 진입 후보 우선: whitespace 많고 final_score 높음
    const aScore = a.whitespace_count * 20 + a.final_score
    const bScore = b.whitespace_count * 20 + b.final_score
    return bScore - aScore
  })

  const collectedSample =
    Array.from(latestKey.values())
      .map((r) => r.collected_at)
      .sort()
      .at(-1) ?? null

  return { rows, collectedSample }
}

function fmtPrice(n: number | null | undefined) {
  if (n === null || n === undefined) return '-'
  if (n < 10000) return `${Math.round(n).toLocaleString()}원`
  return `${(n / 10000).toFixed(1)}만`
}

function cellBg(count: number) {
  if (count === 0) return 'bg-rose-50 text-rose-700'
  if (count < 10) return 'bg-amber-50 text-amber-700'
  if (count < 100) return 'bg-emerald-50 text-emerald-700'
  return 'bg-slate-100 text-slate-700'
}

export default async function FootprintPage() {
  const { rows, collectedSample } = await fetchData()

  const whitespaceCandidates = rows.filter((r) => r.whitespace_count >= 5 && r.final_score >= 50)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">채널 푸트프린트 — 빈 마켓 발굴</h1>
          <p className="mt-1 text-sm text-gray-500">
            6대 마켓플레이스(스마트스토어·쿠팡·11번가·지마켓·옥션·위메프)에서의 product 단위 등록
            상태. 빨강 = 0건(진입 기회) / 노랑 = 미포화 / 초록 = 경쟁 활발.
            {collectedSample && (
              <span className="ml-2 text-gray-400">
                · 최근 수집: {new Date(collectedSample).toLocaleString('ko-KR')}
              </span>
            )}
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 underline hover:text-black">
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 footprint 데이터 없음. `node scripts/collect-channel-footprint.mjs` 실행 후 다시
          방문하세요.
        </div>
      ) : (
        <>
          <section className="rounded border border-rose-200 bg-rose-50 p-4">
            <h2 className="text-sm font-semibold text-rose-800">
              ⚡ 빈 마켓 진입 후보 (final_score ≥ 50 · whitespace ≥ 5)
            </h2>
            {whitespaceCandidates.length === 0 ? (
              <p className="mt-2 text-sm text-rose-700">해당 조건의 SKU 없음.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {whitespaceCandidates.slice(0, 20).map((r) => (
                  <li key={r.id} className="flex items-center gap-3">
                    <span className="font-mono text-xs text-rose-700">
                      score {r.final_score.toFixed(0)}
                    </span>
                    <span className="font-mono text-xs text-rose-700">
                      whitespace {r.whitespace_count}/6
                    </span>
                    <Link
                      href={`/admin/trend-radar/products/${r.id}`}
                      className="text-rose-900 underline hover:text-black"
                    >
                      {r.name}
                    </Link>
                    <span className="text-xs text-rose-500">[{r.category}]</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="overflow-x-auto rounded border border-gray-200">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold text-gray-700">상품</th>
                  <th className="px-3 py-2 text-right font-semibold text-gray-700">final</th>
                  <th className="px-3 py-2 text-right font-semibold text-gray-700">whitespace</th>
                  <th className="px-3 py-2 text-right font-semibold text-gray-700">spread%</th>
                  {CHANNELS.map((c) => (
                    <th key={c} className="px-2 py-2 text-center font-semibold text-gray-700">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 200).map((r) => (
                  <tr key={r.id} className="border-t border-gray-100">
                    <td className="px-3 py-2">
                      <Link
                        href={`/admin/trend-radar/products/${r.id}`}
                        className="font-medium text-gray-900 hover:underline"
                      >
                        {r.name}
                      </Link>
                      <div className="text-xs text-gray-400">{r.category}</div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-gray-700">
                      {r.final_score.toFixed(0)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-rose-700">
                      {r.whitespace_count}/6
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-gray-700">
                      {r.price_spread_pct === null ? '-' : `${r.price_spread_pct.toFixed(0)}%`}
                    </td>
                    {CHANNELS.map((ch) => {
                      const f = r.per_channel[ch]
                      const count = f?.listing_count ?? 0
                      return (
                        <td
                          key={ch}
                          className={`px-2 py-2 text-center text-xs ${cellBg(count)}`}
                          title={
                            f
                              ? `q=${f.top_seller ?? '?'} | min ${fmtPrice(f.min_price)} / med ${fmtPrice(
                                  f.median_price,
                                )} / max ${fmtPrice(f.max_price)}`
                              : '미수집'
                          }
                        >
                          <div className="font-mono font-semibold">{count}</div>
                          <div className="text-[10px] text-gray-500">
                            {fmtPrice(f?.median_price ?? null)}
                          </div>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
