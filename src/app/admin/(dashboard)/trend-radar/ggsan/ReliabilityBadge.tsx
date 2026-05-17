interface Props {
  score: number | null | undefined
  compact?: boolean
  warning?: string | null
}

export function reliabilityTone(score: number) {
  if (score >= 75) return { bg: 'bg-emerald-100', text: 'text-emerald-700', bar: 'bg-emerald-500', label: '안정' }
  if (score >= 55) return { bg: 'bg-amber-100',   text: 'text-amber-700',   bar: 'bg-amber-500',   label: '보통' }
  if (score >= 40) return { bg: 'bg-orange-100',  text: 'text-orange-700',  bar: 'bg-orange-500',  label: '주의' }
  return            { bg: 'bg-red-100',     text: 'text-red-700',     bar: 'bg-red-500',     label: '경고' }
}

export default function ReliabilityBadge({ score, compact, warning }: Props) {
  if (score == null) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-gray-100 text-gray-400 font-mono">
        ?? 신뢰성
      </span>
    )
  }
  const t = reliabilityTone(score)
  if (compact) {
    return (
      <span
        title={warning ?? `신뢰성 ${score}/100 (${t.label})`}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono ${t.bg} ${t.text}`}
      >
        {score}
      </span>
    )
  }
  return (
    <div className="space-y-1">
      <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${t.bg} ${t.text}`}>
        <span className="font-bold">{score}</span>
        <span>· {t.label}</span>
      </div>
      <div className="h-1 w-full rounded bg-gray-100 overflow-hidden">
        <div className={`h-full ${t.bar}`} style={{ width: `${Math.max(2, Math.min(100, score))}%` }} />
      </div>
      {warning && <div className="text-[10px] text-red-600">⚠ {warning}</div>}
    </div>
  )
}
