'use client'
import { useState } from 'react'

export interface RepeatRow {
  goods_no: string
  title: string
  cate_label: string | null
  price_krw: number | null
  image_url: string | null
  detail_url: string | null
  consumption_cycle_days: number | null
  est_monthly_reorder: number | null
  demand_cv: number | null
  demand_stability: number | null
  demand_top_keyword: string | null
  value_per_content: number | null
  repeat_engine_score: number | null
  // 차트 좌표 (0~100 정규화)
  x: number // 재구매빈도
  y: number // 수요안정성
  size: number
}

export default function RepeatScatter({ rows }: { rows: RepeatRow[] }) {
  const [hover, setHover] = useState<RepeatRow | null>(null)
  const W = 720
  const H = 480
  const PAD = 50

  const xScale = (v: number) => PAD + (v / 100) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (v / 100) * (H - 2 * PAD)
  const rScale = (v: number) => Math.max(4, Math.sqrt(Math.max(v, 1) / Math.PI) * 1.6)

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 우상단 사분면 강조 (구독형 캐시카우) */}
          <rect
            x={xScale(50)}
            y={yScale(100)}
            width={xScale(100) - xScale(50)}
            height={yScale(50) - yScale(100)}
            fill="#eef2ff"
          />

          {/* grid */}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={'gx' + v}>
              <line x1={xScale(v)} y1={PAD} x2={xScale(v)} y2={H - PAD} stroke="#e5e7eb" strokeDasharray={v % 50 === 0 ? '' : '2,3'} />
              <text x={xScale(v)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">{v}</text>
            </g>
          ))}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={'gy' + v}>
              <line x1={PAD} y1={yScale(v)} x2={W - PAD} y2={yScale(v)} stroke="#e5e7eb" strokeDasharray={v % 50 === 0 ? '' : '2,3'} />
              <text x={PAD - 8} y={yScale(v) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">{v}</text>
            </g>
          ))}

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 10} fontSize="11" fill="#6b7280" textAnchor="middle">
            재구매빈도 (→ 월 재구매 많음 = 짧은 소진주기)
          </text>
          <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
            수요안정성 (↑ 변동 작음 = 안정 재주문)
          </text>

          {/* 사분면 라벨 */}
          <text x={xScale(75)} y={yScale(96)} fontSize="11" fill="#4f46e5" fontWeight="bold" textAnchor="middle">
            💰 구독형 캐시카우 (빈도↑·안정↑)
          </text>

          {/* 점들 */}
          {rows.map((r) => (
            <a key={r.goods_no} href={r.detail_url ?? '#'} target="_blank" rel="noopener">
              <circle
                cx={xScale(r.x)}
                cy={yScale(r.y)}
                r={rScale(r.size)}
                fill="#6366f1"
                fillOpacity={0.5}
                stroke="#4f46e5"
                strokeOpacity={0.9}
                onMouseEnter={() => setHover(r)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: 'pointer' }}
              />
            </a>
          ))}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs space-y-0.5">
            <div className="font-semibold">{hover.title}</div>
            <div>{hover.cate_label ?? '-'} · {hover.goods_no}</div>
            <div>
              소진주기 {hover.consumption_cycle_days ?? '?'}일 · 월재구매 {fmt(hover.est_monthly_reorder)}회
            </div>
            <div>
              수요CV {fmt(hover.demand_cv)} · 안정성 {fmt(hover.demand_stability)}
            </div>
            <div className="text-indigo-300 font-mono">repeat_score {fmt(hover.repeat_engine_score)}</div>
          </div>
        )}
      </div>

      {/* 우상단 sub-list */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold mb-2">💰 구독형 캐시카우 후보 (빈도≥50 + 안정성≥50)</h3>
        <div className="space-y-1 text-sm">
          {rows
            .filter((r) => r.x >= 50 && r.y >= 50)
            .sort((a, b) => (b.repeat_engine_score ?? 0) - (a.repeat_engine_score ?? 0))
            .slice(0, 12)
            .map((r) => (
              <a
                key={r.goods_no}
                href={r.detail_url ?? '#'}
                target="_blank"
                rel="noopener"
                className="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50"
              >
                <span className="font-mono text-indigo-600 w-12">{fmt(r.repeat_engine_score)}</span>
                <span className="flex-1 truncate">{r.title}</span>
                <span className="text-xs text-gray-400">월 {fmt(r.est_monthly_reorder)}회</span>
              </a>
            ))}
          {rows.filter((r) => r.x >= 50 && r.y >= 50).length === 0 && (
            <div className="text-gray-400 text-xs">
              아직 우상단 후보 없음. 용량 추출 + volume_relative 시계열 누적 후 자연 등장.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function fmt(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '-'
  return Number(v).toFixed(2)
}
