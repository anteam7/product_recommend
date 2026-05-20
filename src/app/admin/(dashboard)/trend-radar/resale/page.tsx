import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { computeRetentionFactor, classifyRetention } from './_logic'

export const dynamic = 'force-dynamic'

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
}
interface ResaleLatestRow {
  product_id: string
  by_source: Record<string, any>
  price_ratio_avg: number | null
  days_to_sold_avg: number | null
  sold_completed_ratio_avg: number | null
  listings_active_total: number | null
  sold_count_30d_total: number | null
  last_collected_at: string | null
}
interface ScoreRow {
  product_id: string
  final_score: number
  retention_factor: number | null
}

async function fetchData() {
  const sb = createAdminClient()

  // resale_latest 뷰 — service-role 직접 조회
  const { data: resale } = await sb
    .from('jimscanner_trends_resale_latest' as never)
    .select('*')
    .limit(200)
  const resaleRows = (resale ?? []) as ResaleLatestRow[]

  if (resaleRows.length === 0) {
    return { rows: [], totalProducts: 0 }
  }

  const productIds = resaleRows.map((r) => r.product_id)
  const [{ data: products }, { data: scores }] = await Promise.all([
    sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top')
      .in('id', productIds),
    sb
      .from('jimscanner_trends_scores')
      .select('product_id, final_score, retention_factor, computed_at')
      .in('product_id', productIds)
      .order('computed_at', { ascending: false })
      .limit(1000),
  ])

  // product_id 별 최신 score
  const seen = new Set<string>()
  const scoreMap = new Map<string, ScoreRow>()
  for (const s of (scores ?? []) as any[]) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    scoreMap.set(s.product_id, s)
  }
  const prodMap = new Map<string, ProductRow>()
  for (const p of (products ?? []) as ProductRow[]) prodMap.set(p.id, p)

  const rows = resaleRows
    .map((r) => {
      const p = prodMap.get(r.product_id)
      const s = scoreMap.get(r.product_id)
      if (!p) return null
      const retention = computeRetentionFactor(r)
      const cls = classifyRetention(r, retention)
      return { product: p, resale: r, score: s, retention, cls }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    // 빨강 (후회구매) 가장 위로, 그다음 회색, 마지막 초록
    .sort((a, b) => {
      const ord = { red: 0, gray: 1, green: 2 } as const
      const oa = ord[a.cls.tone]
      const ob = ord[b.cls.tone]
      if (oa !== ob) return oa - ob
      return (a.retention ?? 1) - (b.retention ?? 1)
    })

  return { rows, totalProducts: rows.length }
}

export default async function ResalePage() {
  const { rows, totalProducts } = await fetchData()

  const redCount = rows.filter((r) => r.cls.tone === 'red').length
  const greenCount = rows.filter((r) => r.cls.tone === 'green').length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <Link href="/admin/trend-radar" className="text-sm text-gray-500 hover:text-black">
            ← 트렌드 레이더
          </Link>
          <h1 className="text-2xl font-bold mt-1">중고시장 잔존가치 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            구매 직후 만족 신호 — 중고 매물밀도·잔존가·회전속도. 후회구매 카테고리 사전 차단.
          </p>
        </div>
        <div className="text-xs text-gray-500 text-right">
          소스: 당근 · 번개장터 · 중고나라
          <br />
          수집기: <code className="font-mono">scripts/collect-resale.mjs</code>
        </div>
      </header>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="추적 상품" value={totalProducts} hint="resale 시그널 수집됨" />
        <KpiCard label="🔴 후회구매 의심" value={redCount} hint="잔존가↓ + 매물↑" tone="red" />
        <KpiCard label="🟢 회전 양호" value={greenCount} hint="잔존가↑ + 회전↑" tone="green" />
        <KpiCard
          label="🟡 관찰"
          value={totalProducts - redCount - greenCount}
          hint="중립"
        />
      </section>

      {totalProducts === 0 ? (
        <EmptyState />
      ) : (
        <section className="space-y-2">
          <div className="grid grid-cols-12 px-3 py-1 text-xs text-gray-500">
            <div className="col-span-1">tone</div>
            <div className="col-span-3">상품명</div>
            <div className="col-span-1 text-right">잔존가</div>
            <div className="col-span-1 text-right">회전(일)</div>
            <div className="col-span-1 text-right">완료비</div>
            <div className="col-span-1 text-right">활성매물</div>
            <div className="col-span-1 text-right">30d완료</div>
            <div className="col-span-1 text-right">retention</div>
            <div className="col-span-1 text-right">final</div>
            <div className="col-span-1 text-right">최근</div>
          </div>
          {rows.map(({ product, resale, score, retention, cls }) => (
            <Link
              key={product.id}
              href={`/admin/trend-radar/products/${product.id}`}
              className={`grid grid-cols-12 px-3 py-2 rounded border transition-colors ${
                cls.tone === 'red'
                  ? 'border-red-300 bg-red-50 hover:bg-red-100'
                  : cls.tone === 'green'
                    ? 'border-emerald-300 bg-emerald-50 hover:bg-emerald-100'
                    : 'border-gray-200 hover:bg-gray-50'
              }`}
            >
              <div className="col-span-1">
                <ToneBadge tone={cls.tone} label={cls.label} />
              </div>
              <div className="col-span-3">
                <div className="font-medium truncate">{product.canonical_name}</div>
                <div className="text-xs text-gray-500">{product.category_top}</div>
              </div>
              <div className="col-span-1 text-right font-mono">
                {fmtPct(resale.price_ratio_avg)}
              </div>
              <div className="col-span-1 text-right font-mono">
                {fmtNum(resale.days_to_sold_avg, 0)}
              </div>
              <div className="col-span-1 text-right font-mono">
                {fmtPct(resale.sold_completed_ratio_avg)}
              </div>
              <div className="col-span-1 text-right font-mono">
                {resale.listings_active_total ?? '—'}
              </div>
              <div className="col-span-1 text-right font-mono">
                {resale.sold_count_30d_total ?? '—'}
              </div>
              <div className="col-span-1 text-right font-mono font-semibold">
                {retention != null ? retention.toFixed(2) : '—'}
              </div>
              <div className="col-span-1 text-right font-mono text-gray-600">
                {score?.final_score ?? '—'}
              </div>
              <div className="col-span-1 text-right text-xs text-gray-400">
                {resale.last_collected_at?.slice(5, 10) ?? '—'}
              </div>
            </Link>
          ))}
        </section>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4">
        <h3 className="font-semibold text-gray-700 mb-1">3축 해석</h3>
        <ul className="space-y-1 list-disc list-inside">
          <li>
            <b>잔존가</b> = 중고 평균가 / 신품 참고가. 낮을수록 (≤0.4) 후회구매 의심.
          </li>
          <li>
            <b>회전(일)</b> = days-to-sold 중간값. 짧을수록 (≤14) 수요 강함.
          </li>
          <li>
            <b>활성/30d완료</b> 비율 = 매물밀도. 높을수록 처분압력 누적.
          </li>
          <li>
            <b>retention_factor</b> = 위 3축을 0~1 로 압축. <code>final_score *= retention</code>{' '}
            게이팅에 사용.
          </li>
        </ul>
      </section>
    </div>
  )
}

function KpiCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: number
  hint: string
  tone?: 'red' | 'green'
}) {
  const ring =
    tone === 'red'
      ? 'border-red-300 bg-red-50'
      : tone === 'green'
        ? 'border-emerald-300 bg-emerald-50'
        : 'border-gray-200'
  return (
    <div className={`rounded border p-4 ${ring}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}

function ToneBadge({ tone, label }: { tone: 'red' | 'green' | 'gray'; label: string }) {
  const cls =
    tone === 'red'
      ? 'bg-red-200 text-red-900'
      : tone === 'green'
        ? 'bg-emerald-200 text-emerald-900'
        : 'bg-gray-200 text-gray-700'
  return <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${cls}`}>{label}</span>
}

function EmptyState() {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
      <p className="text-base font-medium">아직 resale 시그널이 없습니다</p>
      <p className="text-sm mt-2">
        WSL/로컬에서{' '}
        <code className="px-1 bg-gray-100 rounded">
          node --env-file=.env.local scripts/collect-resale.mjs
        </code>{' '}
        실행 후 갱신됩니다.
      </p>
    </div>
  )
}

function fmtNum(v: number | null | undefined, digits = 2) {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}
function fmtPct(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${(v * 100).toFixed(0)}%`
}
