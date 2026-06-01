import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import OpportunityScatter from './OpportunityScatter'
import UnitEconomicsBoard, { type BoardRow } from './UnitEconomicsBoard'
import { estimateSellPrice } from '@/lib/trend-radar/unit-economics'

export const dynamic = 'force-dynamic'

interface ScoreRow {
  product_id: string
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  final_score: number
  score_components?: any
  computed_at: string
}

async function fetchData() {
  const sb = createAdminClient()

  // 최신 score 만 (product_id 별 latest)
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, score_components, computed_at')
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
  if (ids.length === 0) return { rows: [], boardRows: [] as BoardRow[] }

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  // 단위경제성: product 별 최저 landed cost(supplier.price_krw) + 관찰 판매가
  const { data: suppliers } = await sb
    .from('jimscanner_trends_supplier')
    .select('product_id, price_krw, raw_payload')
    .in('product_id', ids)
  const bestSupplier = new Map<string, { landed: number; raw: any }>()
  for (const s of (suppliers ?? []) as any[]) {
    const price = Number(s.price_krw) || 0
    if (price <= 0) continue
    const cur = bestSupplier.get(s.product_id)
    if (!cur || price < cur.landed) bestSupplier.set(s.product_id, { landed: price, raw: s.raw_payload })
  }

  const boardRows: BoardRow[] = latest.flatMap((s) => {
    const sup = bestSupplier.get(s.product_id)
    if (!sup) return []
    const p = byId.get(s.product_id) ?? {}
    const sell = estimateSellPrice({
      scoreComponents: s.score_components,
      supplierRaw: sup.raw,
      landedCost: sup.landed,
    })
    if (!sell) return []
    return [{
      id: s.product_id,
      name: (p as any).canonical_name ?? '?',
      category: (p as any).category_top ?? 'all',
      finalScore: s.final_score ?? null,
      landedCost: sup.landed,
      estimatedSellPrice: sell.value,
      sellPriceSource: sell.source,
    }]
  })

  return {
    rows: latest.map((s) => {
      const p = byId.get(s.product_id) ?? {}
      return {
        id: s.product_id,
        name: (p as any).canonical_name ?? '?',
        category: (p as any).category_top ?? 'all',
        x: s.competition_score,        // 경쟁 약함 → 점수 높음 → 오른쪽
        y: s.trend_score,              // 트렌드 강함 → 위
        size: Math.max(50, s.commerce_score * 4),
        final: s.final_score,
        supplier: s.supplier_score,
      }
    }),
    boardRows,
  }
}

export default async function OpportunityPage() {
  const { rows, boardRows } = await fetchData()

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

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 데이터 없음. cron 누적 후 다시 방문.
        </div>
      ) : (
        <OpportunityScatter rows={rows} />
      )}

      {boardRows.length > 0 && (
        <section className="space-y-2">
          <div>
            <h2 className="text-lg font-bold">단위경제성 게이트</h2>
            <p className="text-sm text-gray-500">
              추상점수가 아닌 SKU당 기대 순이익(₩)으로 발굴 후보를 거른다. 바닥선 슬라이더로 적자·박한 후보 회색 처리.
            </p>
          </div>
          <UnitEconomicsBoard rows={boardRows} />
        </section>
      )}
    </div>
  )
}
