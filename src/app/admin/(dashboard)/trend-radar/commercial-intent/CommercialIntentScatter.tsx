'use client'
import { useState } from 'react'

export interface IntentRow {
  keyword: string
  category: string | null
  search: number
  shopping: number
  ratio: number
  zone: 'BUY' | 'AVOID'
}

const ZONE_COLOR: Record<IntentRow['zone'], string> = {
  BUY: '#10b981',   // 쇼핑클릭 우세 = 구매의향 高
  AVOID: '#ef4444', // 검색만 폭주 = 정보성·비구매
}

export default function CommercialIntentScatter({ rows }: { rows: IntentRow[] }) {
  const [hover, setHover] = useState<IntentRow | null>(null)
  const W = 720
  const H = 480
  const PAD = 50

  // 두 지수 모두 0~100 (DataLab ratio)
  const xScale = (v: number) => PAD + (v / 100) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (v / 100) * (H - 2 * PAD)

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* BUY 존 배경 (대각선 위 = 쇼핑클릭 우세) */}
          <polygon
            points={`${xScale(0)},${yScale(0)} ${xScale(100)},${yScale(100)} ${xScale(0)},${yScale(100)}`}
            fill="#f0fdf4"
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
                {v}
              </text>
            </g>
          ))}

          {/* 전환선 (대각선 y=x) */}
          <line
            x1={xScale(0)}
            y1={yScale(0)}
            x2={xScale(100)}
            y2={yScale(100)}
            stroke="#6b7280"
            strokeDasharray="5,4"
            strokeWidth={1.5}
          />

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 10} fontSize="11" fill="#6b7280" textAnchor="middle">
            검색관심도 (→ 검색 폭주)
          </text>
          <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
            쇼핑클릭관심도 (↑ 구매의향 강함)
          </text>

          {/* 존 라벨 */}
          <text x={xScale(28)} y={yScale(82)} fontSize="12" fill="#10b981" fontWeight="bold" textAnchor="middle">
            💰 BUY존 (쇼핑클릭 우세)
          </text>
          <text x={xScale(72)} y={yScale(18)} fontSize="12" fill="#ef4444" fontWeight="bold" textAnchor="middle">
            🚫 AVOID존 (검색만 폭주)
          </text>

          {/* 점들 */}
          {rows.map((r, i) => (
            <circle
              key={r.keyword + i}
              cx={xScale(r.search)}
              cy={yScale(r.shopping)}
              r={6}
              fill={ZONE_COLOR[r.zone]}
              fillOpacity={0.55}
              stroke={ZONE_COLOR[r.zone]}
              strokeOpacity={0.9}
              onMouseEnter={() => setHover(r)}
              onMouseLeave={() => setHover(null)}
              style={{ cursor: 'pointer' }}
            />
          ))}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
            <div className="font-semibold">{hover.keyword}</div>
            {hover.category && <div>category: {hover.category}</div>}
            <div>
              검색: {hover.search} · 쇼핑: {hover.shopping} · ratio: {hover.ratio.toFixed(2)}
            </div>
            <div className={hover.zone === 'BUY' ? 'text-emerald-300' : 'text-red-300'}>{hover.zone}존</div>
          </div>
        )}
      </div>

      {/* 범례 */}
      <div className="mt-4 flex flex-wrap gap-4 text-xs">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full" style={{ background: ZONE_COLOR.BUY, opacity: 0.6 }} />
          BUY (ratio ≥ 1 · 쇼핑클릭 우세)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full" style={{ background: ZONE_COLOR.AVOID, opacity: 0.6 }} />
          AVOID (ratio &lt; 1 · 검색만 폭주)
        </span>
      </div>

      {/* BUY존 상위 리스트 */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold mb-2">💰 BUY존 상위 (전환 성향비 高)</h3>
        <div className="space-y-1 text-sm">
          {rows
            .filter((r) => r.zone === 'BUY')
            .sort((a, b) => b.ratio - a.ratio)
            .slice(0, 10)
            .map((r, i) => (
              <div key={r.keyword + i} className="px-2 py-1 rounded hover:bg-gray-50 flex items-baseline gap-2">
                <span className="font-mono text-emerald-600">{r.ratio.toFixed(2)}</span>
                <span>{r.keyword}</span>
                <span className="text-gray-400 text-xs">
                  검색 {r.search} → 쇼핑 {r.shopping}
                </span>
              </div>
            ))}
          {rows.filter((r) => r.zone === 'BUY').length === 0 && (
            <div className="text-gray-400 text-xs">아직 BUY존 키워드 없음. 두 소스가 같은 키워드 축에서 겹쳐야 등장.</div>
          )}
        </div>
      </div>
    </div>
  )
}
