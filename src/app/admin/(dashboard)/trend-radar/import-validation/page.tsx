import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import ImportValidationMatrix from './ImportValidationMatrix'

export const dynamic = 'force-dynamic'

interface MatchRow {
  product_id: string
  canonical_name: string
  category_top: string | null
  category_mid: string | null
  brand: string | null
  manifest_count_90d: number
  manifest_count_30d: number
  single_item_count_90d: number
  single_item_ratio: number
  top_category_tag: string | null
  top_brand_raw: string | null
  countries: string[]
  import_demand_score: number
  import_demand_components: Record<string, unknown>
}

interface ScoreRow {
  product_id: string
  trend_score: number
  commerce_score: number
  final_score: number
  computed_at: string
}

async function fetchData() {
  const sb = createAdminClient()

  // 1) RPC 로 매니페스트 매칭 (전체 후보)
  const { data: matchData, error: matchErr } = await sb.rpc(
    'jimscanner_match_trend_to_manifest' as any,
    { min_sim: 0.25, product_id_filter: null } as any,
  )

  const matches: MatchRow[] = ((matchData as any[]) ?? []).map((r) => ({
    product_id: r.product_id,
    canonical_name: r.canonical_name,
    category_top: r.category_top ?? null,
    category_mid: r.category_mid ?? null,
    brand: r.brand ?? null,
    manifest_count_90d: Number(r.manifest_count_90d ?? 0),
    manifest_count_30d: Number(r.manifest_count_30d ?? 0),
    single_item_count_90d: Number(r.single_item_count_90d ?? 0),
    single_item_ratio: Number(r.single_item_ratio ?? 0),
    top_category_tag: r.top_category_tag ?? null,
    top_brand_raw: r.top_brand_raw ?? null,
    countries: (r.countries as string[]) ?? [],
    import_demand_score: Number(r.import_demand_score ?? 0),
    import_demand_components: (r.import_demand_components as Record<string, unknown>) ?? {},
  }))

  // 2) 트렌드 모멘텀 (최신 score 만)
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, trend_score, commerce_score, final_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(2000)

  const seen = new Set<string>()
  const latest: ScoreRow[] = []
  for (const s of (scores ?? []) as ScoreRow[]) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latest.push(s)
  }
  const scoreById = new Map(latest.map((s) => [s.product_id, s]))

  // 3) 매니페스트 전체 카테고리 분포 (top 카테고리별 송장 수, 90일)
  const { data: byCat } = await sb
    .from('jimscanner_manifest_items')
    .select('category_tag, source_country, is_single_item_invoice')
    .eq('is_outlier', false)
    .gte('imported_at', new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString())
    .limit(50000)

  const catAgg = new Map<string, { total: number; single: number }>()
  for (const r of (byCat ?? []) as Array<{ category_tag: string | null; is_single_item_invoice: boolean }>) {
    const tag = r.category_tag ?? '(unknown)'
    const cur = catAgg.get(tag) ?? { total: 0, single: 0 }
    cur.total += 1
    if (r.is_single_item_invoice) cur.single += 1
    catAgg.set(tag, cur)
  }
  const catRows = Array.from(catAgg.entries())
    .map(([tag, v]) => ({
      category_tag: tag,
      total: v.total,
      single: v.single,
      single_ratio: v.total > 0 ? v.single / v.total : 0,
      import_demand_score: Math.min(
        100,
        Math.max(0, Math.log(1 + v.total) * 18 + (v.total > 0 ? v.single / v.total : 0) * 15),
      ),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 20)

  // 4) 매트릭스 rows = 매치된 후보만, score 결합
  const matrixRows = matches
    .filter((m) => m.manifest_count_90d > 0 || (scoreById.get(m.product_id)?.trend_score ?? 0) > 0)
    .map((m) => {
      const s = scoreById.get(m.product_id)
      return {
        id: m.product_id,
        name: m.canonical_name,
        category: m.category_top ?? 'all',
        trend_score: Number(s?.trend_score ?? 0),
        commerce_score: Number(s?.commerce_score ?? 0),
        final_score: Number(s?.final_score ?? 0),
        import_demand_score: m.import_demand_score,
        manifest_count_90d: m.manifest_count_90d,
        manifest_count_30d: m.manifest_count_30d,
        single_item_ratio: m.single_item_ratio,
        top_category_tag: m.top_category_tag,
        top_brand_raw: m.top_brand_raw,
        countries: m.countries,
      }
    })

  return {
    matchError: matchErr?.message ?? null,
    matrixRows,
    catRows,
    matchedCount: matches.filter((m) => m.manifest_count_90d > 0).length,
    totalCandidates: matches.length,
  }
}

export default async function ImportValidationPage() {
  const data = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">직구 실수요 검증</h1>
          <p className="text-sm text-gray-500 mt-1">
            검색·TV·커뮤니티 '관심' 시그널 vs 직구 통관 매니페스트의 '실제 결제' (revealed-preference).
            우상단 = 트렌드도 강하고 직구도 실제로 일어남.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {data.matchError ? (
        <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm">
          <div className="font-semibold text-amber-800">RPC 호출 실패</div>
          <div className="text-amber-700 mt-1">{data.matchError}</div>
          <div className="text-amber-700 mt-2 text-xs">
            마이그레이션 미적용일 수 있음 — <code>supabase/manifest_trend_validation.sql</code> 적용 필요.
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-3 text-sm">
        <div className="rounded border border-gray-200 p-3">
          <div className="text-gray-500 text-xs">전체 후보</div>
          <div className="text-2xl font-bold">{data.totalCandidates}</div>
        </div>
        <div className="rounded border border-gray-200 p-3">
          <div className="text-gray-500 text-xs">매니페스트 매칭됨 (90d)</div>
          <div className="text-2xl font-bold">{data.matchedCount}</div>
        </div>
        <div className="rounded border border-gray-200 p-3">
          <div className="text-gray-500 text-xs">매칭률</div>
          <div className="text-2xl font-bold">
            {data.totalCandidates > 0
              ? Math.round((data.matchedCount / data.totalCandidates) * 100)
              : 0}
            %
          </div>
        </div>
      </div>

      {data.matrixRows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 매칭 데이터 없음. trends_products + manifest_items 누적 후 다시 방문.
        </div>
      ) : (
        <ImportValidationMatrix rows={data.matrixRows} />
      )}

      {/* 카테고리별 import_demand_score (매니페스트 ground-truth 분포) */}
      <section className="rounded border border-gray-200 p-4">
        <h2 className="text-lg font-semibold mb-1">매니페스트 카테고리 분포 (90일)</h2>
        <p className="text-xs text-gray-500 mb-3">
          ground-truth: 어떤 카테고리가 실제로 가장 많이 직구로 들어오는가. 트렌드 시그널 없이도 강한 카테고리는 '몰래
          잘 팔리는' 후보.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b border-gray-200 text-gray-500">
              <tr>
                <th className="text-left py-1">category_tag</th>
                <th className="text-right py-1">90d 송장</th>
                <th className="text-right py-1">단일품목</th>
                <th className="text-right py-1">단일 비중</th>
                <th className="text-right py-1">import_demand</th>
              </tr>
            </thead>
            <tbody>
              {data.catRows.map((c) => (
                <tr key={c.category_tag} className="border-b border-gray-100">
                  <td className="py-1 font-medium">{c.category_tag}</td>
                  <td className="py-1 text-right tabular-nums">{c.total.toLocaleString()}</td>
                  <td className="py-1 text-right tabular-nums">{c.single.toLocaleString()}</td>
                  <td className="py-1 text-right tabular-nums">
                    {(c.single_ratio * 100).toFixed(1)}%
                  </td>
                  <td className="py-1 text-right tabular-nums font-semibold">
                    {c.import_demand_score.toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
