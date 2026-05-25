interface Row {
  keyword: string
  serp_type: string
  ad_count: number
  organic_count: number
  total_count: number
  ad_density: number | null
  top3_ad_count: number
  top3_ad_ratio: number | null
  avg_ad_price_krw: number | null
  organic_top_domain: string | null
  organic_top_domain_kind: string | null
  weighted_ad_density: number | null
  collected_at: string
}

export default function SerpDensityRow({ row }: { row: Row }) {
  const d = row.ad_density ?? 0
  const wd = row.weighted_ad_density ?? d
  const tone =
    d >= 0.6 ? 'red' : d >= 0.4 ? 'amber' : 'green'
  const barColor = {
    red: 'bg-red-500',
    amber: 'bg-amber-500',
    green: 'bg-green-500',
  }[tone]
  const badge = {
    red: 'BLOCKED',
    amber: 'WARN',
    green: 'CLEAN',
  }[tone]
  const badgeColor = {
    red: 'bg-red-100 text-red-700',
    amber: 'bg-amber-100 text-amber-700',
    green: 'bg-green-100 text-green-700',
  }[tone]

  return (
    <div className="grid grid-cols-12 items-center px-3 py-2 text-sm border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
      <div className="col-span-3">
        <div className="font-medium truncate">{row.keyword}</div>
        <div className="text-xs text-gray-400 mt-0.5">{row.serp_type}</div>
      </div>
      <div className="col-span-3">
        <div className="flex items-center gap-2">
          <span
            className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${badgeColor}`}
          >
            {badge}
          </span>
          <div className="flex-1 h-2 rounded bg-gray-100 overflow-hidden">
            <div
              className={`h-full ${barColor}`}
              style={{ width: `${Math.min(100, Math.round(d * 100))}%` }}
            />
          </div>
          <span className="text-xs font-mono w-12 text-right">
            {(d * 100).toFixed(0)}%
          </span>
        </div>
        <div className="text-xs text-gray-400 mt-0.5">
          weighted {(wd * 100).toFixed(0)}% · 위치 가중
        </div>
      </div>
      <div className="col-span-1 text-right font-mono">{row.ad_count}</div>
      <div className="col-span-1 text-right font-mono">{row.organic_count}</div>
      <div className="col-span-1 text-right font-mono">
        {row.top3_ad_count}/3
      </div>
      <div className="col-span-2 text-xs truncate">
        {row.organic_top_domain ? (
          <>
            <div className="truncate text-gray-700">{row.organic_top_domain}</div>
            <div className="text-[10px] text-gray-400">
              {row.organic_top_domain_kind ?? 'other'}
            </div>
          </>
        ) : (
          <span className="text-gray-300">—</span>
        )}
      </div>
      <div className="col-span-1 text-right text-xs text-gray-400 font-mono">
        {row.collected_at?.slice(5, 16).replace('T', ' ')}
      </div>
    </div>
  )
}
