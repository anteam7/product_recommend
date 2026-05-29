'use client'
import { useState } from 'react'

export interface SourceAlphaRow {
  source: string
  products_captured: number
  winners_captured: number
  precision: number | null
  recall: number | null
  median_lead_days: number | null
  early_winners: number
  lead_days_samples: number[]
}

function pct(v: number | null): string {
  if (v == null) return '—'
  return `${Math.round(v * 100)}%`
}

function lead(v: number | null): string {
  if (v == null) return '—'
  const r = Math.round(v * 10) / 10
  return r > 0 ? `+${r}d` : `${r}d`
}

// 위너 lead-day 표본을 막대 히스토그램(SVG)으로. 0 기준 좌(늦음)·우(빠름).
function LeadHistogram({ samples }: { samples: number[] }) {
  if (!samples.length) return <span className="text-xs text-gray-300">표본 없음</span>

  const min = Math.min(...samples, 0)
  const max = Math.max(...samples, 0)
  const span = Math.max(max - min, 1)
  const BINS = 12
  const bins = new Array(BINS).fill(0)
  for (const s of samples) {
    const idx = Math.min(BINS - 1, Math.floor(((s - min) / span) * BINS))
    bins[idx]++
  }
  const peak = Math.max(...bins, 1)

  const W = 180
  const H = 38
  const bw = W / BINS
  // 0일 지점의 x 위치 (선행/지연 경계선)
  const zeroX = ((0 - min) / span) * W

  return (
    <svg width={W} height={H} className="block" style={{ overflow: 'visible' }}>
      {bins.map((c, i) => {
        const h = (c / peak) * (H - 6)
        const binStart = min + (i / BINS) * span
        const early = binStart >= 0
        return (
          <rect
            key={i}
            x={i * bw + 0.5}
            y={H - h}
            width={bw - 1}
            height={h}
            fill={early ? '#10b981' : '#f59e0b'}
            fillOpacity={0.7}
          />
        )
      })}
      {/* 0일 경계선 */}
      <line x1={zeroX} y1={0} x2={zeroX} y2={H} stroke="#374151" strokeWidth={1} strokeDasharray="2,2" />
    </svg>
  )
}

export default function SourceAlphaBoard({
  rows,
  threshold,
}: {
  rows: SourceAlphaRow[]
  threshold: number
}) {
  const [sortKey, setSortKey] = useState<'precision' | 'recall' | 'median_lead_days'>('precision')

  const sorted = [...rows].sort((a, b) => {
    const av = a[sortKey] ?? -Infinity
    const bv = b[sortKey] ?? -Infinity
    return bv - av
  })

  const totalWinners =
    rows.length && rows[0].recall
      ? Math.round(rows[0].winners_captured / rows[0].recall)
      : null

  const SortBtn = ({ k, label }: { k: typeof sortKey; label: string }) => (
    <button
      onClick={() => setSortKey(k)}
      className={`px-1 ${sortKey === k ? 'font-bold text-black underline' : 'text-gray-400 hover:text-gray-700'}`}
    >
      {label}
    </button>
  )

  return (
    <div className="rounded border border-gray-200 overflow-x-auto">
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 text-xs text-gray-500">
        <span>
          위너 임계 final_score ≥ <strong className="text-gray-700">{threshold}</strong>
          {totalWinners != null && (
            <>
              {' '}· 전체 위너 <strong className="text-gray-700">{totalWinners}</strong>개
            </>
          )}
        </span>
        <span>
          정렬: <SortBtn k="precision" label="적중률" /> · <SortBtn k="recall" label="커버리지" /> ·{' '}
          <SortBtn k="median_lead_days" label="선행일수" />
        </span>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-white text-gray-500 border-b border-gray-200">
          <tr>
            <th className="px-3 py-2 text-left">#</th>
            <th className="px-3 py-2 text-left">source</th>
            <th className="px-3 py-2 text-right" title="그 소스가 잡은 상품 중 위너 비율">
              적중률
            </th>
            <th className="px-3 py-2 text-right" title="전체 위너 중 그 소스가 잡은 비율">
              커버리지
            </th>
            <th className="px-3 py-2 text-right" title="임계 돌파일 대비 최초 포착 선행일수(중앙값)">
              선행(중앙)
            </th>
            <th className="px-3 py-2 text-right" title="포착 / 위너 / 조기포착(돌파 전)">
              포착·위너·조기
            </th>
            <th className="px-3 py-2 text-left">선행일수 분포</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {sorted.map((r, i) => {
            // '조기·고정밀' 강조: 적중률 ≥ 50% & 중앙 선행 > 0
            const isAlpha = (r.precision ?? 0) >= 0.5 && (r.median_lead_days ?? 0) > 0
            return (
              <tr key={r.source} className={isAlpha ? 'bg-green-50' : ''}>
                <td className="px-3 py-2 text-gray-400">{i + 1}</td>
                <td className="px-3 py-2 font-mono">
                  {isAlpha && <span title="조기·고정밀 채널">⭐ </span>}
                  {r.source}
                </td>
                <td className="px-3 py-2 text-right font-semibold">{pct(r.precision)}</td>
                <td className="px-3 py-2 text-right text-gray-600">{pct(r.recall)}</td>
                <td
                  className={`px-3 py-2 text-right font-mono ${
                    (r.median_lead_days ?? 0) > 0 ? 'text-green-700' : 'text-gray-500'
                  }`}
                >
                  {lead(r.median_lead_days)}
                </td>
                <td className="px-3 py-2 text-right text-xs text-gray-500">
                  {r.products_captured} · {r.winners_captured} · {r.early_winners}
                </td>
                <td className="px-3 py-2">
                  <LeadHistogram samples={r.lead_days_samples} />
                </td>
              </tr>
            )
          })}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-8 text-center text-gray-400 text-xs">
                아직 위너(임계 돌파) 또는 alias 매핑 데이터가 없음. score/alias 누적 후 재방문.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="px-3 py-2 text-xs text-gray-400 border-t border-gray-100">
        <span className="inline-block w-2 h-2 bg-[#10b981] mr-1 align-middle" /> 조기 포착(돌파 전) ·{' '}
        <span className="inline-block w-2 h-2 bg-[#f59e0b] mr-1 ml-2 align-middle" /> 지연 포착(돌파 후) · 점선 = 0일
        경계 · ⭐ = 적중률≥50% &amp; 중앙 선행&gt;0 (수집 빈도 증액 1순위)
      </div>
    </div>
  )
}
