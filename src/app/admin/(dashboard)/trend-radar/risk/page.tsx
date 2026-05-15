import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface RegulationRow {
  product_id: string
  risk_tags: string[]
  hs_code_guess: string | null
  kc_required: boolean
  kc_children: boolean
  mfds_required: boolean
  food_related: boolean
  cosmetic: boolean
  electric: boolean
  battery: boolean
  severity: number
  source: string
  summary: string | null
  classified_at: string
}

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
  brand: string | null
}

const SEVERITY_LABEL: Record<number, string> = {
  3: '🔴 고위험',
  2: '🟠 주의',
  1: '🟡 경고',
  0: '⚪ 무관',
}

const SEVERITY_BG: Record<number, string> = {
  3: 'bg-red-100 text-red-800 border-red-300',
  2: 'bg-orange-100 text-orange-800 border-orange-300',
  1: 'bg-amber-50 text-amber-800 border-amber-200',
  0: 'bg-gray-50 text-gray-500 border-gray-200',
}

async function fetchData() {
  const sb = createAdminClient()

  const { data: regs } = await (sb as any)
    .from('jimscanner_trends_regulation')
    .select('*')
    .gte('severity', 1)
    .order('severity', { ascending: false })
    .order('classified_at', { ascending: false })
    .limit(500)

  const rows = (regs ?? []) as RegulationRow[]
  const ids = rows.map((r) => r.product_id)
  if (ids.length === 0) return { rows: [], productMap: new Map<string, ProductRow>() }

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, brand')
    .in('id', ids)
  const productMap = new Map<string, ProductRow>(
    ((prods ?? []) as ProductRow[]).map((p) => [p.id, p]),
  )
  return { rows, productMap }
}

export default async function RiskPage() {
  const { rows, productMap } = await fetchData()

  const bySeverity = {
    3: rows.filter((r) => r.severity === 3),
    2: rows.filter((r) => r.severity === 2),
    1: rows.filter((r) => r.severity === 1),
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">규제 리스크 라벨러</h1>
          <p className="text-sm text-gray-500 mt-1">
            KC 인증·식약처 신고·HS 코드 등 위탁 진입 시 통관·판매 리스크. severity ≥ 1 만 표시.
          </p>
          <p className="text-xs text-gray-400 mt-1 font-mono">
            run: <code>node --env-file=.env.local scripts/classify-regulation.mjs</code>
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 요약 카드 */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard label="고위험 (3)" value={bySeverity[3].length} tone="red" />
        <SummaryCard label="주의 (2)" value={bySeverity[2].length} tone="orange" />
        <SummaryCard label="경고 (1)" value={bySeverity[1].length} tone="amber" />
        <SummaryCard label="총 라벨링" value={rows.length} tone="gray" />
      </section>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 라벨링 데이터 없음. <code>scripts/classify-regulation.mjs</code> 를 먼저 실행.
        </div>
      ) : (
        <section>
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left w-24">severity</th>
                  <th className="px-3 py-2 text-left">상품</th>
                  <th className="px-3 py-2 text-left w-20">카테고리</th>
                  <th className="px-3 py-2 text-left">리스크 태그</th>
                  <th className="px-3 py-2 text-left w-32">HS 코드</th>
                  <th className="px-3 py-2 text-left">요약</th>
                  <th className="px-3 py-2 text-left w-16">source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => {
                  const p = productMap.get(r.product_id)
                  return (
                    <tr key={r.product_id} className="hover:bg-gray-50">
                      <td className="px-3 py-2">
                        <span
                          className={`inline-block px-2 py-0.5 rounded border text-xs font-medium ${SEVERITY_BG[r.severity]}`}
                        >
                          {SEVERITY_LABEL[r.severity] ?? r.severity}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <Link
                          href={`/admin/trend-radar/products/${r.product_id}`}
                          className="font-medium text-blue-700 hover:underline"
                        >
                          {p?.canonical_name ?? '—'}
                        </Link>
                        {p?.brand && (
                          <span className="ml-2 text-xs text-gray-500">{p.brand}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-500">{p?.category_top ?? '—'}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {(r.risk_tags ?? []).slice(0, 4).map((t, i) => (
                            <span
                              key={i}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 font-mono"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs font-mono text-gray-600">
                        {r.hs_code_guess ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-700">{r.summary ?? '—'}</td>
                      <td className="px-3 py-2 text-[10px] font-mono text-gray-400">{r.source}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'red' | 'orange' | 'amber' | 'gray'
}) {
  const toneClass = {
    red: 'bg-red-50 border-red-200 text-red-800',
    orange: 'bg-orange-50 border-orange-200 text-orange-800',
    amber: 'bg-amber-50 border-amber-200 text-amber-800',
    gray: 'bg-gray-50 border-gray-200 text-gray-700',
  }[tone]
  return (
    <div className={`rounded border ${toneClass} p-3 text-center`}>
      <div className="text-xs uppercase opacity-70">{label}</div>
      <div className="mt-1 text-3xl font-bold">{value}</div>
    </div>
  )
}
