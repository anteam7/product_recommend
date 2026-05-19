import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import VelocityQuadrant from './VelocityQuadrant'

export const dynamic = 'force-dynamic'

interface Row {
  keyword: string
  source: string
  category_top: string | null
  volume: number
  velocity: number
  acceleration: number
  quadrant: number
  quadrant_label: string
  day_count: number
  spark: number[] | null
}

async function fetchData(windowDays: number) {
  const sb = createAdminClient()
  const { data, error } = await (sb as any).rpc('jimscanner_trends_velocity_quadrant', {
    window_days: windowDays,
    min_days: 3,
    source_filter: null,
    result_limit: 500,
  })
  if (error) return { rows: [] as Row[], err: error.message }
  const rows = ((data ?? []) as any[]).map((r) => ({
    keyword: r.keyword,
    source: r.source,
    category_top: r.category_top,
    volume: Number(r.volume ?? 0),
    velocity: Number(r.velocity ?? 0),
    acceleration: Number(r.acceleration ?? 0),
    quadrant: Number(r.quadrant ?? 0),
    quadrant_label: r.quadrant_label,
    day_count: Number(r.day_count ?? 0),
    spark: (r.spark ?? []).map((v: any) => Number(v ?? 0)),
  })) as Row[]
  return { rows, err: null as string | null }
}

export default async function VelocityPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>
}) {
  const sp = await searchParams
  const windowDays = Math.max(3, Math.min(28, Number(sp.window ?? 7) || 7))
  const { rows, err } = await fetchData(windowDays)

  const byQuadrant = new Map<number, Row[]>()
  for (const r of rows) {
    const arr = byQuadrant.get(r.quadrant) ?? []
    arr.push(r)
    byQuadrant.set(r.quadrant, arr)
  }
  const sortByImpact = (a: Row, b: Row) =>
    Math.abs(b.velocity) + Math.abs(b.acceleration) - (Math.abs(a.velocity) + Math.abs(a.acceleration))

  const QUADRANT_META: Record<number, { label: string; hint: string; tone: string }> = {
    1: { label: '① 초기등판', hint: '즉시 진입', tone: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
    2: { label: '② 정점임박', hint: '진입 보류 · 핀 회수', tone: 'text-amber-700 bg-amber-50 border-amber-200' },
    3: { label: '③ 퇴조', hint: '손절', tone: 'text-rose-700 bg-rose-50 border-rose-200' },
    4: { label: '④ 반등', hint: '관찰', tone: 'text-sky-700 bg-sky-50 border-sky-200' },
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Velocity Quadrant</h1>
          <p className="text-sm text-gray-500 mt-1">
            X = velocity (dv/dt) · Y = acceleration (d²v/dt²) · 크기 = volume · 색 = category
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="flex gap-2 text-sm">
        {[7, 14, 28].map((w) => (
          <Link
            key={w}
            href={`/admin/trend-radar/velocity?window=${w}`}
            className={`px-3 py-1.5 rounded border ${
              windowDays === w
                ? 'bg-black text-white border-black'
                : 'bg-white text-gray-700 border-gray-300 hover:border-gray-500'
            }`}
          >
            {w}d window
          </Link>
        ))}
        <span className="ml-auto self-center text-xs text-gray-400">
          n = {rows.length} 키워드 (≥3일 누적)
        </span>
      </div>

      {err ? (
        <div className="rounded border border-rose-300 bg-rose-50 text-rose-800 p-4 text-sm">
          RPC 오류: {err} — supabase/trends_velocity.sql 적용 필요.
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 데이터 없음. cron 누적 후 다시 방문.
        </div>
      ) : (
        <>
          <VelocityQuadrant rows={rows} />

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((q) => {
              const meta = QUADRANT_META[q]
              const list = (byQuadrant.get(q) ?? []).sort(sortByImpact).slice(0, 12)
              return (
                <div key={q} className={`rounded border p-3 ${meta.tone}`}>
                  <div className="flex items-baseline justify-between mb-2">
                    <div className="text-sm font-semibold">{meta.label}</div>
                    <div className="text-[10px] uppercase tracking-wider opacity-70">{meta.hint}</div>
                  </div>
                  <div className="space-y-1 text-xs">
                    {list.length === 0 && <div className="opacity-50">—</div>}
                    {list.map((r) => (
                      <div key={`${r.source}:${r.keyword}`} className="flex justify-between gap-2">
                        <span className="truncate">{r.keyword}</span>
                        <span className="font-mono opacity-70 whitespace-nowrap">
                          v{r.velocity.toFixed(1)}·a{r.acceleration.toFixed(1)}
                        </span>
                      </div>
                    ))}
                    {(byQuadrant.get(q)?.length ?? 0) > list.length && (
                      <div className="opacity-50 pt-1">
                        +{(byQuadrant.get(q)?.length ?? 0) - list.length}…
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
