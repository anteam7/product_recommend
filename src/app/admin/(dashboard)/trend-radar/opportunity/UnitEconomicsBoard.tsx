'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import {
  computeUnitEconomics,
  gateColor,
  gateLabel,
  won,
  DEFAULT_FLOOR,
} from '@/lib/trend-radar/unit-economics'

export interface BoardRow {
  id: string
  name: string
  category: string
  finalScore: number | null
  landedCost: number | null
  estimatedSellPrice: number | null
  sellPriceSource: 'observed' | 'heuristic'
}

export default function UnitEconomicsBoard({ rows }: { rows: BoardRow[] }) {
  const [minNet, setMinNet] = useState(DEFAULT_FLOOR.minNet)
  const [minMarginPct, setMinMarginPct] = useState(DEFAULT_FLOOR.minMarginPct)
  const [hideBelow, setHideBelow] = useState(false)

  const computed = useMemo(() => {
    const floor = { minNet, minMarginPct }
    return rows
      .map((r) => ({ row: r, econ: computeUnitEconomics(r.estimatedSellPrice, r.landedCost, floor) }))
      .filter((x) => x.econ != null)
      .sort((a, b) => (b.econ!.expectedNetUnit ?? 0) - (a.econ!.expectedNetUnit ?? 0))
  }, [rows, minNet, minMarginPct])

  const visible = hideBelow ? computed.filter((x) => x.econ!.gateStatus === 'pass') : computed
  const passCount = computed.filter((x) => x.econ!.gateStatus === 'pass').length

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end gap-6 rounded border border-gray-200 bg-gray-50 p-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-600">
            최소 기대 순이익: <span className="font-mono font-bold text-black">{won(minNet)}</span>
          </label>
          <input
            type="range"
            min={0}
            max={10000}
            step={500}
            value={minNet}
            onChange={(e) => setMinNet(Number(e.target.value))}
            className="w-56 accent-emerald-600"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-600">
            최소 순마진: <span className="font-mono font-bold text-black">{minMarginPct}%</span>
          </label>
          <input
            type="range"
            min={0}
            max={50}
            step={1}
            value={minMarginPct}
            onChange={(e) => setMinMarginPct(Number(e.target.value))}
            className="w-56 accent-emerald-600"
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-600">
          <input type="checkbox" checked={hideBelow} onChange={(e) => setHideBelow(e.target.checked)} />
          바닥선 미달 숨김
        </label>
        <div className="ml-auto text-xs text-gray-500">
          게이트 통과 <span className="font-bold text-emerald-600">{passCount}</span> / {computed.length}건
        </div>
      </div>

      <div className="overflow-x-auto rounded border border-gray-200">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left">상품</th>
              <th className="px-3 py-2 text-right">랜디드원가</th>
              <th className="px-3 py-2 text-right">추정판매가</th>
              <th className="px-3 py-2 text-right">단위순이익</th>
              <th className="px-3 py-2 text-right">순마진</th>
              <th className="px-3 py-2 text-center">게이트</th>
              <th className="px-3 py-2 text-right">final</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {visible.map(({ row, econ }) => {
              const e = econ!
              const dim = e.gateStatus !== 'pass'
              return (
                <tr key={row.id} className={dim ? 'bg-gray-50/60 text-gray-400' : ''}>
                  <td className="px-3 py-2">
                    <Link
                      href={`/admin/trend-radar/products/${row.id}`}
                      className="font-medium hover:underline"
                    >
                      {row.name}
                    </Link>
                    <span className="ml-2 text-[10px] text-gray-400">{row.category}</span>
                    {row.sellPriceSource === 'heuristic' && (
                      <span
                        className="ml-1 text-[10px] text-amber-500"
                        title="관찰 판매가 없음 — 랜디드원가 ×2.2 추정"
                      >
                        ~추정
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{won(e.landedCost)}</td>
                  <td className="px-3 py-2 text-right font-mono">{won(e.estimatedSellPrice)}</td>
                  <td className={`px-3 py-2 text-right font-mono font-bold ${dim ? '' : gateColor(e.gateStatus)}`}>
                    {won(e.expectedNetUnit)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{e.netMarginPct}%</td>
                  <td className={`px-3 py-2 text-center text-xs font-medium ${dim ? '' : gateColor(e.gateStatus)}`}>
                    {gateLabel(e.gateStatus)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-gray-500">{row.finalScore ?? '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-gray-400">
        net = 추정판매가 − 랜디드원가 − 배송(₩3,000) − 판매수수료(10.6%) − 부가세(÷11). 출처:
        coupang-recompute-margins.mjs · ~추정 = 관찰 판매가 미관측분(랜디드원가 ×2.2)
      </p>
    </section>
  )
}
