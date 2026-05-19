import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

type WindowDays = 7 | 30 | 90
const WINDOWS: WindowDays[] = [7, 30, 90]

interface FunnelRow {
  category_top: string
  raw_count: number | string | null
  classified_count: number | string | null
  mapped_count: number | string | null
  pinned_count: number | string | null
}

interface NormalizedRow {
  category_top: string
  raw: number
  classified: number
  mapped: number
  pinned: number
}

const STAGE_LABELS = ['raw 수집', 'LLM 분류', 'canonical 매핑', '핀'] as const

function n(v: number | string | null): number {
  if (v == null) return 0
  if (typeof v === 'number') return v
  const parsed = Number(v)
  return Number.isFinite(parsed) ? parsed : 0
}

async function fetchFunnel(days: WindowDays): Promise<NormalizedRow[]> {
  const sb = createAdminClient()
  const { data, error } = await (sb.rpc as any)('jimscanner_funnel_coverage', {
    days_window: days,
  })
  if (error) {
    console.error(`[funnel] rpc(${days}d) failed:`, error.message)
    return []
  }
  return ((data ?? []) as FunnelRow[]).map((r) => ({
    category_top: r.category_top || '(미분류)',
    raw: n(r.raw_count),
    classified: n(r.classified_count),
    mapped: n(r.mapped_count),
    pinned: n(r.pinned_count),
  }))
}

function stageValues(r: NormalizedRow): number[] {
  return [r.raw, r.classified, r.mapped, r.pinned]
}

function pct(num: number, den: number): number {
  if (den <= 0) return 0
  return Math.round((num / den) * 100)
}

function biggestLeakStage(r: NormalizedRow): { stageIdx: number; dropPct: number } | null {
  const v = stageValues(r)
  if (v[0] === 0) return null
  let maxIdx = -1
  let maxDropPct = -1
  for (let i = 1; i < v.length; i++) {
    const prev = v[i - 1]
    if (prev === 0) continue
    const dropAbs = prev - v[i]
    if (dropAbs <= 0) continue
    const dropPct = (dropAbs / prev) * 100
    if (dropPct > maxDropPct) {
      maxDropPct = dropPct
      maxIdx = i
    }
  }
  if (maxIdx < 0) return null
  return { stageIdx: maxIdx, dropPct: Math.round(maxDropPct) }
}

