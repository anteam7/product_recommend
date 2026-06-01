'use client'
import { useState } from 'react'
import type { Watch } from './leadLag'

export interface MatrixRow {
  source: string
  label: string
  lag: number
  corr: number
  total: number
}

// 상관계수 → 히트맵 색 (0=회색, 1=진한 청록)
function corrColor(corr: number): string {
  const c = Math.max(0, Math.min(1, corr))
  // teal 계열 명도 보간
  const light = 96 - c * 56 // 96% → 40%
  return `hsl(174 60% ${light}%)`
}

/** mini sparkline. crossIdx 가 있으면 예측 교차점 마커 표시 */
function Sparkline({
  values,
  color,
  crossIdx,
  height = 28,
  width = 160,
}: {
  values: number[]
  color: string
  crossIdx?: number
  height?: number
  width?: number
}) {
  if (values.length === 0) return <svg width={width} height={height} />
  const max = Math.max(...values, 1)
  const n = values.length
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * width)
  const y = (v: number) => height - (v / max) * (height - 4) - 2
  const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} />
      {crossIdx != null && crossIdx >= 0 && crossIdx < n && (
        <line
          x1={x(crossIdx)} y1={0} x2={x(crossIdx)} y2={height}
          stroke="#ef4444" strokeWidth={1} strokeDasharray="2,2"
        />
      )}
    </svg>
  )
}

export default function LeadLagView({
  matrix,
  watch,
  days,
}: {
  matrix: MatrixRow[]
  watch: Watch[]
  days: string[]
}) {
  const [openTok, setOpenTok] = useState<string | null>(watch[0]?.token ?? null)

  return (
    <div className="space-y-8">
      {/* ① 소스 리드-래그 매트릭스 */}
      <section className="rounded border border-gray-200 p-4">
        <h2 className="text-sm font-semibold mb-1">① 소스 리드-래그 매트릭스</h2>
        <p className="text-xs text-gray-500 mb-3">
          각 선행소스 → 메인스트림(검색·쇼핑) 최적 lag 와 상관. lag↑ = 더 일찍 선행, 색↑ = 상관 강함.
        </p>
        {matrix.length === 0 ? (
          <div className="text-xs text-gray-400">소스 데이터 부족.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="text-sm w-full">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-200">
                  <th className="py-1.5 pr-4 font-medium">선행소스</th>
                  <th className="py-1.5 pr-4 font-medium">선행일수 (lag)</th>
                  <th className="py-1.5 pr-4 font-medium">상관</th>
                  <th className="py-1.5 pr-4 font-medium">{`누적건수(${days.length}일)`}</th>
                </tr>
              </thead>
              <tbody>
                {matrix.map((m) => (
                  <tr key={m.source} className="border-b border-gray-100">
                    <td className="py-1.5 pr-4 font-medium">{m.label}</td>
                    <td className="py-1.5 pr-4">
                      <span className="font-mono">{m.lag > 0 ? `+${m.lag}일` : '동시'}</span>
                    </td>
                    <td className="py-1.5 pr-4">
                      <span
                        className="inline-block rounded px-2 py-0.5 font-mono text-xs"
                        style={{ background: corrColor(m.corr), color: m.corr > 0.5 ? '#fff' : '#374151' }}
                      >
                        {m.corr.toFixed(2)}
                      </span>
                    </td>
                    <td className="py-1.5 pr-4 font-mono text-gray-500">{m.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ② 선행 워치리스트 */}
      <section className="rounded border border-gray-200 p-4">
        <h2 className="text-sm font-semibold mb-1">② 선행 워치리스트 — 메인스트림 도달 D-day 예측</h2>
        <p className="text-xs text-gray-500 mb-3">
          커뮤니티에서 급등 중이지만 메인스트림은 아직 평탄한 후보. 학습된 lag 기반 도달 예측일·교차점 마커(빨강 점선).
        </p>
        {watch.length === 0 ? (
          <div className="text-xs text-gray-400">
            현재 선행 조건(급등×선행상관×메인스트림 평탄)을 만족하는 후보 없음. 누적 후 재방문.
          </div>
        ) : (
          <div className="space-y-2">
            {watch.map((w) => {
              const open = openTok === w.token
              return (
                <div key={w.token} className="rounded border border-gray-100">
                  <button
                    onClick={() => setOpenTok(open ? null : w.token)}
                    className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-gray-50"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="font-semibold truncate">{w.token}</span>
                      <span className="text-xs rounded-full bg-emerald-50 text-emerald-700 px-2 py-0.5">
                        선행 +{w.lag}일 · r={w.corr.toFixed(2)}
                      </span>
                      <span className="text-xs rounded-full bg-amber-50 text-amber-700 px-2 py-0.5">
                        커뮤니티 ×{w.surge} 급등
                      </span>
                    </div>
                    <span className="text-xs text-gray-500 whitespace-nowrap ml-3">
                      {w.ddayDate ? `메인스트림 도달 예측 ~${w.ddayDate}` : ''}
                    </span>
                  </button>
                  {open && (
                    <div className="px-3 pb-3 pt-1 grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <div className="text-xs text-gray-500 mb-1">
                          🟣 리딩 (커뮤니티) · 최근7d {w.leadRecent.toFixed(1)} ← {w.leadPrev.toFixed(1)}
                        </div>
                        <Sparkline values={w.leading} color="#a78bfa" crossIdx={days.length - 1} />
                      </div>
                      <div>
                        <div className="text-xs text-gray-500 mb-1">
                          🔴 래깅 (메인스트림) · 최근7d {w.mainRecent.toFixed(1)} ← {w.mainPrev.toFixed(1)}
                        </div>
                        <Sparkline
                          values={w.mainstream}
                          color="#ef4444"
                          crossIdx={Math.min(days.length - 1 + w.lag, days.length - 1)}
                        />
                        <div className="text-[11px] text-gray-400 mt-1">
                          빨강 점선 = 학습 lag 기반 예측 교차점
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
