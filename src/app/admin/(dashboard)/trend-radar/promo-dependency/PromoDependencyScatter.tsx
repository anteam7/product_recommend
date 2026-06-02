'use client'
import { useState } from 'react'
import type { PromoRow } from './page'

const VERDICT_COLOR: Record<string, string> = {
  red: '#ef4444',
  amber: '#f59e0b',
  green: '#10b981',
}

// 의존지수는 0~수십까지 분포 — 가독성을 위해 X 축은 [0, 3] 클램프.
const X_MAX = 3

export default function PromoDependencyScatter({ rows }: { rows: PromoRow[] }) {
  const [hover, setHover] = useState<PromoRow | null>(null)
  const W = 720
  const H = 480
  const PAD = 50

  // Y(오가닉 heat) 축 스케일 — 데이터 최대값 기준 (최소 10).
  const yMax = Math.max(10, ...rows.map((r) => r.dq.organic_heat))

  const xScale = (v: number) => PAD + (Math.min(v, X_MAX) / X_MAX) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (Math.min(v, yMax) / yMax) * (H - 2 * PAD)
  const rScale = (final: number) => Math.max(4, Math.sqrt(Math.max(final, 1) / Math.PI) * 1.4)

  const redZoneX = xScale(1.5)
  const greenZoneX = xScale(0.5)

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 초록 존 (의존지수 ≤ 0.5) */}
          <rect x={PAD} y={PAD} width={greenZoneX - PAD} height={H - 2 * PAD} fill="#f0fdf4" />
          {/* 빨강 존 (의존지수 ≥ 1.5) */}
          <rect x={redZoneX} y={PAD} width={W - PAD - redZoneX} height={H - 2 * PAD} fill="#fef2f2" />

          {/* 경계선 */}
          <line x1={greenZoneX} y1={PAD} x2={greenZoneX} y2={H - PAD} stroke="#86efac" strokeDasharray="3,3" />
          <line x1={redZoneX} y1={PAD} x2={redZoneX} y2={H - PAD} stroke="#fca5a5" strokeDasharray="3,3" />

          {/* X grid (의존지수 0,0.5,1,1.5,2,2.5,3) */}
          {[0, 0.5, 1, 1.5, 2, 2.5, 3].map((v) => (
            <text key={'gx' + v} x={xScale(v)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">
              {v}
              {v === X_MAX ? '+' : ''}
            </text>
          ))}
          {/* Y grid */}
          {[0, 0.25, 0.5, 0.75, 1].map((f) => {
            const v = Math.round(yMax * f * 10) / 10
            return (
              <g key={'gy' + f}>
                <line x1={PAD} y1={yScale(v)} x2={W - PAD} y2={yScale(v)} stroke="#e5e7eb" strokeDasharray="2,3" />
                <text x={PAD - 8} y={yScale(v) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
                  {v}
                </text>
              </g>
            )
          })}

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 10} fontSize="11" fill="#6b7280" textAnchor="middle">
            프로모션 의존지수 (← 오가닉 주도 · 딥할인 의존 →)
          </text>
          <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
            오가닉 수요 heat (↑ 진짜 수요 강함)
          </text>

          {/* 존 라벨 */}
          <text x={(PAD + greenZoneX) / 2} y={PAD + 16} fontSize="11" fill="#10b981" fontWeight="bold" textAnchor="middle">
            🟢 소싱 큐
          </text>
          <text x={(redZoneX + W - PAD) / 2} y={PAD + 16} fontSize="11" fill="#ef4444" fontWeight="bold" textAnchor="middle">
            🔴 회피
          </text>

          {/* 점들 */}
          {rows.map((r) => (
            <a key={r.id} href={`/admin/trend-radar/products/${r.id}`}>
              <circle
                cx={xScale(r.dq.dependency_index)}
                cy={yScale(r.dq.organic_heat)}
                r={rScale(r.final)}
                fill={VERDICT_COLOR[r.dq.verdict] ?? '#6b7280'}
                fillOpacity={0.55}
                stroke={VERDICT_COLOR[r.dq.verdict] ?? '#6b7280'}
                strokeOpacity={0.9}
                onMouseEnter={() => setHover(r)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: 'pointer' }}
              />
            </a>
          ))}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
            <div className="font-semibold">{hover.name}</div>
            <div>category: {hover.category}</div>
            <div>
              의존지수: {hover.dq.dependency_index.toFixed(2)} · 판정: {hover.dq.verdict}
            </div>
            <div>
              딜: {hover.dq.deal_heat} · 오가닉: {hover.dq.organic_heat} · 커뮤: {hover.dq.community_heat}
            </div>
            <div>
              final: {hover.final} · trend: {hover.trend}
              {hover.fromRecompute ? ' · (recompute)' : ' · (alias 계산)'}
            </div>
          </div>
        )}
      </div>

      {/* 범례 */}
      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        {(['green', 'amber', 'red'] as const).map((v) => (
          <span key={v} className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-full" style={{ background: VERDICT_COLOR[v], opacity: 0.6 }} />
            {v === 'green' ? '오가닉 주도' : v === 'amber' ? '혼재' : '프로모션 의존'}
          </span>
        ))}
        <span className="text-gray-400">· 점 크기 = final_score</span>
      </div>
    </div>
  )
}
