import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { STAGE_ORDER, STAGE_META, getStageMeta, type LifecycleStage } from '@/lib/trends-lifecycle'

export const dynamic = 'force-dynamic'

const TOP_N = 12

interface LifecycleRow {
  product_id: string
  stage: LifecycleStage
  latest_score: number
  slope_7d: number
  slope_28d: number
  z_recent: number
  peak_score: number
  peak_lag_days: number
  sample_count: number
  computed_at: string
}

interface ProductLite {
  id: string
  canonical_name: string
  category_top: string | null
}

async function fetchLatestLifecycle() {
  const sb = createAdminClient()
  // 가장 최근 computed_at batch 만. cron 1회 = 같은 timestamp 로 insert 됨.
  // 최근 200 row 받아 product 별 최신만 keep — 일자별 행 수가 크지 않다는 가정.
  const { data, error } = await (sb as any)
    .from('jimscanner_trends_lifecycle')
    .select('product_id, stage, latest_score, slope_7d, slope_28d, z_recent, peak_score, peak_lag_days, sample_count, computed_at')
    .order('computed_at', { ascending: false })
    .limit(5000)
  if (error) {
    return { rows: [] as LifecycleRow[], hasTable: false }
  }

  const seen = new Set<string>()
  const rows: LifecycleRow[] = []
  for (const r of (data ?? []) as LifecycleRow[]) {
    if (seen.has(r.product_id)) continue
    seen.add(r.product_id)
    rows.push(r)
  }
  return { rows, hasTable: true }
}

async function fetchProducts(ids: string[]): Promise<Map<string, ProductLite>> {
  if (ids.length === 0) return new Map()
  const sb = createAdminClient()
  const { data } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  return new Map((data ?? []).map((p: any) => [p.id, p as ProductLite]))
}

