'use client'

import { useMemo, useState } from 'react'
import {
  CAPITAL_OPTIONS,
  VELOCITY_PROFILES,
  formatDays,
  formatWon,
  simulatePayback,
  type VelocityProfile,
} from '@/lib/trends/payback'

interface Props {
  productId: string
  baseUnitCost: number          // 도매가 (없으면 0)
  baseVelocity: number          // commerce_score 기반 일판매수량
  defaultMarginPct?: number
}

const PROFILES: VelocityProfile[] = ['conservative', 'base', 'aggressive']

export default function PaybackScenarios({
  productId,
  baseUnitCost,
  baseVelocity,
  defaultMarginPct = 30,
}: Props) {
  const [marginPct, setMarginPct] = useState(defaultMarginPct)

  const grid = useMemo(() => {
    return CAPITAL_OPTIONS.map((capital) =>
      PROFILES.map((profile) => {
        const mul = VELOCITY_PROFILES[profile].multiplier
        return {
          capital,
          profile,
          result: simulatePayback({
            unitCost: baseUnitCost || 10_000,
            capitalWon: capital,
            velocity: baseVelocity * mul,
            marginPct,
          }),
        }
      })
    )
  }, [baseUnitCost, baseVelocity, marginPct])

  const noCost = !baseUnitCost || baseUnitCost <= 0

  return (
    <section className="rounded border border-gray-200 p-4">
      <header className="flex items-baseline justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold">💰 Payback 시나리오</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            자본 × 판매속도로 12개 시나리오. 도매가{' '}
            <span className="font-mono text-gray-700">
              {baseUnitCost > 0 ? `${formatWon(baseUnitCost)}원` : '없음(가정 1만원)'}
            </span>{' '}
            · 기본 velocity{' '}
            <span className="font-mono text-gray-700">{baseVelocity.toFixed(1)}개/일</span>
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <label className="text-gray-500">마진율</label>
          <input
            type="range"
            min={5}
            max={80}
            step={5}
            value={marginPct}
            onChange={(e) => setMarginPct(Number(e.target.value))}
            className="w-32"
          />
          <span className="font-mono w-8 text-right">{marginPct}%</span>
        </div>
      </header>

      {noCost && (
        <div className="rounded bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800 mb-3">
          ⚠ 매핑된 도매 supplier 가 없습니다. 도매가 1만원으로 가정한 추정치입니다.
        </div>
      )}

      {/* 12 grid */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-gray-500">
            <tr>
              <th className="px-2 py-1 text-left w-24">자본</th>
              {PROFILES.map((p) => (
                <th key={p} className="px-2 py-1 text-left">
                  {VELOCITY_PROFILES[p].label}{' '}
                  <span className="text-gray-400">×{VELOCITY_PROFILES[p].multiplier}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((row) => (
              <tr key={row[0].capital} className="border-t border-gray-100">
                <td className="px-2 py-2 font-medium">{formatWon(row[0].capital)}원</td>
                {row.map((cell) => (
                  <td key={cell.profile} className="px-2 py-2 align-top">
                    <ScenarioCell cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] text-gray-400 mt-3 font-mono">
        product_id: {productId} · RPC: jimscanner_simulate_payback
      </p>
    </section>
  )
}

function ScenarioCell({
  cell,
}: {
  cell: { capital: number; profile: VelocityProfile; result: ReturnType<typeof simulatePayback> }
}) {
  const r = cell.result
  const bg =
    r.warning === 'negative_margin'
      ? 'bg-red-50 border-red-200'
      : r.warning === 'slow_payback'
      ? 'bg-amber-50 border-amber-200'
      : r.paybackDays <= 30
      ? 'bg-emerald-50 border-emerald-200'
      : 'bg-white border-gray-200'

  return (
    <div className={`rounded border ${bg} p-2`}>
      <div className="flex items-baseline justify-between">
        <div className="font-bold text-sm">{formatDays(r.paybackDays)}</div>
        <div className="text-[10px] text-gray-500">{r.unitsPurchasable}개</div>
      </div>
      <div className="text-[10px] text-gray-600 mt-1">
        ROI 90d <span className="font-mono font-semibold">{r.roi90d.toFixed(0)}%</span>
      </div>
      <div className="text-[10px] text-gray-500">
        일이익 <span className="font-mono">{formatWon(r.dailyProfit)}원</span>
      </div>
      <Sparkline values={r.cumulative} capital={r.capitalWon} />
      {r.warning && (
        <div className="text-[10px] mt-1 font-medium">
          {r.warning === 'negative_margin' ? '⚠ 마진 음수' : '⚠ 회수>120일'}
        </div>
      )}
    </div>
  )
}

function Sparkline({ values, capital }: { values: number[]; capital: number }) {
  const w = 110
  const h = 24
  const max = Math.max(capital, values[values.length - 1] || 1)
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w
      const y = h - (v / max) * h
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const capitalY = h - (capital / max) * h
  return (
    <svg width={w} height={h} className="mt-1 block">
      <line
        x1={0}
        x2={w}
        y1={capitalY}
        y2={capitalY}
        stroke="#9ca3af"
        strokeDasharray="2,2"
        strokeWidth={1}
      />
      <polyline points={points} fill="none" stroke="#0f766e" strokeWidth={1.5} />
    </svg>
  )
}
