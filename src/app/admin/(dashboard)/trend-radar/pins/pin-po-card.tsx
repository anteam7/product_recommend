'use client'

import { useState, useTransition } from 'react'

type Pin = {
  keyword: string
  source: string
  notes: string | null
  pinned_at: string
}

type PoRow = {
  pin_keyword: string
  pin_source: string
  demand_p10: number
  demand_p50: number
  demand_p90: number
  return_rate: number
  unit_cost: number
  price: number
  recommended_qty: number
  expected_profit: number
  assumptions: Record<string, unknown> | null
  computed_at: string | null
}

const DEFAULTS = {
  demand_p10: 30,
  demand_p50: 80,
  demand_p90: 220,
  return_rate: 0.10,
  unit_cost: 8000,
  price: 24000,
}

function formatKRW(n: number): string {
  return new Intl.NumberFormat('ko-KR').format(Math.round(n))
}

export function PinPoCard({ pin, po }: { pin: Pin; po: PoRow | null }) {
  const initial = po ?? { ...DEFAULTS, recommended_qty: 0, expected_profit: 0, assumptions: null, computed_at: null, pin_keyword: pin.keyword, pin_source: pin.source }
  const [current, setCurrent] = useState<PoRow>(initial as PoRow)
  const [showAssumptions, setShowAssumptions] = useState(false)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function patch(partial: Partial<PoRow>) {
    setCurrent((c) => ({ ...c, ...partial }))
  }

  function recalc() {
    setError(null)
    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/trends/po-recommend', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            keyword: pin.keyword,
            source: pin.source,
            unit_cost: current.unit_cost,
            price: current.price,
            return_rate: current.return_rate,
            demand_p10: current.demand_p10,
            demand_p50: current.demand_p50,
            demand_p90: current.demand_p90,
          }),
        })
        const json = await res.json() as { ok?: boolean; recommendation?: PoRow; error?: string }
        if (!res.ok || !json.ok || !json.recommendation) {
          setError(json.error ?? `HTTP ${res.status}`)
          return
        }
        setCurrent(json.recommendation)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })
  }

  const a = current.assumptions ?? {}
  const bootstrap = (a as { bootstrap?: { p10: number; p50: number; p90: number } }).bootstrap ?? null
  const criticalRatio = (a as { critical_ratio?: number }).critical_ratio
  const contributionMargin = (a as { contribution_margin?: number }).contribution_margin

  return (
    <div className="rounded border border-gray-200 bg-white p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="font-medium text-base">{pin.keyword}</div>
          {pin.notes && <div className="text-xs text-gray-500 mt-1">{pin.notes}</div>}
          <div className="text-xs text-gray-400 mt-1 font-mono">
            {pin.source} · {pin.pinned_at?.slice(0, 16)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-500">권장 발주</div>
          <div className="text-2xl font-bold text-blue-600">
            {current.recommended_qty || '—'}개
          </div>
          <div className="text-xs text-gray-500 mt-1">
            기대 마진 ₩{formatKRW(current.expected_profit)}
          </div>
          <button
            type="button"
            onClick={() => setShowAssumptions((s) => !s)}
            className="text-xs text-blue-600 hover:underline mt-1"
          >
            {showAssumptions ? '가정 닫기' : '왜 이 수량?'}
          </button>
        </div>
      </div>

      {showAssumptions && (
        <div className="rounded bg-gray-50 p-3 text-xs space-y-2">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <div>
              <span className="text-gray-500">Critical ratio:</span>{' '}
              <span className="font-mono">{criticalRatio != null ? (criticalRatio * 100).toFixed(1) + '%' : '—'}</span>
            </div>
            <div>
              <span className="text-gray-500">기여마진:</span>{' '}
              <span className="font-mono">{contributionMargin != null ? (contributionMargin * 100).toFixed(1) + '%' : '—'}</span>
            </div>
            <div>
              <span className="text-gray-500">Bootstrap qty:</span>{' '}
              <span className="font-mono">
                {bootstrap ? `${bootstrap.p10} / ${bootstrap.p50} / ${bootstrap.p90}` : '—'}
              </span>
            </div>
            <div>
              <span className="text-gray-500">수요 출처:</span>{' '}
              <span className="font-mono">{String((a as { demand_source?: string }).demand_source ?? 'category_default')}</span>
            </div>
          </div>

          <div className="border-t border-gray-200 pt-2 space-y-2">
            <div className="text-gray-600 font-medium">입력 오버라이드</div>

            <Slider
              label="단가 (₩)"
              value={current.unit_cost}
              min={1000}
              max={100000}
              step={500}
              onChange={(v) => patch({ unit_cost: v })}
              display={formatKRW(current.unit_cost)}
            />
            <Slider
              label="판매가 (₩)"
              value={current.price}
              min={1000}
              max={200000}
              step={500}
              onChange={(v) => patch({ price: v })}
              display={formatKRW(current.price)}
            />
            <Slider
              label="반품률"
              value={current.return_rate}
              min={0}
              max={0.5}
              step={0.01}
              onChange={(v) => patch({ return_rate: v })}
              display={`${(current.return_rate * 100).toFixed(0)}%`}
            />
            <Slider
              label="수요 P50 (30일 예상)"
              value={current.demand_p50}
              min={5}
              max={1000}
              step={5}
              onChange={(v) => patch({ demand_p50: v })}
              display={`${current.demand_p50}개`}
            />

            <div className="flex items-center justify-between pt-1">
              <button
                type="button"
                onClick={recalc}
                disabled={pending}
                className="px-3 py-1.5 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {pending ? '재계산 중…' : '재계산 + 저장'}
              </button>
              {current.computed_at && (
                <div className="text-[10px] text-gray-400 font-mono">
                  {current.computed_at.slice(0, 16)}
                </div>
              )}
            </div>
            {error && <div className="text-xs text-red-600">{error}</div>}
          </div>
        </div>
      )}
    </div>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  display,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  display: string
}) {
  return (
    <label className="block">
      <div className="flex items-center justify-between">
        <span className="text-gray-600">{label}</span>
        <span className="font-mono text-gray-800">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
      />
    </label>
  )
}
