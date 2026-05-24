import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import MoqWindowScatter from './MoqWindowScatter'

export const dynamic = 'force-dynamic'

export interface MoqRow {
  product_id: string
  supplier_id: string
  canonical_name: string
  category_top: string
  supplier_source: string
  supplier_url: string | null
  moq: number
  price_krw: number | null
  capital_locked_krw: number
  trend_score: number | null
  commerce_score: number | null
  final_score: number | null
  weekly_sales_estimate: number
  weeks_of_supply: number
  days_to_clear: number
  gate: 'green' | 'yellow' | 'red'
}

async function fetchRows(): Promise<{ rows: MoqRow[]; error: string | null }> {
  const sb = createAdminClient()
  // RPC: supabase/trends_v4_moq_absorption.sql — types 미반영, 캐스팅 유지.
  const { data, error } = await sb.rpc('jimscanner_moq_absorption_window' as never, {
    p_product_id: null,
    p_supplier_id: null,
    p_min_moq: 1,
    p_result_limit: 500,
  } as never)
  if (error) return { rows: [], error: error.message }
  return { rows: (data ?? []) as MoqRow[], error: null }
}

function gateCounts(rows: MoqRow[]) {
  return rows.reduce(
    (acc, r) => {
      acc[r.gate] = (acc[r.gate] ?? 0) + 1
      return acc
    },
    { green: 0, yellow: 0, red: 0 } as Record<'green' | 'yellow' | 'red', number>,
  )
}

function fmtKrw(n: number | null | undefined): string {
  if (!n || !isFinite(n)) return '-'
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}억`
  if (n >= 10_000) return `${(n / 10_000).toFixed(0)}만`
  return `${Math.round(n).toLocaleString()}`
}

export default async function MoqWindowPage() {
  const { rows, error } = await fetchRows()
  const counts = gateCounts(rows)
  const totalCapital = rows.reduce((s, r) => s + (r.capital_locked_krw ?? 0), 0)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">MOQ 흡수 기간 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            X = MOQ 소진 예상일 · Y = final_score · 색 = 자본 잠김 게이트 (녹:&lt;4주 / 황:4-12주 / 적:&gt;12주)
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 text-red-700 text-sm px-4 py-3">
          RPC 오류: {error}
          <div className="mt-1 text-xs text-red-500">
            supabase/trends_v4_moq_absorption.sql 적용 필요.
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <SummaryCard label="🟢 < 4주" value={counts.green} tone="green" />
        <SummaryCard label="🟡 4-12주" value={counts.yellow} tone="yellow" />
        <SummaryCard label="🔴 > 12주" value={counts.red} tone="red" />
        <SummaryCard label="총 자본 잠김(추정)" value={fmtKrw(totalCapital)} tone="gray" />
      </div>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          {error
            ? 'RPC 적용 후 다시 방문.'
            : '아직 supplier MOQ 데이터 없음. cron 누적 후 다시 방문.'}
        </div>
      ) : (
        <>
          <MoqWindowScatter rows={rows} />

          <section className="space-y-2">
            <h2 className="text-sm font-semibold">🟢 자본 회전 양호 (MOQ &lt; 4주)</h2>
            <RowsTable rows={rows.filter((r) => r.gate === 'green').slice(0, 20)} />
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-red-700">
              🔴 자본 잠김 경고 (MOQ &gt; 12주) — 진입 비추천
            </h2>
            <RowsTable rows={rows.filter((r) => r.gate === 'red').slice(0, 20)} />
          </section>
        </>
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
  value: number | string
  tone: 'green' | 'yellow' | 'red' | 'gray'
}) {
  const toneClass = {
    green: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    yellow: 'border-amber-200 bg-amber-50 text-amber-800',
    red: 'border-red-200 bg-red-50 text-red-800',
    gray: 'border-gray-200 bg-gray-50 text-gray-800',
  }[tone]
  return (
    <div className={`rounded border px-4 py-3 ${toneClass}`}>
      <div className="text-xs">{label}</div>
      <div className="text-xl font-semibold mt-1">{value}</div>
    </div>
  )
}

function RowsTable({ rows }: { rows: MoqRow[] }) {
  if (rows.length === 0) {
    return <div className="text-xs text-gray-400">해당 구간 없음.</div>
  }
  return (
    <div className="rounded border border-gray-200 overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 text-xs text-gray-500">
          <tr>
            <th className="px-3 py-2 text-left">상품</th>
            <th className="px-3 py-2 text-left">cate</th>
            <th className="px-3 py-2 text-left">supplier</th>
            <th className="px-3 py-2 text-right">MOQ</th>
            <th className="px-3 py-2 text-right">단가</th>
            <th className="px-3 py-2 text-right">자본 잠김</th>
            <th className="px-3 py-2 text-right">주간 추정</th>
            <th className="px-3 py-2 text-right">소진(주)</th>
            <th className="px-3 py-2 text-right">final</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => (
            <tr key={r.supplier_id} className="hover:bg-gray-50">
              <td className="px-3 py-2">
                <Link
                  href={`/admin/trend-radar/products/${r.product_id}`}
                  className="text-blue-600 hover:underline"
                >
                  {r.canonical_name}
                </Link>
              </td>
              <td className="px-3 py-2 text-xs text-gray-500">{r.category_top}</td>
              <td className="px-3 py-2 text-xs">
                {r.supplier_url ? (
                  <a href={r.supplier_url} target="_blank" rel="noreferrer" className="text-gray-700 underline">
                    {r.supplier_source}
                  </a>
                ) : (
                  r.supplier_source
                )}
              </td>
              <td className="px-3 py-2 text-right font-mono">{r.moq}</td>
              <td className="px-3 py-2 text-right font-mono">{fmtKrw(r.price_krw)}</td>
              <td className="px-3 py-2 text-right font-mono">{fmtKrw(r.capital_locked_krw)}</td>
              <td className="px-3 py-2 text-right font-mono">{r.weekly_sales_estimate.toFixed(1)}</td>
              <td className="px-3 py-2 text-right font-mono">{r.weeks_of_supply.toFixed(1)}</td>
              <td className="px-3 py-2 text-right font-mono">
                {r.final_score == null ? '-' : Math.round(r.final_score)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
