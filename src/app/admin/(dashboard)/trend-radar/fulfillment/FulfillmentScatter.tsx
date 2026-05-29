'use client'
import { useState } from 'react'

export interface FulfillRow {
  keyword: string
  source: string
  category_top: string | null
  n_obs: number
  mean_vol: number
  stddev_vol: number
  cv: number | null
  spike_freq: number
  autocorr: number | null
  first_seen: string
  last_seen: string
  mode: 'consignment' | 'purchase' | 'hold' | string
}

export const MODE_META: Record<string, { label: string; color: string; badge: string }> = {
  consignment: { label: '위탁 적합', color: '#f59e0b', badge: '🪶 위탁' },
  purchase: { label: '사입 검토', color: '#10b981', badge: '📦 사입' },
  hold: { label: '보류', color: '#9ca3af', badge: '⏸ 보류' },
}

// burn-rate 추정: 평균수요(0~100) → 일 추정 회전. 사입 권고에만 부가.
function estBurn(meanVol: number): string {
  // mean_vol 을 상대 회전 신호로 환산 (휴리스틱: 30→~1주, 60→~3일, 90→~1.5일)
  const daysToTurn = Math.max(1, Math.round(450 / Math.max(meanVol, 1)))
  return `재고회전 ~${daysToTurn}일`
}

export default function FulfillmentScatter({ rows }: { rows: FulfillRow[] }) {
  const [hover, setHover] = useState<FulfillRow | null>(null)
  const [modeFilter, setModeFilter] = useState<string>('all')

  const W = 720
  const H = 480
  const PAD = 56

  // x = CV (변동성, 0 ~ maxCV), y = mean_vol (0~100)
  const maxCV = Math.max(1, ...rows.map((r) => r.cv ?? 0))
  const xScale = (v: number) => PAD + (Math.min(v, maxCV) / maxCV) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (Math.min(v, 100) / 100) * (H - 2 * PAD)
  const rScale = (n: number) => Math.max(4, Math.min(16, 3 + Math.sqrt(n)))

  const visible = modeFilter === 'all' ? rows : rows.filter((r) => r.mode === modeFilter)

  // 사입 임계 가이드선: cv=0.5, mean_vol=30
  const cvLine = xScale(0.5)
  const volLine = yScale(30)

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-gray-500">필터:</span>
        {['all', 'consignment', 'purchase', 'hold'].map((m) => (
          <button
            key={m}
            onClick={() => setModeFilter(m)}
            className={`rounded px-2 py-1 border ${
              modeFilter === m ? 'border-black bg-black text-white' : 'border-gray-300 text-gray-600'
            }`}
          >
            {m === 'all' ? '전체' : MODE_META[m]?.label ?? m}
          </button>
        ))}
      </div>

      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 좌상단(低CV·高볼륨) = 사입 적합 배경 */}
          <rect x={PAD} y={yScale(100)} width={cvLine - PAD} height={volLine - yScale(100)} fill="#f0fdf4" />
          {/* 우측(高CV) = 위탁 배경 */}
          <rect x={cvLine} y={PAD} width={W - PAD - cvLine} height={H - 2 * PAD} fill="#fffbeb" />

          {/* 임계 가이드선 */}
          <line x1={cvLine} y1={PAD} x2={cvLine} y2={H - PAD} stroke="#f59e0b" strokeDasharray="4,4" strokeOpacity={0.6} />
          <line x1={PAD} y1={volLine} x2={W - PAD} y2={volLine} stroke="#10b981" strokeDasharray="4,4" strokeOpacity={0.6} />

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 12} fontSize="11" fill="#6b7280" textAnchor="middle">
            변동성 CV (→ 변동 큼 = 위탁 유리)
          </text>
          <text x={16} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 16 ${H / 2})`}>
            평균 수요 (↑ 고볼륨 = 사입 후보)
          </text>

          {/* 분면 라벨 */}
          <text x={PAD + 12} y={yScale(95)} fontSize="11" fill="#10b981" fontWeight="bold">
            📦 사입 검토 (低CV·高볼륨)
          </text>
          <text x={W - PAD - 12} y={PAD + 14} fontSize="11" fill="#f59e0b" fontWeight="bold" textAnchor="end">
            🪶 위탁 적합 (高CV·간헐 스파이크)
          </text>

          {/* 점들 */}
          {visible.map((r) => {
            const meta = MODE_META[r.mode] ?? MODE_META.hold
            return (
              <circle
                key={r.keyword + r.source}
                cx={xScale(r.cv ?? 0)}
                cy={yScale(r.mean_vol)}
                r={rScale(r.n_obs)}
                fill={meta.color}
                fillOpacity={0.55}
                stroke={meta.color}
                strokeOpacity={0.9}
                onMouseEnter={() => setHover(r)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: 'pointer' }}
              />
            )
          })}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
            <div className="font-semibold">
              {(MODE_META[hover.mode]?.badge ?? '')} {hover.keyword}
            </div>
            <div className="text-gray-300">{hover.source} · {hover.category_top ?? '—'}</div>
            <div>
              CV: {hover.cv ?? '—'} · 평균수요: {hover.mean_vol} · 스파이크: {(hover.spike_freq * 100).toFixed(0)}%
            </div>
            <div>
              자기상관: {hover.autocorr ?? '—'} · 관측 {hover.n_obs}회
            </div>
            {hover.mode === 'purchase' && <div className="text-emerald-300">{estBurn(hover.mean_vol)}</div>}
          </div>
        )}
      </div>

      {/* 범례 */}
      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        {Object.entries(MODE_META).map(([m, meta]) => (
          <span key={m} className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-full" style={{ background: meta.color, opacity: 0.6 }} />
            {meta.label}
          </span>
        ))}
      </div>
    </div>
  )
}
