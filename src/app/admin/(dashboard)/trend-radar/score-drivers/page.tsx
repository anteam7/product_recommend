import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import DivergenceBoard, { type DriverRow, type ComponentKey, type SubDelta } from './DivergenceBoard'

export const dynamic = 'force-dynamic'

const COMPONENTS: ComponentKey[] = ['trend', 'commerce', 'supplier', 'competition']

interface RawScore {
  product_id: string
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  final_score: number
  score_components: any
  computed_at: string
}

// jsonb 한 컴포넌트의 숫자 leaf 만 추출 (1단계 중첩 가정)
function numericLeaves(obj: any): Record<string, number> {
  const out: Record<string, number> = {}
  if (!obj || typeof obj !== 'object') return out
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
  return out
}

function classify(
  deltas: Record<ComponentKey, number>,
  finalDelta: number,
): { quality: DriverRow['quality']; demandShare: number } {
  if (Math.abs(finalDelta) < 0.5) return { quality: 'flat', demandShare: 0 }
  const pos = (k: ComponentKey) => Math.max(0, deltas[k] ?? 0)
  const demandPos = pos('trend') + pos('commerce')
  const fragilePos = pos('supplier') + pos('competition')
  const totalPos = demandPos + fragilePos
  if (totalPos === 0) return { quality: 'mixed', demandShare: 0 }
  const demandShare = demandPos / totalPos
  if (demandShare >= 0.6) return { quality: 'durable', demandShare }
  if (demandShare <= 0.4) return { quality: 'fragile', demandShare }
  return { quality: 'mixed', demandShare }
}

async function fetchDrivers(): Promise<DriverRow[]> {
  const sb = createAdminClient()

  // product_id 별 최근 2 스냅샷이 필요. 최신순으로 넉넉히 가져와 그룹핑.
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select(
      'product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, score_components, computed_at',
    )
    .order('computed_at', { ascending: false })
    .limit(8000)

  // product_id → [curr, prev, ...] (최신순)
  const byProduct = new Map<string, RawScore[]>()
  for (const s of (scores ?? []) as RawScore[]) {
    const arr = byProduct.get(s.product_id)
    if (arr) {
      if (arr.length < 2) arr.push(s)
    } else {
      byProduct.set(s.product_id, [s])
    }
  }

  const pairs = [...byProduct.entries()].filter(([, v]) => v.length === 2)
  if (pairs.length === 0) return []

  const ids = pairs.map(([id]) => id)
  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  const rows: DriverRow[] = pairs.map(([id, [curr, prev]]) => {
    const deltas: Record<ComponentKey, number> = {
      trend: curr.trend_score - prev.trend_score,
      commerce: curr.commerce_score - prev.commerce_score,
      supplier: curr.supplier_score - prev.supplier_score,
      competition: curr.competition_score - prev.competition_score,
    }
    const finalDelta = curr.final_score - prev.final_score

    // 하위 컴포넌트 Δ
    const subDeltas: SubDelta[] = []
    for (const g of COMPONENTS) {
      const a = numericLeaves(prev.score_components?.[g])
      const b = numericLeaves(curr.score_components?.[g])
      const keys = new Set([...Object.keys(a), ...Object.keys(b)])
      for (const k of keys) {
        const d = (b[k] ?? 0) - (a[k] ?? 0)
        if (Math.abs(d) >= 0.5) subDeltas.push({ key: `${g}.${k}`, group: g, delta: d })
      }
    }

    const { quality, demandShare } = classify(deltas, finalDelta)
    const p = byId.get(id) ?? {}
    return {
      id,
      name: (p as any).canonical_name ?? '?',
      category: (p as any).category_top ?? 'all',
      prevAt: prev.computed_at?.slice(5, 16)?.replace('T', ' ') ?? '',
      currAt: curr.computed_at?.slice(5, 16)?.replace('T', ' ') ?? '',
      finalPrev: Math.round(prev.final_score),
      finalCurr: Math.round(curr.final_score),
      finalDelta,
      deltas,
      subDeltas,
      quality,
      demandShare,
    }
  })

  return rows
}

export default async function ScoreDriversPage() {
  const rows = await fetchDrivers()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">점수 상승 동인 해부</h1>
          <p className="mt-1 text-sm text-gray-500">
            직전 vs 최신 두 스냅샷의 final_score Δ 를 4 컴포넌트(+하위)별 기여도로 분해 ·
            상승의 질(수요견인 vs 일시요인)로 재정렬
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 underline hover:text-black"
        >
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 두 번 이상 산출된 상품이 없습니다. recompute cron 2 회 누적 후 다시 방문.
        </div>
      ) : (
        <DivergenceBoard rows={rows} />
      )}
    </div>
  )
}
