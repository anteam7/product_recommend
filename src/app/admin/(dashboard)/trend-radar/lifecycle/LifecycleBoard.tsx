'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { STAGE_META, type LifecycleStage } from './lifecycle'

export interface BoardItem {
  id: string
  name: string
  category: string
  stage: LifecycleStage
  priority: number
  slope: number
  accel: number
  dropFromPeak: number
  sharpness: number
  series: number[] // final_score 시계열 (오름차순)
  finalScore: number
}

// 단계별 tailwind 색 (safelist 회피: 정적 클래스 문자열)
const COLOR: Record<string, { head: string; chip: string; spark: string }> = {
  emerald: { head: 'bg-emerald-600', chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', spark: '#059669' },
  sky: { head: 'bg-sky-600', chip: 'bg-sky-50 text-sky-700 border-sky-200', spark: '#0284c7' },
  amber: { head: 'bg-amber-500', chip: 'bg-amber-50 text-amber-700 border-amber-200', spark: '#d97706' },
  rose: { head: 'bg-rose-600', chip: 'bg-rose-50 text-rose-700 border-rose-200', spark: '#e11d48' },
  fuchsia: { head: 'bg-fuchsia-600', chip: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200', spark: '#c026d3' },
  gray: { head: 'bg-gray-500', chip: 'bg-gray-50 text-gray-600 border-gray-200', spark: '#6b7280' },
}

function Sparkline({ data, color }: { data: number[]; color: string }) {
  const w = 120
  const h = 32
  if (data.length < 2) {
    return <div className="h-8 w-[120px] rounded bg-gray-100" />
  }
  const min = Math.min(...data)
  const max = Math.max(...data)
  const span = max - min || 1
  const step = w / (data.length - 1)
  const pts = data
    .map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / span) * (h - 4) - 2).toFixed(1)}`)
    .join(' ')
  // 피크 위치 점
  let peakIdx = 0
  for (let i = 1; i < data.length; i++) if (data[i] > data[peakIdx]) peakIdx = i
  const px = peakIdx * step
  const py = h - ((data[peakIdx] - min) / span) * (h - 4) - 2
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
      <circle cx={px} cy={py} r={2.5} fill={color} />
    </svg>
  )
}

const STAGE_ORDER: LifecycleStage[] = ['growth', 'introduction', 'peak', 'decline', 'fad']

export default function LifecycleBoard({ items }: { items: BoardItem[] }) {
  const [category, setCategory] = useState<string>('all')

  const categories = useMemo(() => {
    const s = new Set<string>()
    items.forEach((i) => s.add(i.category || 'all'))
    return ['all', ...Array.from(s).filter((c) => c !== 'all').sort()]
  }, [items])

  const filtered = useMemo(
    () => (category === 'all' ? items : items.filter((i) => (i.category || 'all') === category)),
    [items, category],
  )

  const columns = useMemo(() => {
    const map: Record<LifecycleStage, BoardItem[]> = {
      growth: [], introduction: [], peak: [], decline: [], fad: [], unknown: [],
    }
    for (const it of filtered) (map[it.stage] ?? map.unknown).push(it)
    for (const k of Object.keys(map) as LifecycleStage[]) map[k].sort((a, b) => a.priority - b.priority)
    return map
  }, [filtered])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1">
        {categories.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              category === c ? 'bg-black text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
        {STAGE_ORDER.map((stage) => {
          const meta = STAGE_META[stage]
          const col = COLOR[meta.color]
          const list = columns[stage]
          return (
            <div key={stage} className="flex flex-col rounded-lg border border-gray-200 bg-gray-50/60">
              <div className={`flex items-center justify-between rounded-t-lg px-3 py-2 text-white ${col.head}`}>
                <div>
                  <div className="text-sm font-bold">{meta.label}</div>
                  <div className="text-[11px] opacity-90">{meta.action}</div>
                </div>
                <span className="rounded-full bg-white/25 px-2 py-0.5 text-xs font-semibold">{list.length}</span>
              </div>
              <div className="flex flex-col gap-2 p-2">
                {list.length === 0 ? (
                  <div className="py-6 text-center text-xs text-gray-400">해당 없음</div>
                ) : (
                  list.map((it) => (
                    <Link
                      key={it.id}
                      href={`/admin/trend-radar/products/${it.id}`}
                      className="block rounded-md border border-gray-200 bg-white p-2.5 shadow-sm transition-shadow hover:shadow-md"
                    >
                      <div className="mb-1 flex items-start justify-between gap-2">
                        <span className="line-clamp-2 text-sm font-medium text-gray-900">{it.name}</span>
                        <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold ${col.chip}`}>
                          {it.finalScore.toFixed(0)}
                        </span>
                      </div>
                      <Sparkline data={it.series} color={col.spark} />
                      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-gray-500">
                        <span title="최근 1차 도함수(기울기)">기울기 {it.slope >= 0 ? '+' : ''}{it.slope.toFixed(1)}</span>
                        <span title="2차 도함수(가속도)">가속 {it.accel >= 0 ? '+' : ''}{it.accel.toFixed(1)}</span>
                        {it.dropFromPeak > 0.05 && (
                          <span title="피크 대비 하락률">↓{(it.dropFromPeak * 100).toFixed(0)}%</span>
                        )}
                        {it.sharpness >= 1.8 && <span title="첨도(날카로움)">⚡{it.sharpness.toFixed(1)}</span>}
                      </div>
                    </Link>
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
