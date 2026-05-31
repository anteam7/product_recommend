import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface Evidence {
  signal_id: string
  title: string
  url: string | null
  risk_type: string
  matched_keywords: string[]
}

interface FlagRow {
  product_id: string
  risk_flag: 'green' | 'yellow' | 'red'
  opportunity: boolean
  signal_count: number
  top_risk_type: string | null
  evidence: Evidence[]
  computed_at: string
}

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string | null
  brand: string | null
}

const RISK_TYPE_LABEL: Record<string, string> = {
  recall: '리콜·회수',
  hazard: '위해정보',
  cert_required: '인증의무(KC/식약처/전안법)',
  penalty: '과징금·행정처분',
}

async function fetchData() {
  const sb = createAdminClient()

  const { data: flags } = await (sb as any)
    .from('jimscanner_compliance_flags')
    .select('product_id, risk_flag, opportunity, signal_count, top_risk_type, evidence, computed_at')
    .order('computed_at', { ascending: false })
    .limit(2000)

  const flagRows = (flags ?? []) as FlagRow[]
  const ids = flagRows.map((f) => f.product_id)
  let byId = new Map<string, ProductRow>()
  if (ids.length > 0) {
    const { data: prods } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top, brand')
      .in('id', ids)
    byId = new Map(((prods ?? []) as any[]).map((p) => [p.id, p as ProductRow]))
  }

  const enriched = flagRows.map((f) => ({ ...f, product: byId.get(f.product_id) ?? null }))

  const blocked = enriched.filter((r) => r.risk_flag === 'red')
  const watch = enriched.filter((r) => r.risk_flag === 'yellow' && !r.opportunity)
  const opportunities = enriched.filter((r) => r.opportunity)

  return { blocked, watch, opportunities, total: enriched.length }
}

function EvidenceList({ evidence }: { evidence: Evidence[] }) {
  return (
    <ul className="mt-1 space-y-0.5">
      {evidence.slice(0, 3).map((e, i) => (
        <li key={i} className="text-xs text-gray-500">
          <span className="font-medium text-gray-700">{RISK_TYPE_LABEL[e.risk_type] ?? e.risk_type}</span>
          {' · '}
          {e.url ? (
            <a href={e.url} target="_blank" rel="noreferrer" className="underline hover:text-black">
              {e.title}
            </a>
          ) : (
            e.title
          )}
          {e.matched_keywords.length > 0 && (
            <span className="ml-1 text-rose-500">[{e.matched_keywords.join(', ')}]</span>
          )}
        </li>
      ))}
    </ul>
  )
}

export default async function CompliancePage() {
  const { blocked, watch, opportunities, total } = await fetchData()

  return (
    <div className="space-y-8 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">규제·리콜 리스크 레이더</h1>
          <p className="mt-1 text-sm text-gray-500">
            KCA 보도자료·gov_notice·뉴스 신호로 발굴 상품의 위해 리스크를 매핑. 방어(격리) + 공격(리콜 공백 선점).
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 underline hover:text-black">
          ← 대시보드
        </Link>
      </header>

      {total === 0 && (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 매핑된 리스크 없음. <code>/api/cron/extract-compliance-risk</code> 누적 후 다시 방문.
        </div>
      )}

      {/* ① 방어 — red 격리 */}
      <section>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <span className="inline-block h-3 w-3 rounded-full bg-rose-500" />
          ① 방어 — 발굴 격리 ({blocked.length})
        </h2>
        <p className="mb-3 text-sm text-gray-500">
          리콜·위해·인증의무가 걸린 상품. 위탁 셀러 계정정지·과징금 리스크라 발굴 후보에서 제외할 것.
        </p>
        {blocked.length === 0 ? (
          <p className="text-sm text-gray-400">격리 대상 없음.</p>
        ) : (
          <div className="space-y-3">
            {blocked.map((r) => (
              <div key={r.product_id} className="rounded border border-rose-200 bg-rose-50 p-3">
                <div className="flex items-baseline justify-between">
                  <span className="font-medium text-gray-900">{r.product?.canonical_name ?? r.product_id}</span>
                  <span className="rounded bg-rose-600 px-2 py-0.5 text-xs font-semibold text-white">
                    RED · {RISK_TYPE_LABEL[r.top_risk_type ?? ''] ?? r.top_risk_type}
                  </span>
                </div>
                <div className="text-xs text-gray-500">
                  {r.product?.category_top ?? '?'} · 신호 {r.signal_count}건
                </div>
                <EvidenceList evidence={r.evidence} />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ② 공격 — 리콜 공백 선점 */}
      <section>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <span className="inline-block h-3 w-3 rounded-full bg-emerald-500" />
          ② 공격 — 리콜 공백 선점 ({opportunities.length})
        </h2>
        <p className="mb-3 text-sm text-gray-500">
          특정 브랜드가 리콜됐으나 카테고리 수요는 유지되는 공백. 1인 셀러가 가장 싸게 비집을 수 있는 선점 후보.
        </p>
        {opportunities.length === 0 ? (
          <p className="text-sm text-gray-400">포착된 공백 없음.</p>
        ) : (
          <div className="space-y-3">
            {opportunities.map((r) => (
              <div key={r.product_id} className="rounded border border-emerald-200 bg-emerald-50 p-3">
                <div className="flex items-baseline justify-between">
                  <span className="font-medium text-gray-900">{r.product?.canonical_name ?? r.product_id}</span>
                  <span className="rounded bg-emerald-600 px-2 py-0.5 text-xs font-semibold text-white">
                    공백 선점
                  </span>
                </div>
                <div className="text-xs text-gray-500">
                  {r.product?.category_top ?? '?'} · 우리 브랜드 {r.product?.brand ?? '미지정'} · 신호 {r.signal_count}건
                </div>
                <EvidenceList evidence={r.evidence} />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 주의 (yellow) */}
      {watch.length > 0 && (
        <section>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <span className="inline-block h-3 w-3 rounded-full bg-amber-400" />
            주의 관찰 ({watch.length})
          </h2>
          <div className="mt-2 space-y-2">
            {watch.map((r) => (
              <div key={r.product_id} className="rounded border border-amber-200 bg-amber-50 p-3">
                <div className="flex items-baseline justify-between">
                  <span className="font-medium text-gray-900">{r.product?.canonical_name ?? r.product_id}</span>
                  <span className="text-xs text-amber-700">
                    {RISK_TYPE_LABEL[r.top_risk_type ?? ''] ?? r.top_risk_type} · {r.signal_count}건
                  </span>
                </div>
                <EvidenceList evidence={r.evidence} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
