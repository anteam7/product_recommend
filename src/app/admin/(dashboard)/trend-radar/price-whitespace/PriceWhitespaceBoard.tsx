'use client'
import { useState } from 'react'

export interface Band {
  lo: number
  hi: number
  count: number
  revenue: number
  feasible: boolean // 도매원가 기준 마진 확보 가능 밴드
  whitespace: boolean // 매출↑·리스팅↓ 빈 틈
}

export interface ProductBoard {
  productId: string
  title: string
  keyword: string
  cost: number | null
  entryFloor: number | null
  listingCount: number
  bandWidth: number
  bands: Band[]
}

const won = (n: number) => n.toLocaleString('ko-KR')
const k = (n: number) => `${Math.round(n / 1000)}k`

function Chart({ board }: { board: ProductBoard }) {
  const [hover, setHover] = useState<Band | null>(null)
  const W = 760
  const H = 360
  const PAD_L = 48
  const PAD_R = 56
  const PAD_B = 52
  const PAD_T = 24
  const plotW = W - PAD_L - PAD_R
  const plotH = H - PAD_T - PAD_B

  const bands = board.bands
  const maxCount = Math.max(...bands.map((b) => b.count), 1)
  const maxRev = Math.max(...bands.map((b) => b.revenue), 1)
  const bw = plotW / bands.length
  const barW = Math.max(6, bw * 0.7)

  const xCenter = (i: number) => PAD_L + bw * i + bw / 2
  const yCount = (c: number) => PAD_T + plotH - (c / maxCount) * plotH
  const yRev = (r: number) => PAD_T + plotH - (r / maxRev) * plotH

  const revPts = bands.map((b, i) => `${xCenter(i)},${yRev(b.revenue)}`).join(' ')

  return (
    <div className="relative">
      <svg width={W} height={H} className="block" style={{ overflow: 'visible' }}>
        {/* y grid (좌: 리스팅수) */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={'g' + f}>
            <line x1={PAD_L} y1={PAD_T + plotH * (1 - f)} x2={W - PAD_R} y2={PAD_T + plotH * (1 - f)} stroke="#eef0f2" />
            <text x={PAD_L - 6} y={PAD_T + plotH * (1 - f) + 4} fontSize="9" fill="#9ca3af" textAnchor="end">
              {Math.round(maxCount * f)}
            </text>
            <text x={W - PAD_R + 6} y={PAD_T + plotH * (1 - f) + 4} fontSize="9" fill="#f59e0b" textAnchor="start">
              {k(maxRev * f)}
            </text>
          </g>
        ))}

        {/* 밴드 막대 (리스팅 밀도) */}
        {bands.map((b, i) => {
          const fill = b.whitespace && b.feasible ? '#10b981' : b.whitespace ? '#fbbf24' : b.feasible ? '#cbd5e1' : '#e5e7eb'
          const opacity = b.whitespace ? 0.9 : 0.6
          return (
            <g key={b.lo} onMouseEnter={() => setHover(b)} onMouseLeave={() => setHover(null)} style={{ cursor: 'pointer' }}>
              <rect
                x={xCenter(i) - barW / 2}
                y={yCount(b.count)}
                width={barW}
                height={PAD_T + plotH - yCount(b.count)}
                fill={fill}
                fillOpacity={opacity}
              />
              <text x={xCenter(i)} y={H - PAD_B + 14} fontSize="9" fill="#6b7280" textAnchor="middle">
                {k(b.lo)}
              </text>
            </g>
          )
        })}

        {/* 진입 손익분기선 */}
        {board.entryFloor != null && board.entryFloor >= bands[0].lo && board.entryFloor <= bands[bands.length - 1].hi && (() => {
          const idx = (board.entryFloor - bands[0].lo) / board.bandWidth
          const x = PAD_L + bw * idx
          return (
            <g>
              <line x1={x} y1={PAD_T} x2={x} y2={PAD_T + plotH} stroke="#ef4444" strokeDasharray="4,3" />
              <text x={x + 3} y={PAD_T + 10} fontSize="9" fill="#ef4444">
                손익분기 {won(board.entryFloor)}
              </text>
            </g>
          )
        })()}

        {/* 매출 오버레이 라인 */}
        <polyline points={revPts} fill="none" stroke="#f59e0b" strokeWidth="2" />
        {bands.map((b, i) => (
          <circle key={'rc' + b.lo} cx={xCenter(i)} cy={yRev(b.revenue)} r={3} fill="#f59e0b" />
        ))}

        {/* 축 라벨 */}
        <text x={PAD_L + plotW / 2} y={H - 6} fontSize="10" fill="#6b7280" textAnchor="middle">
          개당 가격대 (5천원 밴드)
        </text>
      </svg>

      {hover && (
        <div className="absolute top-1 right-1 rounded bg-black/85 text-white text-xs px-3 py-2">
          <div className="font-semibold">
            {won(hover.lo)} ~ {won(hover.hi)}원
          </div>
          <div>리스팅: {hover.count}개</div>
          <div>추정 월매출: {won(hover.revenue)}원</div>
          <div>
            {hover.whitespace && hover.feasible
              ? '🟢 빈 틈 + 마진 확보'
              : hover.whitespace
                ? '🟡 빈 틈 (마진 미확보)'
                : hover.feasible
                  ? '진입 가능'
                  : '레드오션/마진 미달'}
          </div>
        </div>
      )}
    </div>
  )
}

export default function PriceWhitespaceBoard({ boards }: { boards: ProductBoard[] }) {
  const [sel, setSel] = useState(0)
  const board = boards[sel]

  return (
    <div className="grid grid-cols-[260px_1fr] gap-6">
      {/* 후보 리스트 */}
      <aside className="border-r border-gray-200 pr-4 max-h-[640px] overflow-y-auto">
        <h3 className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">상품 후보</h3>
        <div className="space-y-1">
          {boards.map((b, i) => {
            const green = b.bands.filter((x) => x.whitespace && x.feasible).length
            return (
              <button
                key={b.productId}
                onClick={() => setSel(i)}
                className={`block w-full text-left px-2 py-1.5 rounded text-sm ${i === sel ? 'bg-emerald-50 ring-1 ring-emerald-300' : 'hover:bg-gray-50'}`}
              >
                <div className="flex items-center gap-1">
                  {green > 0 && <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />}
                  <span className="truncate">{b.title}</span>
                </div>
                <div className="text-[10px] text-gray-400">
                  리스팅 {b.listingCount} · 초록밴드 {green}
                </div>
              </button>
            )
          })}
        </div>
      </aside>

      {/* 차트 */}
      <div className="rounded border border-gray-200 p-4">
        <div className="mb-3">
          <div className="font-semibold">{board.title}</div>
          <div className="text-xs text-gray-500">
            검색어 “{board.keyword}” · 리스팅 {board.listingCount}개
            {board.cost != null && <> · 도매 개당원가 {won(board.cost)}원</>}
            {board.entryFloor != null && <> · 손익분기 판매가 {won(board.entryFloor)}원</>}
          </div>
        </div>

        <Chart board={board} />

        <div className="mt-4 flex flex-wrap gap-3 text-xs text-gray-600">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm bg-emerald-500" /> 빈 틈 + 마진 확보
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm bg-amber-400" /> 빈 틈 (마진 미확보)
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm bg-slate-300" /> 진입 가능 (레드오션)
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 h-0 border-t-2 border-amber-500" /> 추정 월매출
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 h-0 border-t-2 border-dashed border-red-500" /> 손익분기선
          </span>
        </div>
      </div>
    </div>
  )
}
