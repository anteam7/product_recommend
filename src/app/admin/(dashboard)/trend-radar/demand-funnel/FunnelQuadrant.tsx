'use client'
import { useState } from 'react'

export interface FunnelRow {
  key: string
  label: string
  /** 검색 모멘텀 0~100 (50=flat, >50 상승) */
  x: number
  /** 쇼핑클릭 모멘텀 0~100 (50=flat, >50 상승) */
  y: number
  /** 원 데이터 (퍼센트 기울기) */
  searchPct: number
  shoppingPct: number
  searchSamples: number
  shoppingSamples: number
}

const W = 720
const H = 480
const PAD = 56

const xScale = (v: number) => PAD + (v / 100) * (W - 2 * PAD)
const yScale = (v: number) => H - PAD - (v / 100) * (H - 2 * PAD)

function fmtPct(p: number): string {
  const r = Math.round(p)
  return (r > 0 ? '+' : '') + r + '%'
}

export default function FunnelQuadrant({ rows }: { rows: FunnelRow[] }) {
  const [hover, setHover] = useState<FunnelRow | null>(null)

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 사분면 배경 — 우하단(검색↑·쇼핑↓ = 미전환 연구수요)을 강조 */}
          <rect x={xScale(50)} y={yScale(50)} width={xScale(100) - xScale(50)} height={yScale(0) - yScale(50)} fill="#eff6ff" />
          {/* 우상단(양 상승) 연녹색 */}
          <rect x={xScale(50)} y={yScale(100)} width={xScale(100) - xScale(50)} height={yScale(50) - yScale(100)} fill="#f0fdf4" />
          {/* 좌하단(양 하락) 연회색 */}
          <rect x={xScale(0)} y={yScale(50)} width={xScale(50) - xScale(0)} height={yScale(0) - yScale(50)} fill="#fafafa" />

          {/* grid */}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={'gx' + v}>
              <line x1={xScale(v)} y1={PAD} x2={xScale(v)} y2={H - PAD} stroke={v === 50 ? '#cbd5e1' : '#eee'} strokeWidth={v === 50 ? 1.5 : 1} />
              <line x1={PAD} y1={yScale(v)} x2={W - PAD} y2={yScale(v)} stroke={v === 50 ? '#cbd5e1' : '#eee'} strokeWidth={v === 50 ? 1.5 : 1} />
            </g>
          ))}

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 14} fontSize="11" fill="#6b7280" textAnchor="middle">
            검색 모멘텀 (→ DataLab 검색질의 상승)
          </text>
          <text x={16} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 16 ${H / 2})`}>
            쇼핑클릭 모멘텀 (↑ 쇼핑 카테고리 클릭 상승)
          </text>

          {/* 사분면 라벨 */}
          <text x={xScale(75)} y={yScale(8)} fontSize="11" fill="#2563eb" fontWeight="bold" textAnchor="middle">
            ① 미전환 연구수요 (검색↑·쇼핑↓) ★선점창
          </text>
          <text x={xScale(75)} y={yScale(95)} fontSize="11" fill="#16a34a" fontWeight="bold" textAnchor="middle">
            ③ 검증된 성장 (양 상승)
          </text>
          <text x={xScale(25)} y={yScale(95)} fontSize="11" fill="#ea580c" fontWeight="bold" textAnchor="middle">
            ② 포화/하락 경고 (검색↓·쇼핑↑)
          </text>
          <text x={xScale(25)} y={yScale(8)} fontSize="11" fill="#9ca3af" fontWeight="bold" textAnchor="middle">
            ④ 회피 (양 하락)
          </text>

          {/* 점들 */}
          {rows.map((r) => {
            const isPin = r.x >= 50 && r.y < 50
            return (
              <g key={r.key}>
                <circle
                  cx={xScale(r.x)}
                  cy={yScale(r.y)}
                  r={9}
                  fill={isPin ? '#2563eb' : '#6b7280'}
                  fillOpacity={0.6}
                  stroke={isPin ? '#1d4ed8' : '#4b5563'}
                  onMouseEnter={() => setHover(r)}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: 'pointer' }}
                />
                <text
                  x={xScale(r.x)}
                  y={yScale(r.y) - 13}
                  fontSize="10"
                  fill="#374151"
                  textAnchor="middle"
                  style={{ pointerEvents: 'none' }}
                >
                  {r.label}
                </text>
              </g>
            )
          })}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
            <div className="font-semibold">{hover.label}</div>
            <div>검색 모멘텀: {fmtPct(hover.searchPct)} (표본 {hover.searchSamples})</div>
            <div>쇼핑 모멘텀: {fmtPct(hover.shoppingPct)} (표본 {hover.shoppingSamples})</div>
          </div>
        )}
      </div>

      {/* 선점창 sub-list */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold mb-2 text-blue-700">★ 미전환 연구수요 (검색↑·쇼핑↓ → 가장 이른 위탁 진입창)</h3>
        <div className="space-y-1 text-sm">
          {rows
            .filter((r) => r.x >= 50 && r.y < 50)
            .sort((a, b) => b.searchPct - a.searchPct)
            .map((r) => (
              <div key={r.key} className="px-2 py-1 rounded hover:bg-gray-50 flex justify-between">
                <span className="font-medium">{r.label}</span>
                <span className="font-mono text-gray-500">
                  검색 {fmtPct(r.searchPct)} · 쇼핑 {fmtPct(r.shoppingPct)}
                </span>
              </div>
            ))}
          {rows.filter((r) => r.x >= 50 && r.y < 50).length === 0 && (
            <div className="text-gray-400 text-xs">현재 검색↑·쇼핑↓ 갭 버킷 없음.</div>
          )}
        </div>
      </div>
    </div>
  )
}