export default async function LifecyclePage() {
  const { rows, hasTable } = await fetchLatestLifecycle()
  const productMap = await fetchProducts(rows.map((r) => r.product_id))

  // 단계별 그룹화 + 정렬 (latest_score 내림차순)
  const byStage = new Map<LifecycleStage, LifecycleRow[]>()
  for (const s of STAGE_ORDER) byStage.set(s, [])
  for (const r of rows) {
    const arr = byStage.get(r.stage)
    if (arr) arr.push(r)
  }
  for (const arr of byStage.values()) {
    arr.sort((a, b) => b.latest_score - a.latest_score)
  }

  // 단계별 평균
  const stageAvg = new Map<LifecycleStage, { count: number; avg: number; avgSlope: number }>()
  for (const s of STAGE_ORDER) {
    const arr = byStage.get(s) ?? []
    const n = arr.length
    const avg = n > 0 ? arr.reduce((sum, r) => sum + r.latest_score, 0) / n : 0
    const avgSlope = n > 0 ? arr.reduce((sum, r) => sum + r.slope_7d, 0) / n : 0
    stageAvg.set(s, { count: n, avg, avgSlope })
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">상품 라이프사이클 — Stage Funnel</h1>
          <p className="text-sm text-gray-500 mt-1">
            final_score 시계열 slope·곡률·z-score 로 5단계 분류 ·{' '}
            <span className="text-gray-700">단계별 sourcing 액션 추천</span>
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {!hasTable && (
        <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          ⚠️ <code>jimscanner_trends_lifecycle</code> 테이블이 아직 없습니다.
          <code className="ml-1 px-1 bg-white rounded">supabase/trends_lifecycle.sql</code> 적용 후{' '}
          <code className="px-1 bg-white rounded">node scripts/compute-lifecycle.mjs</code> 1회 실행하세요.
        </div>
      )}

      {hasTable && rows.length === 0 && (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 라이프사이클 산출 데이터가 없습니다</p>
          <p className="text-sm mt-2">
            cron 매일 KST 06:30 <code className="px-1 bg-gray-100 rounded">scripts/compute-lifecycle.mjs</code>
          </p>
        </div>
      )}

      {/* Stage Funnel 보드 — 5컬럼 */}
      {rows.length > 0 && (
        <section className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {STAGE_ORDER.map((stage) => {
            const meta = STAGE_META[stage]
            const arr = byStage.get(stage) ?? []
            const agg = stageAvg.get(stage)!
            return (
              <div
                key={stage}
                className={`rounded border ${meta.columnClass} flex flex-col min-h-[520px]`}
              >
                <div className="px-3 py-2 border-b border-black/5">
                  <div className="flex items-baseline justify-between">
                    <div className="text-sm font-semibold">
                      <span className="mr-1">{meta.emoji}</span>
                      {meta.label}
                    </div>
                    <div className="text-xs text-gray-500 font-mono">{agg.count}</div>
                  </div>
                  <div className="text-xs text-gray-600 mt-0.5">{meta.blurb}</div>
                  <div className="text-[11px] text-gray-500 mt-1 flex gap-3">
                    <span>avg <b className="font-mono">{agg.avg.toFixed(1)}</b></span>
                    <span>slope7d <b className="font-mono">{agg.avgSlope >= 0 ? '+' : ''}{agg.avgSlope.toFixed(2)}</b></span>
                  </div>
                  <div className="mt-2 inline-block px-2 py-0.5 rounded text-[11px] font-semibold bg-white border border-black/10">
                    액션: {meta.action}
                  </div>
                </div>

                <div className="flex-1 p-2 space-y-1.5 overflow-hidden">
                  {arr.length === 0 ? (
                    <div className="text-xs text-gray-400 text-center py-6">해당 단계 없음</div>
                  ) : (
                    arr.slice(0, TOP_N).map((r, i) => {
                      const p = productMap.get(r.product_id)
                      const name = p?.canonical_name ?? r.product_id.slice(0, 8)
                      return (
                        <Link
                          key={r.product_id}
                          href={`/admin/trend-radar/products/${r.product_id}`}
                          className="block px-2 py-1.5 rounded bg-white/70 hover:bg-white border border-black/5 transition-colors"
                        >
                          <div className="flex items-baseline gap-2">
                            <span className="text-[10px] text-gray-400 font-mono w-4 text-right shrink-0">
                              {i + 1}
                            </span>
                            <span className="text-xs font-medium truncate flex-1" title={name}>
                              {name}
                            </span>
                            <span className="text-xs font-mono font-bold shrink-0">
                              {r.latest_score.toFixed(0)}
                            </span>
                          </div>
                          <div className="text-[10px] text-gray-500 ml-6 font-mono mt-0.5">
                            slope7d {r.slope_7d >= 0 ? '+' : ''}{r.slope_7d.toFixed(2)}
                            {' · '}
                            z {r.z_recent >= 0 ? '+' : ''}{r.z_recent.toFixed(2)}
                            {r.peak_lag_days > 0 && ` · peak-${r.peak_lag_days}d`}
                          </div>
                        </Link>
                      )
                    })
                  )}
                  {arr.length > TOP_N && (
                    <div className="text-[11px] text-gray-500 text-center pt-2">
                      외 {arr.length - TOP_N}개
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </section>
      )}

      {/* 단계 설명표 */}
      {rows.length > 0 && (
        <section className="rounded border border-gray-200 p-4 text-sm">
          <h2 className="text-sm font-semibold mb-2">단계별 sourcing 액션 가이드</h2>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
            {STAGE_ORDER.map((s) => {
              const m = getStageMeta(s)
              return (
                <div key={s} className={`rounded border ${m.columnClass} px-2 py-1.5`}>
                  <div className="text-xs font-semibold">
                    {m.emoji} {m.label} → <span className="text-gray-700">{m.action}</span>
                  </div>
                  <div className="text-[11px] text-gray-600 mt-0.5">{m.blurb}</div>
                </div>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
