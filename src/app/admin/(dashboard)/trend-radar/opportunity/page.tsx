import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import OpportunityScatter from './OpportunityScatter'

export const dynamic = 'force-dynamic'

// PB 침투율 ≥ 임계치(예: 30%) → 자동 reject 사유 'PB 잠식' 부착.
const PB_REJECT_THRESHOLD = 0.3

interface ScoreRow {
  product_id: string
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  final_score: number
  computed_at: string
}

interface PbLatestRow {
  keyword: string
  platform: string
  pb_share: number
  pb_top_brand: string | null
  captured_at: string
}

async function fetchData(searchParams: { pbMax?: string; onlySafe?: string }) {
  const sb = createAdminClient()

  // 최신 score 만 (product_id 별 latest)
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(2000)

  const seen = new Set<string>()
  const latest: ScoreRow[] = []
  for (const s of (scores ?? []) as ScoreRow[]) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latest.push(s)
  }

  const ids = latest.map((s) => s.product_id)
  if (ids.length === 0) return { rows: [], pbRows: [] as PbRowDisplay[] }

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  // PB 침투율 (jimscanner_pb_penetration_latest view) — 마이그레이션 적용 전 가정 시
  // 테이블이 없을 수 있어 try/catch. `as any` 캐스팅: 타입은 다음 gen:types 후 갱신.
  let pbByName = new Map<string, PbLatestRow>()
  try {
    const { data: pbLatest } = await (sb as any)
      .from('jimscanner_pb_penetration_latest')
      .select('keyword, platform, pb_share, pb_top_brand, captured_at')
      .limit(500)
    for (const p of (pbLatest ?? []) as PbLatestRow[]) {
      // keyword → 최대 점유율 1건 (여러 platform 중 max).
      const prev = pbByName.get(p.keyword)
      if (!prev || p.pb_share > prev.pb_share) pbByName.set(p.keyword, p)
    }
  } catch (e) {
    // 테이블 미적용 — 무시
  }

  const pbMax = searchParams.pbMax ? Math.max(0, Math.min(1, Number(searchParams.pbMax))) : null
  const onlySafe = searchParams.onlySafe === '1'

  const rows = latest.map((s) => {
    const p = byId.get(s.product_id) ?? {}
    const name = (p as any).canonical_name ?? '?'
    // fuzzy match: canonical_name 부분문자열 → pb 키워드
    let pb: PbLatestRow | null = null
    for (const [kw, v] of pbByName.entries()) {
      if (name.includes(kw) || kw.includes(name)) {
        if (!pb || v.pb_share > pb.pb_share) pb = v
      }
    }
    const pbShare = pb?.pb_share ?? 0
    const rejected = pbShare >= PB_REJECT_THRESHOLD
    return {
      id: s.product_id,
      name,
      category: (p as any).category_top ?? 'all',
      x: s.competition_score,
      y: s.trend_score,
      size: Math.max(50, s.commerce_score * 4),
      final: s.final_score,
      supplier: s.supplier_score,
      pb_share: pbShare,
      pb_top_brand: pb?.pb_top_brand ?? null,
      pb_rejected: rejected,
      pb_reason: rejected ? `PB 잠식 (점유율 ${(pbShare * 100).toFixed(0)}%${pb?.pb_top_brand ? `, ${pb.pb_top_brand}` : ''})` : null,
    }
  })

  const filtered = rows.filter((r) => {
    if (onlySafe && r.pb_rejected) return false
    if (pbMax != null && r.pb_share > pbMax) return false
    return true
  })

  return { rows: filtered, pbRows: filtered.slice(0, 50) }
}

interface PbRowDisplay {
  id: string
  name: string
  category: string
  final: number
  pb_share: number
  pb_top_brand: string | null
  pb_rejected: boolean
  pb_reason: string | null
}

export default async function OpportunityPage({
  searchParams,
}: {
  searchParams: Promise<{ pbMax?: string; onlySafe?: string }>
}) {
  const sp = await searchParams
  const { rows, pbRows } = await fetchData(sp)
  const pbMaxLabel = sp.pbMax ? `${Math.round(Number(sp.pbMax) * 100)}%` : '제한 없음'

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Opportunity Matrix</h1>
          <p className="text-sm text-gray-500 mt-1">
            X = competition (오른쪽 = 경쟁 약함) · Y = trend · 크기 = commerce · 핀 후보 = 우상단 큰 점
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* PB 침투율 필터 */}
      <form method="GET" className="flex items-center gap-3 text-sm border border-gray-200 rounded px-3 py-2 bg-gray-50">
        <span className="font-medium">PB 침투율 게이트</span>
        <label className="flex items-center gap-1">
          최대 PB 점유율:
          <select name="pbMax" defaultValue={sp.pbMax ?? ''} className="border rounded px-2 py-1">
            <option value="">제한 없음</option>
            <option value="0.1">≤ 10%</option>
            <option value="0.2">≤ 20%</option>
            <option value="0.3">≤ 30% (권장)</option>
            <option value="0.5">≤ 50%</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" name="onlySafe" value="1" defaultChecked={sp.onlySafe === '1'} />
          PB 잠식 항목 숨김
        </label>
        <button type="submit" className="ml-auto px-3 py-1 bg-black text-white rounded">
          적용
        </button>
        <span className="text-xs text-gray-500">현재: {pbMaxLabel}</span>
      </form>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 데이터 없음. cron 누적 후 다시 방문.
        </div>
      ) : (
        <>
          <OpportunityScatter rows={rows} />

          {/* PB 침투율 컬럼 — 상위 50건 */}
          <div className="rounded border border-gray-200 overflow-hidden">
            <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 text-xs text-gray-600">
              PB 침투율 (jimscanner_pb_penetration 최신). ≥{PB_REJECT_THRESHOLD * 100}% = '<b>PB 잠식</b>' reject.
            </div>
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500 bg-gray-50">
                <tr>
                  <th className="text-left px-3 py-2">제품</th>
                  <th className="text-left px-3 py-2">카테고리</th>
                  <th className="text-right px-3 py-2">final</th>
                  <th className="text-right px-3 py-2">PB %</th>
                  <th className="text-left px-3 py-2">PB top brand</th>
                  <th className="text-left px-3 py-2">사유</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {pbRows.map((r) => (
                  <tr key={r.id} className={r.pb_rejected ? 'bg-red-50' : ''}>
                    <td className="px-3 py-2">{r.name}</td>
                    <td className="px-3 py-2 text-gray-500">{r.category}</td>
                    <td className="px-3 py-2 text-right font-mono">{r.final.toFixed(1)}</td>
                    <td className="px-3 py-2 text-right font-mono">
                      {r.pb_share > 0 ? `${(r.pb_share * 100).toFixed(0)}%` : '-'}
                    </td>
                    <td className="px-3 py-2 text-gray-600">{r.pb_top_brand ?? '-'}</td>
                    <td className="px-3 py-2 text-xs text-red-600">{r.pb_reason ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
