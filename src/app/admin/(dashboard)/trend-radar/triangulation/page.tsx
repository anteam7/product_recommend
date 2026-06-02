import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface TriRow {
  product_id: string
  canonical_name: string
  category_top: string
  total_aliases: number
  family_count: number
  commerce_n: number
  community_n: number
  news_n: number
  tv_n: number
  wholesale_n: number
  other_n: number
  corroboration: number
  trend_score: number | null
  final_score: number | null
  last_seen_at: string
}

const CATEGORY_OPTIONS = [
  { v: '', label: '전체' },
  { v: 'health', label: 'health' },
  { v: 'living', label: 'living' },
  { v: 'digital', label: 'digital' },
] as const

// 패밀리 5칸 신호등 매트릭스 정의
const FAMILIES = [
  { key: 'commerce_n', label: '커머스', short: 'C' },
  { key: 'community_n', label: '커뮤니티', short: 'M' },
  { key: 'news_n', label: '뉴스', short: 'N' },
  { key: 'tv_n', label: 'TV', short: 'T' },
  { key: 'wholesale_n', label: '도매', short: 'W' },
] as const

async function fetchData(opts: { category: string; minFamilies: number }) {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_trends_triangulation' as never, {
    category_filter: opts.category || null,
    min_families: opts.minFamilies,
    result_limit: 300,
  } as never)
  if (error) {
    console.error('triangulation rpc error', error)
    return [] as TriRow[]
  }
  return (data ?? []) as unknown as TriRow[]
}

// 확증 강도 판정 — 1패밀리·단일출처 = 취약, 3+ 패밀리 = 강한 베팅
function verdict(r: TriRow): { label: string; cls: string; rank: number } {
  if (r.family_count >= 3) {
    // 커머스+커뮤니티+도매 동시면 실수요 확정에 가까움
    const triCore = r.commerce_n > 0 && r.community_n > 0 && r.wholesale_n > 0
    if (triCore) return { label: '강한 베팅', cls: 'bg-emerald-100 text-emerald-800 border-emerald-300', rank: 0 }
    return { label: '다출처 확증', cls: 'bg-green-50 text-green-700 border-green-200', rank: 1 }
  }
  if (r.family_count === 2) return { label: '교차 신호', cls: 'bg-amber-50 text-amber-700 border-amber-200', rank: 2 }
  // 단일 패밀리 — 단일출처면 더 취약
  if (r.total_aliases <= 1) return { label: '취약(봇/시딩 의심)', cls: 'bg-red-50 text-red-700 border-red-200', rank: 4 }
  return { label: '단일 패밀리', cls: 'bg-gray-100 text-gray-600 border-gray-200', rank: 3 }
}

function cell(n: number) {
  // 신호등: 0 = 회색, 1-2 = 약함, 3+ = 강함
  const cls =
    n === 0
      ? 'bg-gray-100 text-gray-300'
      : n >= 3
        ? 'bg-emerald-500 text-white'
        : 'bg-emerald-200 text-emerald-900'
  return (
    <td className="px-1 py-1 text-center">
      <span className={`inline-flex h-7 w-7 items-center justify-center rounded text-xs font-semibold ${cls}`}>
        {n > 0 ? n : ''}
      </span>
    </td>
  )
}

export default async function TriangulationPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; min?: string }>
}) {
  const sp = await searchParams
  const category = sp.category ?? ''
  const minFamilies = Math.max(1, Math.min(5, Number(sp.min ?? '1') || 1))
  const rows = await fetchData({ category, minFamilies })

  const strong = rows.filter((r) => verdict(r).rank <= 1).length
  const fragile = rows.filter((r) => verdict(r).rank >= 4).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">교차출처 삼각검증 보드</h1>
          <p className="mt-1 text-sm text-gray-500">
            18종 수집원을 5개 출처 패밀리로 묶어 <strong>독립성 가중 확증도</strong>로 정렬 — 단일출처 노이즈(봇·프로모
            시딩) vs 다출처 실수요를 분리한다.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 underline hover:text-black">
          ← 대시보드
        </Link>
      </header>

      {/* 요약 + 필터 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm text-emerald-800">
          강한 베팅·확증 <strong>{strong}</strong>
        </div>
        <div className="rounded border border-red-200 bg-red-50 px-3 py-1.5 text-sm text-red-700">
          취약(강등) <strong>{fragile}</strong>
        </div>
        <div className="ml-auto flex items-center gap-2 text-sm">
          <span className="text-gray-500">카테고리</span>
          {CATEGORY_OPTIONS.map((o) => (
            <Link
              key={o.v}
              href={`?category=${o.v}&min=${minFamilies}`}
              className={`rounded border px-2 py-1 ${
                category === o.v ? 'border-gray-800 bg-gray-800 text-white' : 'border-gray-300 text-gray-600'
              }`}
            >
              {o.label}
            </Link>
          ))}
          <span className="ml-2 text-gray-500">최소 패밀리</span>
          {[1, 2, 3].map((m) => (
            <Link
              key={m}
              href={`?category=${category}&min=${m}`}
              className={`rounded border px-2 py-1 ${
                minFamilies === m ? 'border-gray-800 bg-gray-800 text-white' : 'border-gray-300 text-gray-600'
              }`}
            >
              {m}+
            </Link>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          조건에 맞는 상품 없음. alias 누적 후 다시 방문하거나 최소 패밀리를 낮춰보세요.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">상품</th>
                <th className="px-2 py-2 text-center">카테고리</th>
                {FAMILIES.map((f) => (
                  <th key={f.key} className="px-1 py-2 text-center" title={f.label}>
                    {f.label}
                  </th>
                ))}
                <th className="px-2 py-2 text-center">패밀리</th>
                <th className="px-2 py-2 text-right">확증도</th>
                <th className="px-2 py-2 text-right">trend</th>
                <th className="px-3 py-2 text-left">판정</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => {
                const v = verdict(r)
                return (
                  <tr key={r.product_id} className={v.rank === 0 ? 'bg-emerald-50/40' : undefined}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-800">{r.canonical_name}</div>
                      <div className="text-xs text-gray-400">alias {r.total_aliases}개</div>
                    </td>
                    <td className="px-2 py-2 text-center text-xs text-gray-500">{r.category_top}</td>
                    {cell(r.commerce_n)}
                    {cell(r.community_n)}
                    {cell(r.news_n)}
                    {cell(r.tv_n)}
                    {cell(r.wholesale_n)}
                    <td className="px-2 py-2 text-center font-semibold text-gray-700">{r.family_count}/5</td>
                    <td className="px-2 py-2 text-right">
                      <span className="font-mono font-semibold text-gray-800">{Number(r.corroboration).toFixed(0)}</span>
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-gray-500">
                      {r.trend_score != null ? Number(r.trend_score).toFixed(0) : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${v.cls}`}>
                        {v.label}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <section className="rounded border border-dashed border-gray-300 p-4 text-xs text-gray-500">
        <strong className="text-gray-700">확증도(corroboration)</strong> = 100 × (1 − ∏ₘ(1 − qₘ)). 각 패밀리를 독립
        증거원으로 보고 alias 수·평균 confidence 로 qₘ 산출 → 패밀리가 많을수록 신뢰도가 기하급수적으로 상승(1패밀리
        ~60, 2패밀리 ~84, 3패밀리 ~93). 이 값은 <code>score_components.trend.source_consensus</code> 로 환류될 후보다.
        <strong className="text-gray-700"> 신호등</strong>: 진한 초록 = 패밀리 내 alias 3+, 연한 초록 = 1~2, 회색 = 없음.
      </section>
    </div>
  )
}
