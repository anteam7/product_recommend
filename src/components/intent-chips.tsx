import { INTENT_META, type IntentStage } from '@/lib/query-modifier'

/**
 * '인텐트 구성' 칩 — modifier-map · products/[id] · ggsan recommend 공용.
 * 서버 컴포넌트 호환(훅 없음).
 */
export function IntentChips({
  chips,
  max = 16,
}: {
  chips: { modifier: string; stage: IntentStage }[]
  max?: number
}) {
  if (chips.length === 0) {
    return <span className="text-xs text-gray-400">수식어 신호 없음</span>
  }
  return (
    <div className="flex flex-wrap gap-1">
      {chips.slice(0, max).map((c, i) => {
        const meta = INTENT_META[c.stage]
        return (
          <span
            key={`${c.modifier}-${i}`}
            className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${meta.color}`}
            title={meta.label}
          >
            {meta.emoji} {c.modifier}
          </span>
        )
      })}
      {chips.length > max && (
        <span className="text-[11px] px-1.5 py-0.5 text-gray-400">
          +{chips.length - max}
        </span>
      )}
    </div>
  )
}

/** 단계별 비중 막대 (작은 스택바). */
export function IntentStageBar({
  byStage,
  total,
}: {
  byStage: Record<IntentStage, number>
  total: number
}) {
  const order: IntentStage[] = ['transaction', 'compare', 'spec', 'info', 'risk', 'other']
  if (total <= 0) return <div className="h-2 rounded bg-gray-100" />
  return (
    <div className="flex h-2 w-full overflow-hidden rounded">
      {order.map((stage) => {
        const n = byStage[stage]
        if (!n) return null
        const pct = (n / total) * 100
        const meta = INTENT_META[stage]
        return (
          <div
            key={stage}
            className={meta.color.split(' ')[0]}
            style={{ width: `${pct}%` }}
            title={`${meta.label} ${n} (${pct.toFixed(0)}%)`}
          />
        )
      })}
    </div>
  )
}
