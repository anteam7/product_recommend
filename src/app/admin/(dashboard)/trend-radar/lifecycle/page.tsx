import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { classifyLifecycle, type LifecyclePoint } from './lifecycle'
import LifecycleBoard, { type BoardItem } from './LifecycleBoard'

export const dynamic = 'force-dynamic'

interface ScoreRow {
  product_id: string
  final_score: number
  trend_score: number
  computed_at: string
}

async function fetchData(): Promise<BoardItem[]> {
  const sb = createAdminClient()

  // 최근 14일 시계열 전체 (product 별 곡선 형태 분석용)
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, trend_score, computed_at')
    .gte('computed_at', since)
    .order('computed_at', { ascending: true })
    .limit(20000)

  const rows = (scores ?? []) as ScoreRow[]
  if (rows.length === 0) return []

  // product 별 시계열 묶기
  const byProduct = new Map<string, LifecyclePoint[]>()
  for (const r of rows) {
    const v = Number.isFinite(r.final_score) ? r.final_score : r.trend_score
    if (!Number.isFinite(v)) continue
    const arr = byProduct.get(r.product_id) ?? []
    arr.push({ t: new Date(r.computed_at).getTime(), v })
    byProduct.set(r.product_id, arr)
  }

  const ids = Array.from(byProduct.keys())
  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  const items: BoardItem[] = []
  for (const [pid, series] of byProduct) {
    const res = classifyLifecycle(series)
    if (res.stage === 'unknown') continue
    const p = byId.get(pid) ?? {}
    const sorted = [...series].sort((a, b) => a.t - b.t)
    items.push({
      id: pid,
      name: (p as any).canonical_name ?? '?',
      category: (p as any).category_top ?? 'all',
      stage: res.stage,
      priority: res.priority,
      slope: res.slope,
      accel: res.accel,
      dropFromPeak: res.dropFromPeak,
      sharpness: res.sharpness,
      series: sorted.map((s) => s.v),
      finalScore: sorted[sorted.length - 1]?.v ?? 0,
    })
  }

  items.sort((a, b) => a.priority - b.priority)
  return items
}

export default async function LifecyclePage() {
  const items = await fetchData()
  const growthCount = items.filter((i) => i.stage === 'growth').length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">라이프사이클 보드</h1>
          <p className="mt-1 text-sm text-gray-500">
            수요 곡선 형태로 단계 자동 분류 (도입기·성장기·피크·쇠퇴기·반짝유행) · 위탁 리드타임 고려 시
            <span className="font-semibold text-emerald-700"> 성장기 = 진입 적기</span>
            {growthCount > 0 && <span className="ml-1 text-emerald-700">({growthCount}건)</span>}
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 underline hover:text-black">
          ← 대시보드
        </Link>
      </header>

      {items.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 곡선 분류에 충분한 시계열이 없음 (상품당 3점 이상 필요). recompute cron 누적 후 다시 방문.
        </div>
      ) : (
        <LifecycleBoard items={items} />
      )}
    </div>
  )
}
