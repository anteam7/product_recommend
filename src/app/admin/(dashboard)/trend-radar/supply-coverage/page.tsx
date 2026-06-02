import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// 뷰: supabase/trends_supplier_coverage_view.sql (generated 타입 미반영 → as never 캐스팅)
interface CoverageRow {
  product_id: string
  supplier_count: number
  is_single_source: boolean
  ggsan_only: boolean
  price_min: number | null
  price_median: number | null
  price_max: number | null
  spread_krw: number | null
  spread_pct: number | null
  sources: string[] | null
}
interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
}
interface ScoreRow {
  product_id: string
  final_score: number
  supplier_score: number
  computed_at: string
}

interface BoardRow extends CoverageRow {
  name: string
  category: string
  final_score: number | null
}

async function fetchData(): Promise<{ rows: BoardRow[]; error: string | null }> {
  const sb = createAdminClient()

  // 1) 커버리지 뷰 (도매 공급원 집계)
  const { data: cov, error: covErr } = await sb
    .from('jimscanner_trends_supplier_coverage' as never)
    .select('*')
    .limit(2000)

  if (covErr) return { rows: [], error: covErr.message }

  const coverage = (cov ?? []) as unknown as CoverageRow[]
  if (coverage.length === 0) return { rows: [], error: null }

  const ids = coverage.map((c) => c.product_id)

  // 2) 상품명 / 카테고리
  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const prodById = new Map((prods ?? []).map((p: any) => [p.id, p as ProductRow]))

  // 3) 최신 final_score (product_id 별 latest)
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, supplier_score, computed_at')
    .in('product_id', ids)
    .order('computed_at', { ascending: false })
    .limit(4000)
  const scoreById = new Map<string, ScoreRow>()
  for (const s of (scores ?? []) as ScoreRow[]) {
    if (!scoreById.has(s.product_id)) scoreById.set(s.product_id, s)
  }

  const rows: BoardRow[] = coverage.map((c) => {
    const p = prodById.get(c.product_id)
    return {
      ...c,
      name: p?.canonical_name ?? '?',
      category: p?.category_top ?? '—',
      final_score: scoreById.get(c.product_id)?.final_score ?? null,
    }
  })

  return { rows, error: null }
}

function won(n: number | null | undefined): string {
  if (n == null) return '—'
  return `${Math.round(n).toLocaleString()}원`
}

