import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface ReadinessRow {
  product_id: string
  category_top: string | null
  category_mid: string | null
  matched_category_code: number | null
  mandatory_attr_count: number
  cert_required: boolean
  cert_type: string | null
  content_asset_score: number
  readiness_score: number
  computed_at: string
}

interface ScoreRow {
  product_id: string
  final_score: number
  computed_at: string
}

async function fetchData() {
  // 신규 테이블 — generated types 부재로 any 캐스팅 (service-role)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any

  // 최신 readiness (product_id 별 latest)
  const { data: readinessRows } = await sb
    .from('jimscanner_trends_listing_readiness')
    .select(
      'product_id, category_top, category_mid, matched_category_code, mandatory_attr_count, cert_required, cert_type, content_asset_score, readiness_score, computed_at',
    )
    .order('computed_at', { ascending: false })
    .limit(3000)

  const seen = new Set<string>()
  const latest: ReadinessRow[] = []
  for (const r of ((readinessRows ?? []) as ReadinessRow[])) {
    if (seen.has(r.product_id)) continue
    seen.add(r.product_id)
    latest.push(r)
  }

  if (latest.length === 0) return { rows: [] as Array<ReadinessRow & { name: string; final: number | null }> }

  const ids = latest.map((r) => r.product_id)

  // 상품 이름
  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name')
    .in('id', ids)
  const nameById = new Map((prods ?? []).map((p: { id: string; canonical_name: string }) => [p.id, p.canonical_name]))

  // 최신 final_score (기회 점수와 교차 — "점수 높고 등록 즉시 가능" 식별)
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(3000)
  const finalById = new Map<string, number>()
  for (const s of ((scores ?? []) as ScoreRow[])) {
    if (!finalById.has(s.product_id)) finalById.set(s.product_id, s.final_score)
  }

  const rows = latest.map((r) => ({
    ...r,
    name: (nameById.get(r.product_id) as string) ?? '?',
    final: finalById.has(r.product_id) ? (finalById.get(r.product_id) as number) : null,
  }))

  // 정렬: readiness 높은 순, 동률이면 final 높은 순
  rows.sort((a, b) => b.readiness_score - a.readiness_score || (b.final ?? 0) - (a.final ?? 0))
  return { rows }
}

function ReadinessBadge({ score }: { score: number }) {
  const cls =
    score >= 70
      ? 'bg-green-100 text-green-700'
      : score >= 45
        ? 'bg-amber-100 text-amber-700'
        : 'bg-red-100 text-red-700'
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-bold ${cls}`}>{score}</span>
}

export default async function ReadinessPage() {
  const { rows } = await fetchData()

  // "지금 등록 가능" = 인증 불필요 + readiness 높음, final 점수도 높으면 우선순위 ↑
  const goNow = rows.filter((r) => !r.cert_required && r.readiness_score >= 65)
  const highBarrier = rows.filter((r) => r.cert_required)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">등록 준비도 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            인증·필수속성·콘텐츠 자산으로 본 <b>등록까지의 운영 마찰</b>. 점수 높을수록 즉시 등록 가능 ·
            🔒 = 규제 인증 고장벽
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 데이터 없음. <code>compute-listing-readiness</code> cron 실행 후 다시 방문.
        </div>
      ) : (
        <>
          {/* 요약 카드 */}
          <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <SummaryCard label="전체 candidate" value={rows.length} />
            <SummaryCard label="🟢 즉시 등록 가능" value={goNow.length} tone="green" />
            <SummaryCard label="🔒 인증 고장벽" value={highBarrier.length} tone="red" />
            <SummaryCard
              label="평균 준비도"
              value={Math.round(rows.reduce((a, r) => a + r.readiness_score, 0) / rows.length)}
            />
          </section>

          {/* 즉시 등록 가능 우선 노출 (점수 높지만 등록 즉시 가능) */}
          {goNow.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold mb-2">🟢 점수 높고 즉시 등록 가능 (인증 불필요 · 준비도 ≥ 65)</h2>
              <ReadinessTable rows={goNow.slice(0, 30)} />
            </section>
          )}

          {/* 전체 보드 */}
          <section>
            <h2 className="text-sm font-semibold mb-2">전체 준비도 보드 (준비도 내림차순)</h2>
            <ReadinessTable rows={rows} />
          </section>
        </>
      )}
    </div>
  )
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone?: 'green' | 'red' }) {
  const color = tone === 'green' ? 'text-green-700' : tone === 'red' ? 'text-red-700' : 'text-gray-800'
  return (
    <div className="rounded border border-gray-200 p-3 text-center">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${color}`}>{value}</div>
    </div>
  )
}

function ReadinessTable({
  rows,
}: {
  rows: Array<ReadinessRow & { name: string; final: number | null }>
}) {
  return (
    <div className="rounded border border-gray-200 overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-gray-50 text-gray-500">
          <tr>
            <th className="px-3 py-2 text-left">상품</th>
            <th className="px-3 py-2 text-left">카테고리</th>
            <th className="px-3 py-2 text-center">준비도</th>
            <th className="px-3 py-2 text-center">인증</th>
            <th className="px-3 py-2 text-right">필수속성</th>
            <th className="px-3 py-2 text-right">콘텐츠</th>
            <th className="px-3 py-2 text-right">final</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => (
            <tr key={r.product_id} className="hover:bg-gray-50">
              <td className="px-3 py-2">
                <Link href={`/admin/trend-radar/products/${r.product_id}`} className="hover:underline">
                  {r.name}
                </Link>
              </td>
              <td className="px-3 py-2 text-gray-500">
                {r.category_top ?? '—'}
                {r.category_mid ? ` / ${r.category_mid}` : ''}
              </td>
              <td className="px-3 py-2 text-center">
                <ReadinessBadge score={r.readiness_score} />
              </td>
              <td className="px-3 py-2 text-center">
                {r.cert_required ? (
                  <span className="text-red-600 font-medium" title={r.cert_type ?? ''}>
                    🔒 {r.cert_type ?? '필요'}
                  </span>
                ) : (
                  <span className="text-green-600">없음</span>
                )}
              </td>
              <td className="px-3 py-2 text-right">{r.mandatory_attr_count}</td>
              <td className="px-3 py-2 text-right">{r.content_asset_score}</td>
              <td className="px-3 py-2 text-right font-mono text-gray-600">{r.final ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
