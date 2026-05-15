function flatten(obj: any, prefix = ''): Record<string, number> {
  const out: Record<string, number> = {}
  if (obj == null || typeof obj !== 'object') return out
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[path] = v
    } else if (v && typeof v === 'object') {
      Object.assign(out, flatten(v, path))
    }
  }
  return out
}

interface Props {
  latest: any
  previous: any
  latestAt?: string
  previousAt?: string
}

export default function WhyNowBadge({ latest, previous, latestAt, previousAt }: Props) {
  if (!latest || !previous) return null
  const cur = flatten(latest)
  const prev = flatten(previous)
  let best: { path: string; cur: number; prev: number; delta: number; pct: number } | null = null
  for (const [path, curVal] of Object.entries(cur)) {
    const prevVal = prev[path]
    if (prevVal == null) continue
    const delta = curVal - prevVal
    if (delta <= 0) continue
    const denom = Math.abs(prevVal) < 0.01 ? 0.01 : Math.abs(prevVal)
    const pct = (delta / denom) * 100
    if (!best || pct > best.pct) best = { path, cur: curVal, prev: prevVal, delta, pct }
  }

  if (!best) {
    return (
      <div className="rounded border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-500">
        Why now: 직전 산출 대비 의미 있는 상승 컴포넌트 없음
      </div>
    )
  }

  // Time delta hint
  let windowLabel = ''
  if (latestAt && previousAt) {
    const diffMs = new Date(latestAt).getTime() - new Date(previousAt).getTime()
    const diffDays = Math.max(1, Math.round(diffMs / 86400000))
    windowLabel = ` (${diffDays}d)`
  }

  const pctTxt = best.pct >= 1000 ? '>1000' : best.pct.toFixed(0)

  return (
    <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3">
      <div className="text-sm">
        <span className="text-amber-900 font-semibold">🔥 Why now:</span>{' '}
        <span className="font-mono text-amber-900">{best.path}</span>{' '}
        <span className="text-amber-700">+{pctTxt}%</span>
        <span className="text-amber-700">{windowLabel}</span>
      </div>
      <div className="text-[11px] text-amber-700 mt-1 font-mono">
        {best.prev.toFixed(2)} → {best.cur.toFixed(2)} (Δ {best.delta >= 0 ? '+' : ''}
        {best.delta.toFixed(2)})
      </div>
    </div>
  )
}