export default async function SupplyCoveragePage() {
  const { rows, error } = await fetchData()

  // 정렬: 회복탄력적(다공급원) 먼저 보고 싶을 수도 있으나, 리스크 가시화가 목적이라
  //       단일출처(적색) → 공급원 적은 순 → 스프레드 큰 순.
  const sorted = [...rows].sort((a, b) => {
    if (a.is_single_source !== b.is_single_source) return a.is_single_source ? -1 : 1
    if (a.supplier_count !== b.supplier_count) return a.supplier_count - b.supplier_count
    return (b.spread_pct ?? 0) - (a.spread_pct ?? 0)
  })

  // KPI
  const total = rows.length
  const singleCount = rows.filter((r) => r.is_single_source).length
  const resilientCount = rows.filter((r) => r.supplier_count >= 2).length
  const ggsanOnlyCount = rows.filter((r) => r.ggsan_only).length
  const arbitrageRows = rows.filter((r) => (r.spread_pct ?? 0) >= 0.1)

  // 2차 공급원 탐색 큐: 고점수(final ≥ 40)인데 단일출처 → 수집기 다음 작업
  const sourcingQueue = rows
    .filter((r) => r.is_single_source && (r.final_score ?? 0) >= 40)
    .sort((a, b) => (b.final_score ?? 0) - (a.final_score ?? 0))
    .slice(0, 30)

  // 스프레드 막대 정규화용 최대값
  const maxSpreadPct = Math.max(0.01, ...rows.map((r) => r.spread_pct ?? 0))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🧬 도매 공급원 커버리지 & 차익 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            후보별 공급원 개수 · 단일출처 리스크 게이트 · 도매처 간 가격 스프레드(전환 차익)
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          뷰 조회 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            뷰 <code>jimscanner_trends_supplier_coverage</code> 미적용 가능성.
            <code className="ml-1">supabase/trends_supplier_coverage_view.sql</code> 를 psql 로 적용 필요.
          </p>
        </div>
      )}

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="커버리지 산출 상품" value={total} />
        <Kpi label="🔴 단일출처 (무방비)" value={singleCount} tone="red" />
        <Kpi label="🟢 회복탄력 (2+)" value={resilientCount} tone="green" />
        <Kpi label="ggsan 단독 의존" value={ggsanOnlyCount} tone="red" />
        <Kpi label="차익 기회 (≥10%)" value={arbitrageRows.length} tone={arbitrageRows.length > 0 ? 'green' : 'gray'} />
      </section>

      {/* 2차 공급원 탐색 큐 — 수집기 피드백 */}
      {sourcingQueue.length > 0 && (
        <section className="rounded border border-amber-300 bg-amber-50 p-4">
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-sm font-semibold text-amber-900">
              📋 2차 공급원 탐색 큐{' '}
              <span className="text-xs font-normal text-amber-700 ml-1">
                고점수(final ≥ 40)인데 단일출처 — 도매 수집기 다음 작업
              </span>
            </h2>
            <span className="text-xs text-amber-700">{sourcingQueue.length}건</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {sourcingQueue.map((r) => (
              <Link
                key={r.product_id}
                href={`/admin/trend-radar/products/${r.product_id}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-white px-3 py-1 text-xs hover:bg-amber-100"
                title={`final ${r.final_score} · 공급원 ${r.supplier_count} (${(r.sources ?? []).join(', ')})`}
              >
                <span className="font-medium truncate max-w-[180px]">{r.name}</span>
                <span className="font-mono text-amber-700">{Number(r.final_score).toFixed(0)}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* 보드 테이블 */}
      {!error && sorted.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">공급원 데이터 없음</div>
          <div className="text-xs text-gray-400">
            도매 수집기(domeggook_main 등) 누적 후 자동 채워짐. 현재 supplier row 0건.
          </div>
        </div>
      ) : (
        <div className="rounded border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs">
              <tr>
                <th className="px-3 py-2 text-left">상품</th>
                <th className="px-3 py-2 text-center">공급원</th>
                <th className="px-3 py-2 text-right">최저가</th>
                <th className="px-3 py-2 text-right">중앙값</th>
                <th className="px-3 py-2 text-right">최고가</th>
                <th className="px-3 py-2 text-left w-48">스프레드 (전환 차익)</th>
                <th className="px-3 py-2 text-right">final</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sorted.map((r) => {
                const spreadPct = r.spread_pct ?? 0
                const barW = Math.min(100, Math.round((spreadPct / maxSpreadPct) * 100))
                return (
                  <tr
                    key={r.product_id}
                    className={r.is_single_source ? 'bg-red-50/50' : ''}
                  >
                    <td className="px-3 py-2">
                      <Link
                        href={`/admin/trend-radar/products/${r.product_id}`}
                        className="font-medium hover:underline"
                      >
                        {r.name}
                      </Link>
                      <div className="text-[11px] text-gray-400 mt-0.5">
                        {r.category} · {(r.sources ?? []).join(', ') || '—'}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
                          r.is_single_source
                            ? 'bg-red-100 text-red-700'
                            : 'bg-green-100 text-green-700'
                        }`}
                        title={r.ggsan_only ? 'ggsan 단독 의존 — 품절/가격인상 무방비' : ''}
                      >
                        {r.is_single_source ? '🔴' : '🟢'} {r.supplier_count}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-green-700">{won(r.price_min)}</td>
                    <td className="px-3 py-2 text-right font-mono text-gray-500">{won(r.price_median)}</td>
                    <td className="px-3 py-2 text-right font-mono text-gray-500">{won(r.price_max)}</td>
                    <td className="px-3 py-2">
                      {spreadPct > 0 ? (
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 rounded bg-gray-100 overflow-hidden">
                            <div
                              className={`h-full ${spreadPct >= 0.2 ? 'bg-emerald-500' : 'bg-emerald-300'}`}
                              style={{ width: `${barW}%` }}
                            />
                          </div>
                          <span className="text-xs font-mono whitespace-nowrap">
                            {(spreadPct * 100).toFixed(0)}%
                            <span className="text-emerald-700 ml-1">+{won(r.spread_krw)}</span>
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-bold">
                      {r.final_score == null ? '—' : Number(r.final_score).toFixed(0)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 산출 기준</div>
        <p>
          <strong>공급원 개수</strong> = product_id 별 distinct supplier_source (도매처별 최신 수집 row).{' '}
          <strong className="text-red-700">🔴 단일출처</strong>는 1개 도매처에만 의존 → 품절·가격인상에 무방비.{' '}
          <strong className="text-green-700">🟢 2+</strong>는 회복탄력적.
        </p>
        <p>
          <strong>스프레드</strong> = (최고가 − 최저가) / 최저가. <strong>전환 차익</strong>은 최고가 도매처에서 최저가
          도매처로 소싱 전환 시 절감되는 매입가(₩). 스프레드 ≥ 10% 면 듀얼소싱으로 마진 개선 여지.
        </p>
        <p>
          하단 <strong>2차 공급원 탐색 큐</strong>는 점수는 높은데 단일출처인 후보 — 도매 수집기가 다음으로 2차 소싱을
          뚫어야 할 목록.
        </p>
      </section>
    </div>
  )
}

function Kpi({
  label,
  value,
  tone = 'gray',
}: {
  label: string
  value: number | string
  tone?: 'gray' | 'red' | 'green'
}) {
  const toneCls =
    tone === 'red'
      ? 'border-red-300 bg-red-50 text-red-700'
      : tone === 'green'
      ? 'border-green-300 bg-green-50 text-green-700'
      : 'border-gray-200'
  return (
    <div className={`rounded border p-3 ${toneCls}`}>
      <div className="text-xs opacity-70">{label}</div>
      <div className="text-2xl font-bold mt-1">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
