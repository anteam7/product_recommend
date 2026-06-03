'use client'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import type { IntentRow } from './page'

export default function JtbdBubble({ rows }: { rows: IntentRow[] }) {
  const [sel, setSel] = useState<IntentRow | null>(null)
  const W = 720
  const H = 480
  const PAD = 56

  const maxDemand = useMemo(() => Math.max(1, ...rows.map((r) => r.demandWeight)), [rows])
  const maxCount = useMemo(() => Math.max(1, ...rows.map((r) => r.productCount)), [rows])

  // X: 수요무게(0~max → 0~100), Y: 공급충족(supplierAvg 0~100)
  const xScale = (v: number) => PAD + (v / maxDemand) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (v / 100) * (H - 2 * PAD)
  const rScale = (count: number) => 8 + Math.sqrt(count / maxCount) * 26

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 우하단 = 미충족 직무 사분면 강조 (수요↑·공급↓) */}
          <rect
            x={xScale(maxDemand / 2)}
            y={yScale(50)}
            width={W - PAD - xScale(maxDemand / 2)}
            height={H - PAD - yScale(50)}
            fill="#fef2f2"
          />

          {/* grid X */}
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <g key={'gx' + f}>
              <line x1={xScale(maxDemand * f)} y1={PAD} x2={xScale(maxDemand * f)} y2={H - PAD} stroke="#e5e7eb" strokeDasharray={f === 0 || f === 0.5 || f === 1 ? '' : '2,3'} />
              <text x={xScale(maxDemand * f)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">
                {Math.round(maxDemand * f)}
              </text>
            </g>
          ))}
          {/* grid Y */}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={'gy' + v}>
              <line x1={PAD} y1={yScale(v)} x2={W - PAD} y2={yScale(v)} stroke="#e5e7eb" strokeDasharray={v % 50 === 0 ? '' : '2,3'} />
              <text x={PAD - 8} y={yScale(v) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
                {v}
              </text>
            </g>
          ))}

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 8} fontSize="11" fill="#6b7280" textAnchor="middle">
            수요무게 Σfinal (→ 수요 강함)
          </text>
          <text x={16} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 16 ${H / 2})`}>
            공급충족 supplier 평균 (↑ 공급 풍부)
          </text>
          <text x={xScale(maxDemand * 0.75)} y={yScale(8)} fontSize="11" fill="#ef4444" fontWeight="bold" textAnchor="middle">
            ⛏ 미충족 직무 (수요↑·공급↓)
          </text>

          {/* 버블 */}
          {rows.map((r) => {
            const cx = xScale(r.demandWeight)
            const cy = yScale(r.supplierAvg)
            const active = sel?.intent === r.intent
            return (
              <g key={r.intent} style={{ cursor: 'pointer' }} onClick={() => setSel(active ? null : r)}>
                <circle
                  cx={cx}
                  cy={cy}
                  r={rScale(r.productCount)}
                  fill="#6366f1"
                  fillOpacity={active ? 0.65 : 0.4}
                  stroke="#4338ca"
                  strokeOpacity={0.9}
                  strokeWidth={active ? 2 : 1}
                />
                <text x={cx} y={cy + 3} fontSize="10" fill="#1e1b4b" textAnchor="middle" fontWeight="600" style={{ pointerEvents: 'none' }}>
                  {r.intent}
                </text>
              </g>
            )
          })}
        </svg>
      </div>

      {/* 집계 테이블 */}
      <div className="mt-6 border-t border-gray-200 pt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-100">
              <th className="py-1.5 pr-3">직무 (intent)</th>
              <th className="py-1.5 pr-3 text-right">상품수</th>
              <th className="py-1.5 pr-3 text-right">수요무게 Σfinal</th>
              <th className="py-1.5 pr-3 text-right">trend 중앙값</th>
              <th className="py-1.5 pr-3 text-right">공급충족 avg</th>
              <th className="py-1.5 pr-3 text-right">ggsan 매칭</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const gap = r.demandWeight >= maxDemand / 2 && r.supplierAvg < 50
              return (
                <tr
                  key={r.intent}
                  onClick={() => setSel(sel?.intent === r.intent ? null : r)}
                  className={`border-b border-gray-50 cursor-pointer hover:bg-gray-50 ${sel?.intent === r.intent ? 'bg-indigo-50' : ''}`}
                >
                  <td className="py-1.5 pr-3 font-medium">
                    {gap && <span title="미충족 직무" className="mr-1">⛏</span>}
                    {r.intent}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{r.productCount}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums font-semibold">{r.demandWeight}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-gray-500">{r.trendMedian}</td>
                  <td className={`py-1.5 pr-3 text-right tabular-nums ${r.supplierAvg < 50 ? 'text-rose-600 font-medium' : ''}`}>{r.supplierAvg}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-gray-500">{Math.round(r.matchRatio * 100)}%</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* 드릴다운 */}
      {sel && (
        <div className="mt-6 border-t border-gray-200 pt-4">
          <h3 className="text-sm font-semibold mb-2">
            “{sel.intent}” 소속 상품 · 수요 {sel.demandWeight} / 공급충족 {sel.supplierAvg} / ggsan 매칭 {Math.round(sel.matchRatio * 100)}%
          </h3>
          <div className="space-y-1 text-sm">
            {sel.products.slice(0, 30).map((p) => (
              <Link
                key={p.id}
                href={`/admin/trend-radar/products/${p.id}`}
                className="flex items-center justify-between px-2 py-1 rounded hover:bg-gray-50"
              >
                <span>
                  <span className="font-mono text-gray-500 mr-2">{p.final}</span>
                  {p.name}
                </span>
                <span className={`text-xs ${p.supplier === 0 ? 'text-rose-600' : 'text-gray-400'}`}>
                  {p.supplier === 0 ? '소싱 공백' : `supplier ${p.supplier}`}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
