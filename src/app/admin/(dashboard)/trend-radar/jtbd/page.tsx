import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import JtbdBubble from './JtbdBubble'

export const dynamic = 'force-dynamic'

interface ScoreRow {
  product_id: string
  trend_score: number
  supplier_score: number
  final_score: number
  computed_at: string
}

export interface IntentRow {
  intent: string
  productCount: number
  demandWeight: number   // Σ final_score
  trendMedian: number
  supplierAvg: number    // 공급 충족도 0~100
  matchRatio: number     // ggsan 매칭(=supplier_score>0) 비율 0~1
  products: { id: string; name: string; final: number; supplier: number }[]
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

async function fetchData(): Promise<{ rows: IntentRow[]; unlabeled: number }> {
  const sb = createAdminClient()

  // product_id 별 최신 score 1건
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, trend_score, supplier_score, final_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(4000)

  const seen = new Set<string>()
  const latest: ScoreRow[] = []
  for (const s of (scores ?? []) as ScoreRow[]) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latest.push(s)
  }
  const byScore = new Map(latest.map((s) => [s.product_id, s]))

  const ids = latest.map((s) => s.product_id)
  if (ids.length === 0) return { rows: [], unlabeled: 0 }

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, intent_label')
    .in('id', ids)

  // intent_label 로 그룹화 ('직무' 축 — 분류 미완이어도 intent 만 있으면 집계)
  const groups = new Map<string, IntentRow>()
  let unlabeled = 0
  for (const p of (prods ?? []) as { id: string; canonical_name: string | null; intent_label: string | null }[]) {
    const intent = (p.intent_label ?? '').trim()
    if (!intent) {
      unlabeled++
      continue
    }
    const sc = byScore.get(p.id)
    if (!sc) continue
    let g = groups.get(intent)
    if (!g) {
      g = {
        intent,
        productCount: 0,
        demandWeight: 0,
        trendMedian: 0,
        supplierAvg: 0,
        matchRatio: 0,
        products: [],
      }
      groups.set(intent, g)
    }
    g.productCount += 1
    g.demandWeight += sc.final_score
    g.products.push({
      id: p.id,
      name: p.canonical_name ?? '?',
      final: sc.final_score,
      supplier: sc.supplier_score,
    })
  }

  // 평균·중앙값·매칭비율 마감 계산
  const rows: IntentRow[] = []
  for (const g of groups.values()) {
    const trends = g.products.map((x) => byScore.get(x.id)?.trend_score ?? 0)
    const suppliers = g.products.map((x) => x.supplier)
    g.trendMedian = Math.round(median(trends))
    g.supplierAvg = Math.round(suppliers.reduce((a, b) => a + b, 0) / suppliers.length)
    g.matchRatio = suppliers.filter((v) => v > 0).length / suppliers.length
    g.demandWeight = Math.round(g.demandWeight)
    g.products.sort((a, b) => b.final - a.final)
    rows.push(g)
  }
  rows.sort((a, b) => b.demandWeight - a.demandWeight)
  return { rows, unlabeled }
}

export default async function JtbdPage() {
  const { rows, unlabeled } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">JTBD 수요-공급 갭 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            축 = 구매의도(intent_label, 고객이 상품을 고용하는 직무) · X = 수요무게(Σfinal) · Y = 공급충족(supplier 평균) ·
            크기 = 상품수. <span className="text-rose-600 font-medium">우하단 = 수요 강한데 공급 빈 미충족 직무</span>
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          intent_label 이 부여된 상품이 아직 없음. classify cron 누적 후 다시 방문.
        </div>
      ) : (
        <JtbdBubble rows={rows} />
      )}

      {unlabeled > 0 && (
        <p className="text-xs text-gray-400">
          intent_label 미부여 {unlabeled}건은 집계에서 제외됨 (classify 단계 백필 대상).
        </p>
      )}
    </div>
  )
}
