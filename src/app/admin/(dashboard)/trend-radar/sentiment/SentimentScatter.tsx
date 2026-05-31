'use client'
import Link from 'next/link'
import { useState } from 'react'

export interface SentimentRow {
  id: string
  name: string
  polarity: 'positive' | 'negative' | 'neutral'
  defect_terms: string[]
  evidence: string
  source: string | null
  buzz: number
  x: number // 0-100 버즈량
  y: number // 0-100 순극성 (50=중립)
}

const POLARITY_COLOR: Record<string, string> = {
  positive: '#10b981',
  negative: '#ef4444',
  neutral: '#9ca3af',
}

export default function SentimentScatter({ rows }: { rows: SentimentRow[] }) {
  const [hover, setHover] = useState<SentimentRow | null>(null)
  const W = 720
  const H = 480
  const PAD = 50

  const xScale = (v: number) => PAD + (v / 100) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (v / 100) * (H - 2 * PAD)
  const rScale = (v: number) => Math.max(4, Math.sqrt(v + 1) * 2.2)

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 우상단: 입소문 구동 (초록) */}
          <rect
            x={xScale(50)}
            y={yScale(100)}
            width={xScale(100) - xScale(50)}
            height={yScale(50) - yScale(100)}
            fill="#f0fdf4"
          />
          {/* 우하단: 하자·불만 구동 (빨강) — 위탁 위험 게이트 */}
          <rect
            x={xScale(50)}
            y={yScale(50)}
            width={xScale(100) - xScale(50)}
            height={yScale(0) - yScale(50)}
            fill="#fef2f2"
          />

          {/* grid */}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={'gx' + v}>
              <line x1={xScale(v)} y1={PAD} x2={xScale(v)} y2={H - PAD} stroke="#e5e7eb" strokeDasharray={v % 50 === 0 ? '' : '2,3'} />
              <text x={xScale(v)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">
                {v}
              </text>
            </g>
          ))}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={'gy' + v}>
              <line x1={PAD} y1={yScale(v)} x2={W - PAD} y2={yScale(v)} stroke="#e5e7eb" strokeDasharray={v % 50 === 0 ? '' : '2,3'} />
              <text x={PAD - 8} y={yScale(v) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
                {v - 50}
              </text>
            </g>
          ))}

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 10} fontSize="11" fill="#6b7280" textAnchor="middle">
            community buzz (→ 회자량 많음)
          </text>
          <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
            net polarity (↑ 긍정 · ↓ 불만)
          </text>

          {/* 사분면 라벨 */}
          <text x={xScale(75)} y={yScale(95)} fontSize="11" fill="#10b981" fontWeight="bold" textAnchor="middle">
            ✅ 입소문 구동 — 우선 소싱
          </text>
          <text x={xScale(75)} y={yScale(5)} fontSize="11" fill="#ef4444" fontWeight="bold" textAnchor="middle">
            ⛔ 하자·불만 구동 — 위탁 차단
          </text>

          {/* 점들 */}
          {rows.map((r) => (
            <a key={r.id} href={`/admin/trend-radar/products/${r.id}`}>
              <circle
                cx={xScale(r.x)}
                cy={yScale(r.y)}
                r={rScale(r.buzz)}
                fill={POLARITY_COLOR[r.polarity] ?? '#9ca3af'}
                fillOpacity={0.55}
                stroke={POLARITY_COLOR[r.polarity] ?? '#9ca3af'}
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
            <div>polarity: {hover.polarity} · buzz: {hover.buzz}</div>
            {hover.defect_terms.length > 0 && <div>하자: {hover.defect_terms.join(', ')}</div>}
            {hover.evidence && <div className="text-gray-300 mt-1">“{hover.evidence}”</div>}
          </div>
        )}
      </div>

      {/* 범례 */}
      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        {Object.entries(POLARITY_COLOR).map(([k, color]) => (
          <span key={k} className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-full" style={{ background: color, opacity: 0.6 }} />
            {k}
          </span>
        ))}
      </div>

      {/* 하자·불만 구동 위험 목록 */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold mb-2 text-red-600">
          ⛔ 위탁 위험 — 하자·불만 구동 (negative)
        </h3>
        <div className="space-y-1 text-sm">
          {rows
            .filter((r) => r.polarity === 'negative')
            .sort((a, b) => b.buzz - a.buzz)
            .slice(0, 10)
            .map((r) => (
              <Link
                key={r.id}
                href={`/admin/trend-radar/products/${r.id}`}
                className="block px-2 py-1 rounded hover:bg-red-50"
              >
                <span className="font-mono text-gray-500 mr-2">{r.buzz}</span>
                {r.name}
                {r.defect_terms.length > 0 && (
                  <span className="ml-2 text-xs text-red-500">[{r.defect_terms.join(', ')}]</span>
                )}
              </Link>
            ))}
          {rows.filter((r) => r.polarity === 'negative').length === 0 && (
            <div className="text-gray-400 text-xs">하자·불만 구동 후보 없음.</div>
          )}
        </div>
      </div>
    </div>
  )
}
