import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface IpRiskRow {
  product_id: string
  has_brand_store: boolean
  official_seller_terms: string[] | null
  official_seller_hits: number
  trademark_found: boolean
  owner_country: string | null
  parallel_import_suspect: boolean
  ggsan_min_price_krw: number | null
  serp_avg_price_krw: number | null
  price_ratio: number | null
  risk_score: number
  last_checked_at: string
}

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
  brand: string | null
}

async function fetchData() {
  const sb = createAdminClient()
  // jimscanner_trends_ip_risk 는 신규 마이그레이션 — types 미반영이므로 캐스팅.
  const { data: risks } = await (sb as any)
    .from('jimscanner_trends_ip_risk')
    .select(
      'product_id, has_brand_store, official_seller_terms, official_seller_hits, trademark_found, owner_country, parallel_import_suspect, ggsan_min_price_krw, serp_avg_price_krw, price_ratio, risk_score, last_checked_at',
    )
    .order('risk_score', { ascending: false })
    .order('last_checked_at', { ascending: false })
    .limit(500)

  const rows = (risks ?? []) as IpRiskRow[]
  const productIds = rows.map((r) => r.product_id)
  let productMap = new Map<string, ProductRow>()
  if (productIds.length > 0) {
    const { data: products } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top, brand')
      .in('id', productIds)
    for (const p of (products ?? []) as ProductRow[]) {
      productMap.set(p.id, p)
    }
  }

  const high = rows.filter((r) => r.risk_score >= 60).length
  const medium = rows.filter((r) => r.risk_score >= 30 && r.risk_score < 60).length
  const safe = rows.filter((r) => r.risk_score < 30).length
  const parallel = rows.filter((r) => r.parallel_import_suspect).length
  const lastCheck = rows.length > 0 ? rows[0].last_checked_at : null

  return { rows, productMap, kpis: { high, medium, safe, parallel, total: rows.length, lastCheck } }
}

function riskTone(score: number) {
  if (score >= 60) return { badge: 'bg-red-100 text-red-800 border-red-300', label: '⛔ 고위험' }
  if (score >= 30) return { badge: 'bg-amber-100 text-amber-800 border-amber-300', label: '⚠️ 주의' }
  return { badge: 'bg-emerald-100 text-emerald-800 border-emerald-300', label: '✅ 안전' }
}

export default async function IpRiskPage() {
  const { rows, productMap, kpis } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">상표권/병행수입 리스크</h1>
          <p className="text-sm text-gray-500 mt-1">
            위탁 진입 전 IP 차단 게이트 — 공식채널·정품인증·도매:시장가 비율 휴리스틱.
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 대시보드
        </Link>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <KpiCard label="평가 누적" value={kpis.total} hint="latest snapshot" />
        <KpiCard label="고위험 (≥60)" value={kpis.high} hint="진입 게이트" tone="red" />
        <KpiCard label="주의 (30~59)" value={kpis.medium} hint="추가 검증" tone="amber" />
        <KpiCard label="안전 (<30)" value={kpis.safe} hint="진행 가능" tone="emerald" />
        <KpiCard label="병행수입 의심" value={kpis.parallel} hint="가격비 ≥3x" tone="red" />
      </section>

      {kpis.lastCheck && (
        <p className="text-xs text-gray-500">
          마지막 스캔: {new Date(kpis.lastCheck).toLocaleString('ko-KR')}
        </p>
      )}

      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        <section>
          <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
            <div className="col-span-1">#</div>
            <div className="col-span-4">상품</div>
            <div className="col-span-1 text-right">위험도</div>
            <div className="col-span-1 text-center">브랜드샵</div>
            <div className="col-span-1 text-center">정품패턴</div>
            <div className="col-span-1 text-center">상표</div>
            <div className="col-span-1 text-center">병행</div>
            <div className="col-span-2 text-right">ggsan / SERP</div>
          </div>

          <div className="space-y-1">
            {rows.map((r, i) => {
              const p = productMap.get(r.product_id)
              const tone = riskTone(r.risk_score)
              return (
                <Link
                  key={r.product_id}
                  href={`/admin/trend-radar/products/${r.product_id}`}
                  className={`grid grid-cols-12 px-3 py-2 rounded border transition-colors items-center ${
                    r.risk_score >= 60
                      ? 'border-red-200 bg-red-50/40 hover:bg-red-50'
                      : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <div className="col-span-1 text-gray-400 font-mono">{i + 1}</div>
                  <div className="col-span-4">
                    <div className="font-medium">{p?.canonical_name ?? r.product_id}</div>
                    <div className="text-xs text-gray-500">
                      {p?.category_top ?? '?'}
                      {p?.brand ? ` · ${p.brand}` : ''}
                    </div>
                  </div>
                  <div className="col-span-1 text-right">
                    <span
                      className={`inline-block px-2 py-0.5 text-xs rounded border font-mono ${tone.badge}`}
                    >
                      {r.risk_score}
                    </span>
                  </div>
                  <div className="col-span-1 text-center text-xs">
                    {r.has_brand_store ? '✓' : '—'}
                  </div>
                  <div className="col-span-1 text-center text-xs">
                    {r.official_seller_hits > 0 ? `${r.official_seller_hits}` : '—'}
                  </div>
                  <div className="col-span-1 text-center text-xs">
                    {r.trademark_found
                      ? `✓${r.owner_country ? ` (${r.owner_country})` : ''}`
                      : '—'}
                  </div>
                  <div className="col-span-1 text-center text-xs">
                    {r.parallel_import_suspect ? '🚨' : '—'}
                  </div>
                  <div className="col-span-2 text-right text-xs text-gray-600 font-mono">
                    {r.ggsan_min_price_krw && r.serp_avg_price_krw
                      ? `${Math.round(r.ggsan_min_price_krw).toLocaleString()} / ${Math.round(r.serp_avg_price_krw).toLocaleString()}${r.price_ratio ? ` (×${r.price_ratio.toFixed(1)})` : ''}`
                      : '—'}
                  </div>
                </Link>
              )
            })}
          </div>

          <div className="mt-6 rounded border border-gray-200 bg-gray-50 p-4 text-xs text-gray-600 space-y-1">
            <p className="font-semibold text-gray-700">스코어 가중치</p>
            <p>• 브랜드스토어 매칭 +25 · 공식 셀러 패턴 hit×10 (max 30)</p>
            <p>• 상표 등록 +20 (외국 권리자 +10) · 병행수입 의심 +25</p>
            <p>• KIPRIS API 미연결 — 현재는 휴리스틱 (`check_source = local_heuristic`)</p>
          </div>
        </section>
      )}
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
  tone?: 'red' | 'amber' | 'emerald'
}) {
  const ring =
    tone === 'red'
      ? 'border-red-200 bg-red-50/60'
      : tone === 'amber'
        ? 'border-amber-200 bg-amber-50/60'
        : tone === 'emerald'
          ? 'border-emerald-200 bg-emerald-50/60'
          : 'border-gray-200'
  return (
    <div className={`rounded border p-4 ${ring}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
      <p className="text-base font-medium">아직 스캔된 IP 리스크가 없습니다</p>
      <p className="text-sm mt-2">
        로컬 cron 마지막 단계로{' '}
        <code className="px-1 bg-gray-100 rounded">scripts/check-trends-ip-risk.mjs</code>
        가 돌면 누적됩니다.
      </p>
    </div>
  )
}
