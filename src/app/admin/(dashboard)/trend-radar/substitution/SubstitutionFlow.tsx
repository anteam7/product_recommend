'use client'

import { useState, useMemo } from 'react'
import type { SubstitutionRow } from './page'

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return `${d.getMonth() + 1}/${d.getDate()}`
}

// Pearson(−1~0) → 0~1 강도 (−1 일수록 강함)
function corrStrength(p: number): number {
  return Math.min(1, Math.max(0, -p))
}

export default function SubstitutionFlow({ rows }: { rows: SubstitutionRow[] }) {
  const cats = useMemo(
    () => Array.from(new Set(rows.map((r) => r.category_top))).sort(),
    [rows],
  )
  const [activeCat, setActiveCat] = useState<string>('')

  const visible = activeCat ? rows.filter((r) => r.category_top === activeCat) : rows

  return (
    <div className="space-y-4">
      {/* need-space 필터 칩 */}
      {cats.length > 1 && (
        <div className="flex flex-wrap gap-1">
          <button
            onClick={() => setActiveCat('')}
            className={`px-2 py-1 text-xs rounded ${activeCat === '' ? 'bg-black text-white font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            전체 ({rows.length})
          </button>
          {cats.map((c) => {
            const n = rows.filter((r) => r.category_top === c).length
            return (
              <button
                key={c}
                onClick={() => setActiveCat(c)}
                className={`px-2 py-1 text-xs rounded ${activeCat === c ? 'bg-black text-white font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
              >
                {c} ({n})
              </button>
            )
          })}
        </div>
      )}

      {/* 방향 엣지 리스트 (Sankey 풍 좌→우 흐름) */}
      <div className="space-y-2">
        {visible.map((r, i) => {
          const strength = corrStrength(Number(r.pearson))
          const share = r.riser_recent_share != null ? Number(r.riser_recent_share) : null
          return (
            <div
              key={`${r.faller_keyword}|${r.riser_keyword}|${i}`}
              className="rounded border border-gray-200 hover:shadow-sm transition-all overflow-hidden"
            >
              <div className="flex items-stretch">
                {/* need-space 라벨 */}
                <div className="w-24 flex-shrink-0 bg-gray-50 border-r border-gray-100 px-2 py-3 flex flex-col justify-center">
                  <div className="text-[10px] uppercase tracking-wide text-gray-400">need-space</div>
                  <div className="text-xs font-semibold text-gray-700 truncate" title={r.category_top}>
                    {r.category_top}
                  </div>
                  {r.cluster_label && (
                    <div className="text-[10px] text-indigo-500 truncate" title={r.cluster_label}>
                      ◇ {r.cluster_label}
                    </div>
                  )}
                </div>

                {/* faller (incumbent) */}
                <div className="flex-1 min-w-0 bg-red-50/50 px-3 py-3">
                  <div className="text-[10px] text-red-500 font-medium">쇠퇴 incumbent (faller)</div>
                  <div className="text-sm font-semibold text-gray-900 truncate" title={r.faller_keyword}>
                    {r.faller_keyword}
                  </div>
                  <div className="text-[11px] text-gray-500 font-mono mt-0.5">
                    slope {Number(r.faller_slope).toFixed(3)} · now {r.faller_recent ?? '—'} · peak {r.faller_peak ?? '—'}
                  </div>
                  <span className="inline-block mt-1 text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded">
                    회피 — 신규 진입 손절/관망
                  </span>
                </div>

                {/* 화살표 + 음상관 강도 */}
                <div className="w-32 flex-shrink-0 flex flex-col items-center justify-center px-2 py-3">
                  <div className="text-[10px] text-gray-400">Pearson</div>
                  <div
                    className="text-base font-bold font-mono"
                    style={{ color: `rgb(${Math.round(220 - strength * 120)}, ${Math.round(60 + strength * 60)}, 180)` }}
                  >
                    {Number(r.pearson).toFixed(2)}
                  </div>
                  {/* 흐름 막대 */}
                  <div className="w-full h-1.5 bg-gray-100 rounded mt-1 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-red-400 to-green-500"
                      style={{ width: `${Math.round(strength * 100)}%` }}
                    />
                  </div>
                  <div className="text-[10px] text-gray-400 mt-1">
                    교차 {fmtDate(r.crossing_at)}
                  </div>
                  <div className="text-lg leading-none text-gray-300">→</div>
                </div>

                {/* riser (substitute) */}
                <div className="flex-1 min-w-0 bg-green-50/50 px-3 py-3">
                  <div className="text-[10px] text-green-600 font-medium">부상 substitute (riser)</div>
                  <div className="text-sm font-semibold text-gray-900 truncate" title={r.riser_keyword}>
                    {r.riser_keyword}
                  </div>
                  <div className="text-[11px] text-gray-500 font-mono mt-0.5">
                    slope +{Number(r.riser_slope).toFixed(3)} · now {r.riser_recent ?? '—'}
                    {share != null && ` · 흡수율 ${Math.round(share * 100)}%`}
                  </div>
                  <span className="inline-block mt-1 text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded">
                    선점 — ggsan 매칭·위탁 등록
                  </span>
                </div>

                {/* 이전 추정 수요량 */}
                <div className="w-28 flex-shrink-0 border-l border-gray-100 px-2 py-3 flex flex-col justify-center text-right">
                  <div className="text-[10px] text-gray-400">이전 수요(추정)</div>
                  <div className="text-xl font-bold font-mono text-gray-800">
                    {r.prev_demand_estimate != null ? Number(r.prev_demand_estimate).toFixed(0) : '—'}
                  </div>
                  <div className="text-[10px] text-gray-400">{r.overlap_days}일 겹침</div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
