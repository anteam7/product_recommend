interface ShareSlice {
  seller_name: string
  share_pct: number
}

const COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#0ea5e9',
  '#6366f1', '#a855f7', '#ec4899', '#94a3b8', '#64748b',
]

function classify(hhi: number) {
  if (hhi < 0.15) return { label: '분산시장', color: 'text-green-700', bg: 'bg-green-50', border: 'border-green-200' }
  if (hhi <= 0.25) return { label: '중간', color: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-200' }
  return { label: '과점', color: 'text-red-700', bg: 'bg-red-50', border: 'border-red-200' }
}

export default function SellerDonut({
  shares,
  hhi,
  top1Share,
  top3Share,
  effective,
  snapshotAt,
}: {
  shares: ShareSlice[]
  hhi: number
  top1Share: number
  top3Share: number
  effective: number
  snapshotAt: string
}) {
  const sorted = [...shares].sort((a, b) => b.share_pct - a.share_pct)
  // Top 9 + others 묶기 (도넛 가독성)
  const top = sorted.slice(0, 9)
  const restPct = sorted.slice(9).reduce((s, x) => s + x.share_pct, 0)
  const slices = restPct > 0 ? [...top, { seller_name: '기타', share_pct: restPct }] : top

  const size = 180
  const radius = 70
  const inner = 42
  const cx = size / 2
  const cy = size / 2

  let cumulative = 0
  const total = slices.reduce((s, x) => s + x.share_pct, 0) || 1

  const cls = classify(hhi)

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold">판매자 점유율 (Naver SERP Top 20)</h2>
        <span className="text-[10px] text-gray-400 font-mono">{snapshotAt.slice(0, 16).replace('T', ' ')}</span>
      </div>
      <div className="flex flex-wrap items-center gap-6">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {slices.map((s, i) => {
            const frac = s.share_pct / total
            const start = cumulative
            cumulative += frac
            const end = cumulative
            const a0 = start * Math.PI * 2 - Math.PI / 2
            const a1 = end * Math.PI * 2 - Math.PI / 2
            const x0 = cx + radius * Math.cos(a0)
            const y0 = cy + radius * Math.sin(a0)
            const x1 = cx + radius * Math.cos(a1)
            const y1 = cy + radius * Math.sin(a1)
            const ix0 = cx + inner * Math.cos(a0)
            const iy0 = cy + inner * Math.sin(a0)
            const ix1 = cx + inner * Math.cos(a1)
            const iy1 = cy + inner * Math.sin(a1)
            const large = frac > 0.5 ? 1 : 0
            const d = [
              `M ${x0} ${y0}`,
              `A ${radius} ${radius} 0 ${large} 1 ${x1} ${y1}`,
              `L ${ix1} ${iy1}`,
              `A ${inner} ${inner} 0 ${large} 0 ${ix0} ${iy0}`,
              'Z',
            ].join(' ')
            return <path key={i} d={d} fill={COLORS[i % COLORS.length]} stroke="#fff" strokeWidth={1} />
          })}
          <text x={cx} y={cy - 4} textAnchor="middle" className="fill-gray-900" fontSize={14} fontWeight={700}>
            HHI {hhi.toFixed(3)}
          </text>
          <text x={cx} y={cy + 12} textAnchor="middle" className="fill-gray-500" fontSize={9}>
            유효 {effective.toFixed(1)}셀러
          </text>
        </svg>
        <div className="flex-1 min-w-[240px]">
          <div className="mb-3 flex items-center gap-2 flex-wrap">
            <span className={`text-xs px-2 py-0.5 rounded border ${cls.bg} ${cls.color} ${cls.border}`}>
              {cls.label}
            </span>
            <span className="text-xs text-gray-500">Top1 {(top1Share * 100).toFixed(1)}% · Top3 {(top3Share * 100).toFixed(1)}%</span>
          </div>
          <div className="space-y-1">
            {slices.map((s, i) => (
              <div key={i} className="grid grid-cols-12 text-xs items-center">
                <div className="col-span-1">
                  <span
                    className="inline-block w-3 h-3 rounded-sm"
                    style={{ background: COLORS[i % COLORS.length] }}
                  />
                </div>
                <div className="col-span-8 truncate">{s.seller_name}</div>
                <div className="col-span-3 text-right font-mono text-gray-700">
                  {(s.share_pct * 100).toFixed(1)}%
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
