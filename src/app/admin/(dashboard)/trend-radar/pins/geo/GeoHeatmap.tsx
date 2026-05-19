'use client'

import { useMemo, useState } from 'react'
import { KR_REGIONS } from '@/lib/trends/kr-regions'

export type RegionShare = {
  region_code: string
  region_name: string
  share_ratio: number
}

export type PinSkew = {
  keyword: string
  kl_divergence: number
  top3: Array<{ code: string; name: string; share: number }>
  shares: Record<string, number> // region_code → share
  collected_at: string
}

/**
 * 한국 17개 시도 — 행정구역 단순화 좌표 그리드 (5x5).
 * SVG 코로플레스를 별도 의존성 없이 구현하기 위한 어림 배치.
 */
const REGION_GRID: Record<string, { col: number; row: number }> = {
  'KR-11': { col: 2, row: 1 }, // 서울
  'KR-28': { col: 1, row: 1 }, // 인천
  'KR-41': { col: 3, row: 1 }, // 경기
  'KR-42': { col: 4, row: 0 }, // 강원
  'KR-43': { col: 3, row: 2 }, // 충북
  'KR-44': { col: 2, row: 2 }, // 충남
  'KR-30': { col: 2, row: 3 }, // 대전 (충남 인접)
  'KR-50': { col: 3, row: 3 }, // 세종
  'KR-45': { col: 2, row: 4 }, // 전북
  'KR-46': { col: 1, row: 4 }, // 전남
  'KR-29': { col: 1, row: 3 }, // 광주
  'KR-47': { col: 4, row: 2 }, // 경북
  'KR-27': { col: 4, row: 3 }, // 대구
  'KR-48': { col: 4, row: 4 }, // 경남
  'KR-26': { col: 4, row: 5 }, // 부산
  'KR-31': { col: 3, row: 5 }, // 울산
  'KR-49': { col: 0, row: 5 }, // 제주
}

const UNIFORM = 1 / KR_REGIONS.length

function shareColor(share: number, max: number): string {
  if (max <= 0) return 'rgb(241, 245, 249)'
  const ratio = Math.min(1, share / max)
  // slate-100 → indigo-600
  const r = Math.round(241 - (241 - 79) * ratio)
  const g = Math.round(245 - (245 - 70) * ratio)
  const b = Math.round(249 - (249 - 229) * ratio)
  return `rgb(${r}, ${g}, ${b})`
}

export default function GeoHeatmap({ pins }: { pins: PinSkew[] }) {
  const sorted = useMemo(
    () => [...pins].sort((a, b) => b.kl_divergence - a.kl_divergence),
    [pins],
  )
  const [active, setActive] = useState<PinSkew | null>(sorted[0] ?? null)

  const max = useMemo(() => {
    if (!active) return 0
    return Math.max(...Object.values(active.shares), UNIFORM)
  }, [active])

  if (sorted.length === 0) {
    return (
      <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
        <p className="text-base font-medium">지역 분포 데이터 없음</p>
        <p className="text-sm mt-2">
          핀한 키워드에 대해 <code>collect-naver-shopping-region</code> cron 이 돌면 17개 시도 비중이 누적됩니다.
        </p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-12 gap-6">
      {/* 왼쪽: 핀 리스트 (편중도 정렬) */}
      <aside className="col-span-4 space-y-1">
        <h2 className="text-xs uppercase tracking-wider text-gray-500 mb-2">
          편중도 ↓ (KL-divergence)
        </h2>
        <div className="divide-y divide-gray-100 border border-gray-200 rounded">
          {sorted.map((p) => (
            <button
              key={p.keyword}
              onClick={() => setActive(p)}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 ${
                active?.keyword === p.keyword ? 'bg-indigo-50' : ''
              }`}
            >
              <div className="flex justify-between items-baseline">
                <span className="font-medium truncate">{p.keyword}</span>
                <span className="text-xs font-mono text-gray-600">
                  {p.kl_divergence.toFixed(3)}
                </span>
              </div>
              <div className="text-xs text-gray-500 mt-1 truncate">
                {p.top3.map((r) => `${r.name} ${(r.share * 100).toFixed(0)}%`).join(' · ')}
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* 오른쪽: 선택된 핀의 17개 시도 SVG 히트맵 */}
      <section className="col-span-8 space-y-4">
        {active && (
          <>
            <div className="flex items-baseline justify-between">
              <div>
                <h2 className="text-lg font-semibold">{active.keyword}</h2>
                <p className="text-xs text-gray-500 mt-1">
                  편중도 점수 (KL) <strong className="font-mono text-gray-800">{active.kl_divergence.toFixed(4)}</strong>
                  {' · '}
                  Top3:{' '}
                  {active.top3.map((r, i) => (
                    <span key={r.code}>
                      {i > 0 && ', '}
                      <strong>{r.name}</strong>{' '}
                      <span className="font-mono">{(r.share * 100).toFixed(1)}%</span>
                    </span>
                  ))}
                </p>
              </div>
              {active.kl_divergence > 0.5 && (
                <span className="text-xs px-2 py-1 rounded bg-amber-100 text-amber-800 font-medium">
                  지역타깃 광고 / 오프라인 입점 후보
                </span>
              )}
            </div>

            <div className="rounded border border-gray-200 p-4 bg-white">
              <svg viewBox="0 0 500 600" className="w-full h-auto">
                {KR_REGIONS.map((r) => {
                  const g = REGION_GRID[r.code]
                  if (!g) return null
                  const x = g.col * 95 + 10
                  const y = g.row * 95 + 10
                  const share = active.shares[r.code] ?? 0
                  const fill = shareColor(share, max)
                  const textColor = share / max > 0.55 ? '#fff' : '#1e293b'
                  return (
                    <g key={r.code}>
                      <rect
                        x={x}
                        y={y}
                        width={85}
                        height={85}
                        rx={6}
                        fill={fill}
                        stroke="#e2e8f0"
                      />
                      <text
                        x={x + 42.5}
                        y={y + 38}
                        textAnchor="middle"
                        fontSize={13}
                        fontWeight={600}
                        fill={textColor}
                      >
                        {r.name}
                      </text>
                      <text
                        x={x + 42.5}
                        y={y + 58}
                        textAnchor="middle"
                        fontSize={11}
                        fill={textColor}
                        fontFamily="ui-monospace, SFMono-Regular, monospace"
                      >
                        {(share * 100).toFixed(1)}%
                      </text>
                    </g>
                  )
                })}
              </svg>
              <p className="text-xs text-gray-500 mt-2">
                균등분포 기준선 = {(UNIFORM * 100).toFixed(1)}% (1/17). 진한 색일수록 편중.
              </p>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
