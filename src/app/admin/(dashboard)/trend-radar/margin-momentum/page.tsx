import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import MarginScissorScatter, { type ScissorRow, type SeriesPoint } from './MarginScissorScatter'

export const dynamic = 'force-dynamic'

const WINDOW_DAYS = 30

interface ScoreRow {
  product_id: string
  trend_score: number
  commerce_score: number
  final_score: number
  computed_at: string
}
interface SupplierRow {
  product_id: string
  price_krw: number | null
  collected_at: string
}

// 0-100 매핑: 50 = 무변동, clamp.
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

async function fetchData(): Promise<{ rows: ScissorRow[]; demandCount: number; costCount: number }> {
  const sb = createAdminClient()
  const since = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString()

  const [scoreRes, supplierRes] = await Promise.all([
    sb
      .from('jimscanner_trends_scores')
      .select('product_id, trend_score, commerce_score, final_score, computed_at')
      .gte('computed_at', since)
      .order('computed_at', { ascending: true })
      .limit(8000),
    sb
      .from('jimscanner_trends_supplier')
      .select('product_id, price_krw, collected_at')
      .gte('collected_at', since)
      .order('collected_at', { ascending: true })
      .limit(8000),
  ])

  const scores = (scoreRes.data ?? []) as ScoreRow[]
  const suppliers = (supplierRes.data ?? []) as SupplierRow[]

  // product_id → 시계열 그룹
  const demandByProduct = new Map<string, ScoreRow[]>()
  for (const s of scores) {
    const arr = demandByProduct.get(s.product_id) ?? []
    arr.push(s)
    demandByProduct.set(s.product_id, arr)
  }

  // 원가: 같은 시점 여러 source 가능 → collected_at 별 최저가(셀러가 실제 소싱할 가격)로 축약
  const costByProduct = new Map<string, SeriesPoint[]>()
  for (const r of suppliers) {
    if (r.price_krw == null || r.price_krw <= 0) continue
    const arr = costByProduct.get(r.product_id) ?? []
    arr.push({ t: r.collected_at, v: r.price_krw })
    costByProduct.set(r.product_id, arr)
  }
  // 동일 timestamp 최저가 축약
  for (const [pid, pts] of costByProduct) {
    const byT = new Map<string, number>()
    for (const p of pts) {
      const cur = byT.get(p.t)
      if (cur == null || p.v < cur) byT.set(p.t, p.v)
    }
    costByProduct.set(
      pid,
      [...byT.entries()].map(([t, v]) => ({ t, v })).sort((a, b) => a.t.localeCompare(b.t)),
    )
  }

  // 두 시계열이 모두 있는 product 만 (시저 교차의 전제)
  const productIds = [...demandByProduct.keys()].filter((id) => costByProduct.has(id))
  if (productIds.length === 0) return { rows: [], demandCount: demandByProduct.size, costCount: costByProduct.size }

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', productIds)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  const rows: ScissorRow[] = []
  for (const id of productIds) {
    const dPts = demandByProduct.get(id)!
    const cPts = costByProduct.get(id)!
    if (dPts.length < 1 || cPts.length < 1) continue

    const latestScore = dPts[dPts.length - 1]
    const firstScore = dPts[0]
    // 수요 모멘텀: trend_score Δ (최근 - 최초)
    const demandDelta = Math.round(latestScore.trend_score - firstScore.trend_score)

    // 원가 모멘텀: 하락률 (+ = 하락 = 마진 확장)
    const latestPrice = cPts[cPts.length - 1].v
    const basePrice = cPts[0].v
    const costDropPct = basePrice > 0 ? Math.round(((basePrice - latestPrice) / basePrice) * 1000) / 10 : 0

    // 0-100 매핑
    const x = clamp(50 + demandDelta / 2, 0, 100) // ±100 Δ → 0..100
    const y = clamp(50 + costDropPct * 2.5, 0, 100) // ±20% → 0..100

    // 사분면
    const demandUp = x >= 50
    const costDown = y >= 50
    const quadrant: 1 | 2 | 3 | 4 = demandUp && costDown ? 1 : demandUp && !costDown ? 2 : !demandUp && costDown ? 3 : 4

    // 시급도: 수요↑·원가↓ 동시 강도 (둘 다 양수일 때만 의미). 0-100.
    const urgency =
      quadrant === 1
        ? Math.round(clamp((x - 50) / 50, 0, 1) * clamp((y - 50) / 50, 0, 1) * 100)
        : 0

    const demandSeries: SeriesPoint[] = dPts.map((p) => ({ t: p.computed_at, v: p.trend_score }))
    const costSeries: SeriesPoint[] = cPts

    const p = byId.get(id) ?? {}
    rows.push({
      id,
      name: (p as any).canonical_name ?? '?',
      category: (p as any).category_top ?? 'all',
      x,
      y,
      size: Math.max(50, (latestScore.commerce_score || latestScore.final_score) * 4),
      demandDelta,
      costDropPct,
      latestPrice,
      basePrice,
      urgency,
      quadrant,
      demandSeries,
      costSeries,
    })
  }

  return { rows, demandCount: demandByProduct.size, costCount: costByProduct.size }
}

export default async function MarginMomentumPage() {
  const { rows, demandCount, costCount } = await fetchData()
  const q1 = rows.filter((r) => r.quadrant === 1).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">수요-원가 시저 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            X = 수요 모멘텀 (trend_score Δ) · Y = 원가 모멘텀 (도매가 하락=↑) · 우상단 = 마진 골든크로스
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 교차 가능한 시계열이 없습니다</p>
          <p className="text-sm mt-2">
            수요 시계열 {demandCount}개 · 원가 시계열 {costCount}개.
            <br />
            한 product 에 <b>점수 추이</b>와 <b>도매가 추이</b>가 모두 누적돼야 시저 교차가 그려집니다.
          </p>
        </div>
      ) : (
        <>
          <div className="text-sm text-gray-600">
            교차 분석 대상 <b>{rows.length}</b>개 · 즉시소싱(①) 후보{' '}
            <b className="text-emerald-600">{q1}</b>개
          </div>
          <MarginScissorScatter rows={rows} />
        </>
      )}
    </div>
  )
}