export default async function FunnelPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>
}) {
  const sp = await searchParams
  const days = (WINDOWS.includes(Number(sp.days) as WindowDays)
    ? Number(sp.days)
    : 7) as WindowDays

  const [rowsCurrent, rows7, rows30, rows90] = await Promise.all([
    fetchFunnel(days),
    days === 7 ? Promise.resolve(null) : fetchFunnel(7),
    days === 30 ? Promise.resolve(null) : fetchFunnel(30),
    days === 90 ? Promise.resolve(null) : fetchFunnel(90),
  ])

  // 윈도우 비교용 sparkline 데이터: 카테고리별 [7d.pinned/raw, 30d.pinned/raw, 90d.pinned/raw]
  const compareMap = new Map<string, [number, number, number]>()
  const allWindows: [WindowDays, NormalizedRow[] | null][] = [
    [7, days === 7 ? rowsCurrent : rows7],
    [30, days === 30 ? rowsCurrent : rows30],
    [90, days === 90 ? rowsCurrent : rows90],
  ]
  for (const [w, rows] of allWindows) {
    if (!rows) continue
    for (const r of rows) {
      const cur = compareMap.get(r.category_top) ?? [0, 0, 0]
      const conv = r.raw > 0 ? Math.round((r.pinned / r.raw) * 1000) / 10 : 0
      cur[w === 7 ? 0 : w === 30 ? 1 : 2] = conv
      compareMap.set(r.category_top, cur)
    }
  }

  // 카테고리 정렬: raw_count 가 큰 순
  const sorted = [...rowsCurrent].sort((a, b) => b.raw - a.raw)
  const maxRaw = Math.max(1, ...sorted.map((r) => r.raw))

  // 합계 (전체 funnel)
  const totals = sorted.reduce<NormalizedRow>(
    (acc, r) => ({
      category_top: 'TOTAL',
      raw: acc.raw + r.raw,
      classified: acc.classified + r.classified,
      mapped: acc.mapped + r.mapped,
      pinned: acc.pinned + r.pinned,
    }),
    { category_top: 'TOTAL', raw: 0, classified: 0, mapped: 0, pinned: 0 },
  )

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">Funnel 누수 진단</h1>
          <p className="text-sm text-gray-500 mt-1">
            카테고리별 수집 → LLM 분류 → canonical 매핑 → 핀 4단 funnel.
            가장 큰 누수 구간을 자동 라벨링.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 윈도우 탭 */}
      <nav className="flex gap-2 border-b border-gray-200">
        {WINDOWS.map((w) => (
          <Link
            key={w}
            href={`/admin/trend-radar/funnel?days=${w}`}
            className={`px-3 py-2 text-sm ${
              days === w
                ? 'border-b-2 border-black font-semibold text-black'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {w}일
          </Link>
        ))}
        <div className="ml-auto text-xs text-gray-400 self-center">
          RPC: <code className="font-mono">jimscanner_funnel_coverage({days})</code>
        </div>
      </nav>

      {/* 전체 funnel summary */}
      <section className="rounded border border-gray-200 p-4 bg-gray-50">
        <div className="text-xs text-gray-500 mb-2">전체 합계 ({days}일)</div>
        <FunnelBars row={totals} maxRaw={Math.max(1, totals.raw)} compact={false} />
      </section>

      {/* 카테고리별 funnel */}
      {sorted.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">데이터 없음</p>
          <p className="text-sm mt-2">
            <code className="font-mono px-1 bg-gray-100 rounded">jimscanner_funnel_coverage</code>{' '}
            RPC 가 아직 배포되지 않았거나, 윈도우 내 수집 키워드가 0개입니다.
            <br />
            마이그레이션:{' '}
            <code className="font-mono px-1 bg-gray-100 rounded">supabase/trends_v4_funnel_coverage.sql</code>
          </p>
        </div>
      ) : (
        <section className="space-y-3">
          <div className="grid grid-cols-12 text-xs text-gray-500 px-3">
            <div className="col-span-3">카테고리</div>
            <div className="col-span-6">funnel ({STAGE_LABELS.join(' → ')})</div>
            <div className="col-span-2">7 / 30 / 90일 핀율 (%)</div>
            <div className="col-span-1 text-right">누수 라벨</div>
          </div>
          {sorted.map((r) => {
            const leak = biggestLeakStage(r)
            const trend = compareMap.get(r.category_top) ?? [0, 0, 0]
            return (
              <div
                key={r.category_top}
                className="grid grid-cols-12 px-3 py-3 rounded border border-gray-200 items-center gap-2"
              >
                <div className="col-span-3">
                  <div className="font-medium">{r.category_top}</div>
                  <div className="text-xs text-gray-500 font-mono">
                    {r.raw} → {r.classified} → {r.mapped} → {r.pinned}
                  </div>
                </div>
                <div className="col-span-6">
                  <FunnelBars row={r} maxRaw={maxRaw} compact />
                </div>
                <div className="col-span-2">
                  <Sparkline values={trend} />
                </div>
                <div className="col-span-1 text-right">
                  {leak ? (
                    <span
                      className={`inline-block text-xs px-2 py-1 rounded font-mono ${
                        leak.dropPct >= 75
                          ? 'bg-red-100 text-red-700'
                          : leak.dropPct >= 40
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-gray-100 text-gray-600'
                      }`}
                      title={`${STAGE_LABELS[leak.stageIdx]} 단계에서 ${leak.dropPct}% 누락`}
                    >
                      {STAGE_LABELS[leak.stageIdx]}
                      <br />
                      {leak.dropPct}%↓
                    </span>
                  ) : (
                    <span className="text-xs text-gray-400">—</span>
                  )}
                </div>
              </div>
            )
          })}
        </section>
      )}

      <section className="rounded border border-dashed border-gray-300 p-4 text-xs text-gray-500 space-y-1">
        <div>
          <strong className="text-gray-700">funnel 정의:</strong>{' '}
          raw = jimscanner_trends_keywords (cat × keyword distinct, 윈도우 내) /
          classified = classified_category IS NOT NULL /
          mapped = jimscanner_trends_aliases 와 alias=keyword 로 join 되는 키워드 /
          pinned = pinned=true.
        </div>
        <div>
          <strong className="text-gray-700">누수 라벨:</strong> 이전 단계 대비 drop% 가 가장 큰
          stage. 75%+ red · 40%+ amber. cron 튜닝 / 시드 추가 / LLM 한도 배분 의사결정에 사용.
        </div>
      </section>
    </div>
  )
}

function FunnelBars({
  row,
  maxRaw,
  compact,
}: {
  row: NormalizedRow
  maxRaw: number
  compact: boolean
}) {
  const v = stageValues(row)
  const colors = ['bg-blue-500', 'bg-indigo-500', 'bg-purple-500', 'bg-pink-500']
  return (
    <div className={`space-y-1 ${compact ? '' : 'mt-1'}`}>
      {v.map((val, i) => {
        const widthPct = Math.max(0.5, (val / maxRaw) * 100)
        const dropFromPrev = i === 0 ? null : pct(val, v[i - 1])
        return (
          <div key={i} className="flex items-center gap-2 text-xs">
            <div className={`${compact ? 'w-20' : 'w-24'} text-gray-500 truncate`}>
              {STAGE_LABELS[i]}
            </div>
            <div className="flex-1 bg-gray-100 rounded h-4 relative overflow-hidden">
              <div
                className={`${colors[i]} h-full rounded transition-all`}
                style={{ width: `${widthPct}%` }}
              />
            </div>
            <div className={`${compact ? 'w-16' : 'w-20'} text-right font-mono text-gray-700`}>
              {val.toLocaleString()}
            </div>
            <div className={`${compact ? 'w-12' : 'w-14'} text-right font-mono text-gray-400`}>
              {dropFromPrev != null ? `${dropFromPrev}%` : ''}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Sparkline({ values }: { values: [number, number, number] }) {
  // values 는 % (0~100). 단순 3-point 막대.
  const max = Math.max(1, ...values)
  return (
    <div className="flex items-end gap-1 h-8" title={`7d ${values[0]}% / 30d ${values[1]}% / 90d ${values[2]}%`}>
      {values.map((v, i) => {
        const h = Math.max(2, (v / max) * 32)
        return (
          <div key={i} className="flex flex-col items-center gap-0.5">
            <div className="bg-pink-400 rounded-sm w-2" style={{ height: `${h}px` }} />
            <div className="text-[9px] text-gray-400 font-mono">{[7, 30, 90][i]}</div>
          </div>
        )
      })}
    </div>
  )
}
