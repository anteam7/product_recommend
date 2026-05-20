import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

const BUCKETS = ['price', 'compare', 'howto', 'trouble', 'buy_source'] as const
type Bucket = (typeof BUCKETS)[number]

const BUCKET_LABEL: Record<Bucket, string> = {
  price: '가격탐색',
  compare: '비교선택',
  howto: '사용법/품질',
  trouble: '트러블슈팅',
  buy_source: '구매처/정품',
}

const BUCKET_COLOR: Record<Bucket, string> = {
  price: 'bg-blue-500',
  compare: 'bg-purple-500',
  howto: 'bg-emerald-500',
  trouble: 'bg-amber-500',
  buy_source: 'bg-rose-500',
}

interface IntentRow {
  product_id: string
  intent_bucket: string
  share: number
  query_count: number
  computed_at: string
}

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
  brand: string | null
}

async function fetchData(buySrcOnly: boolean) {
  const sb = createAdminClient()

  // latest intent per product+bucket
  const { data: intents } = await (sb as any)
    .from('jimscanner_trends_query_intent_latest')
    .select('product_id, intent_bucket, share, query_count, computed_at')
    .order('computed_at', { ascending: false })
    .limit(5000)

  const rows = (intents ?? []) as IntentRow[]
  if (rows.length === 0) return { products: [], intentMap: new Map() }

  // group by product_id
  const intentMap = new Map<string, Record<Bucket, IntentRow>>()
  for (const r of rows) {
    if (!BUCKETS.includes(r.intent_bucket as Bucket)) continue
    const existing = intentMap.get(r.product_id) ?? ({} as Record<Bucket, IntentRow>)
    if (!existing[r.intent_bucket as Bucket]) {
      existing[r.intent_bucket as Bucket] = r
      intentMap.set(r.product_id, existing)
    }
  }

  let productIds = [...intentMap.keys()]
  if (buySrcOnly) {
    productIds = productIds.filter((pid) => {
      const m = intentMap.get(pid)
      return m?.buy_source && Number(m.buy_source.share) >= 0.3
    })
  }
  if (productIds.length === 0) return { products: [], intentMap }

  const { data: products } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, brand')
    .in('id', productIds)

  // sort by buy_source share desc (queue ordering)
  const sorted = ((products ?? []) as ProductRow[]).sort((a, b) => {
    const sa = Number(intentMap.get(a.id)?.buy_source?.share ?? 0)
    const sb_ = Number(intentMap.get(b.id)?.buy_source?.share ?? 0)
    return sb_ - sa
  })

  return { products: sorted, intentMap }
}

export default async function IntentMixPage({
  searchParams,
}: {
  searchParams: Promise<{ buy?: string }>
}) {
  const sp = await searchParams
  const buySrcOnly = sp.buy === '1'
  const { products, intentMap } = await fetchData(buySrcOnly)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">쿼리 인텐트 믹스</h1>
          <p className="text-sm text-gray-500 mt-1">
            alias + 같은 카테고리 텍스트(82cook · blog · news)를 5종 마이크로 인텐트로 분해.
            <br />
            구매처 우세 = 발견된 needs · 미충족 공급 = 우선 핀 후보.
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 대시보드
        </Link>
      </header>

      {/* 범례 + 필터 */}
      <section className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-2 text-xs">
          {BUCKETS.map((b) => (
            <span key={b} className="flex items-center gap-1">
              <span className={`inline-block w-3 h-3 rounded ${BUCKET_COLOR[b]}`} />
              <span className="text-gray-700">{BUCKET_LABEL[b]}</span>
            </span>
          ))}
        </div>
        <Link
          href={buySrcOnly ? '/admin/trend-radar/intent-mix' : '/admin/trend-radar/intent-mix?buy=1'}
          className={`text-xs px-3 py-1 rounded border ${
            buySrcOnly
              ? 'bg-rose-50 border-rose-300 text-rose-700 font-semibold'
              : 'border-gray-300 text-gray-600 hover:border-gray-500'
          }`}
        >
          {buySrcOnly ? '✓ 구매처 share ≥ 30% 만' : '구매처 share ≥ 30% 필터'}
        </Link>
      </section>

      {products.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 분해된 인텐트가 없습니다</p>
          <p className="text-sm mt-2">
            cron 6시간마다{' '}
            <code className="px-1 bg-gray-100 rounded">classify-query-intent.mjs</code>{' '}
            가 share 를 갱신합니다.
          </p>
        </div>
      ) : (
        <section className="space-y-1">
          <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
            <div className="col-span-1">#</div>
            <div className="col-span-3">상품명</div>
            <div className="col-span-7">인텐트 믹스</div>
            <div className="col-span-1 text-right">구매처</div>
          </div>
          {products.slice(0, 100).map((p, i) => {
            const im = intentMap.get(p.id)
            if (!im) return null
            const buyShare = Number(im.buy_source?.share ?? 0)
            const totalQ = BUCKETS.reduce((n, b) => n + Number(im[b]?.query_count ?? 0), 0)
            return (
              <Link
                key={p.id}
                href={`/admin/trend-radar/products/${p.id}`}
                className="grid grid-cols-12 items-center px-3 py-2 rounded border border-gray-200 hover:bg-gray-50"
              >
                <div className="col-span-1 text-gray-400 font-mono text-sm">{i + 1}</div>
                <div className="col-span-3">
                  <div className="font-medium text-sm truncate">{p.canonical_name}</div>
                  <div className="text-xs text-gray-500">
                    {p.brand ? `${p.brand} · ` : ''}
                    {p.category_top} · {totalQ}건
                  </div>
                </div>
                <div className="col-span-7">
                  <IntentBar im={im} />
                </div>
                <div
                  className={`col-span-1 text-right text-sm font-mono ${
                    buyShare >= 0.3 ? 'font-bold text-rose-700' : 'text-gray-600'
                  }`}
                >
                  {Math.round(buyShare * 100)}%
                </div>
              </Link>
            )
          })}
        </section>
      )}
    </div>
  )
}

function IntentBar({ im }: { im: Record<Bucket, IntentRow> }) {
  return (
    <div className="w-full h-4 flex rounded overflow-hidden bg-gray-100">
      {BUCKETS.map((b) => {
        const share = Number(im[b]?.share ?? 0)
        if (share <= 0) return null
        return (
          <div
            key={b}
            className={BUCKET_COLOR[b]}
            style={{ width: `${(share * 100).toFixed(2)}%` }}
            title={`${BUCKET_LABEL[b]}: ${Math.round(share * 100)}% (${im[b]?.query_count ?? 0}건)`}
          />
        )
      })}
    </div>
  )
}
