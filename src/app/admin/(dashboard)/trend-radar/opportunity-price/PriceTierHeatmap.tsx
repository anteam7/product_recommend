'use client'
import { useMemo, useState } from 'react'

export interface Candidate {
  goodsNo: string
  title: string
  cateCd: string
  cateLabel: string
  priceKrw: number
  realCost: number
  expectedSell: number
  expectedMargin: number
  expectedMarginPct: number | null
  priceTier: string
  isImminent: boolean
  detailUrl: string | null
  demand: number | null
  competition: number | null
}

// 가격대 버킷 (RPC price_tier 코드와 1:1)
const TIERS: { code: string; label: string }[] = [
  { code: 't1_under10k', label: '₩1만 미만' },
  { code: 't2_10_30k', label: '1~3만' },
  { code: 't3_30_50k', label: '3~5만' },
  { code: 't4_50_100k', label: '5~10만' },
  { code: 't5_over100k', label: '10만+' },
]

interface Cell {
  tier: string
  category: string
  items: Candidate[]
  count: number
  demand: number // 매칭 수요신호 합
  competition: number // 경쟁 밀집도 중앙값 (낮을수록 경쟁 약함)
  ratio: number // 수요/경쟁 비율 — 높을수록 화이트스페이스
  isPocket: boolean // 수요는 높은데 경쟁 비어있는 셀
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export default function PriceTierHeatmap({ candidates }: { candidates: Candidate[] }) {
  const [selected, setSelected] = useState<Cell | null>(null)

  const { categories, cells, maxRatio } = useMemo(() => {
    // 카테고리 = ggsan cate_label (후보 수 많은 순)
    const catCount = new Map<string, number>()
    for (const c of candidates) catCount.set(c.cateLabel, (catCount.get(c.cateLabel) ?? 0) + 1)
    const categories = [...catCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cat]) => cat)

    const cellMap = new Map<string, Candidate[]>()
    for (const c of candidates) {
      const key = `${c.priceTier}|${c.cateLabel}`
      const arr = cellMap.get(key) ?? []
      arr.push(c)
      cellMap.set(key, arr)
    }

    const cells: Cell[] = []
    let maxRatio = 0
    for (const tier of TIERS) {
      for (const category of categories) {
        const items = cellMap.get(`${tier.code}|${category}`) ?? []
        if (items.length === 0) {
          cells.push({ tier: tier.code, category, items, count: 0, demand: 0, competition: 0, ratio: 0, isPocket: false })
          continue
        }
        const demands = items.map((i) => i.demand).filter((v): v is number => v != null)
        const comps = items.map((i) => i.competition).filter((v): v is number => v != null)
        const demand = demands.reduce((a, b) => a + b, 0)
        // competition_score: 100=경쟁 약함 → 경쟁 밀집도는 (100 - score) 로 해석
        const compMedian = comps.length ? median(comps) : 50
        const density = 100 - compMedian // 높을수록 경쟁 빽빽
        const ratio = demand / Math.max(density, 5) // 수요/경쟁밀집
        if (ratio > maxRatio) maxRatio = ratio
        cells.push({
          tier: tier.code,
          category,
          items,
          count: items.length,
          demand,
          competition: compMedian,
          ratio,
          isPocket: false,
        })
      }
    }

    // 가격 포켓 하이라이트: 수요 상위 + 경쟁 밀집도 낮음(competition_score 높음)
    const demandVals = cells.filter((c) => c.count > 0).map((c) => c.demand)
    const demandThreshold = median(demandVals.filter((v) => v > 0)) || 0
    for (const c of cells) {
      c.isPocket = c.count > 0 && c.demand > demandThreshold && c.competition >= 55
    }

    return { categories, cells, maxRatio }
  }, [candidates])

  const cellAt = (tier: string, category: string) =>
    cells.find((c) => c.tier === tier && c.category === category)!

  // 비율 → 색 (녹색 강도)
  const cellColor = (cell: Cell) => {
    if (cell.count === 0) return 'transparent'
    if (cell.isPocket) return 'rgba(16,185,129,0.85)' // 강한 녹색 = 포켓
    const t = maxRatio > 0 ? cell.ratio / maxRatio : 0
    return `rgba(16,185,129,${0.1 + t * 0.5})`
  }

  return (
    <div className="space-y-6">
      {/* 그리드 히트맵 */}
      <div className="rounded border border-gray-200 p-4 overflow-x-auto">
        <table className="border-collapse text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 bg-white p-2 text-left text-gray-500 font-medium">카테고리 \ 가격대</th>
              {TIERS.map((t) => (
                <th key={t.code} className="p-2 text-center text-gray-600 font-medium min-w-[88px]">
                  {t.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((cat) => (
              <tr key={cat}>
                <td className="sticky left-0 bg-white p-2 text-gray-700 font-medium whitespace-nowrap border-r border-gray-100">
                  {cat}
                </td>
                {TIERS.map((t) => {
                  const cell = cellAt(t.code, cat)
                  const active = selected?.tier === t.code && selected?.category === cat
                  return (
                    <td key={t.code} className="p-0.5">
                      <button
                        type="button"
                        disabled={cell.count === 0}
                        onClick={() => setSelected(cell)}
                        title={
                          cell.count === 0
                            ? '후보 없음'
                            : `${cell.count}개 · 수요합 ${cell.demand.toFixed(0)} · 경쟁점수(median) ${cell.competition.toFixed(0)}`
                        }
                        className={`w-full h-12 rounded flex flex-col items-center justify-center transition-all ${
                          cell.count === 0 ? 'cursor-default text-gray-300' : 'cursor-pointer hover:ring-2 hover:ring-emerald-400'
                        } ${active ? 'ring-2 ring-black' : ''}`}
                        style={{ background: cellColor(cell) }}
                      >
                        {cell.count > 0 && (
                          <>
                            <span className={`font-semibold ${cell.isPocket ? 'text-white' : 'text-gray-800'}`}>
                              {cell.count}
                            </span>
                            {cell.isPocket && <span className="text-[9px] text-white leading-none">🟢포켓</span>}
                          </>
                        )}
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded" style={{ background: 'rgba(16,185,129,0.85)' }} /> 가격 포켓 (수요↑·경쟁↓)
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded" style={{ background: 'rgba(16,185,129,0.3)' }} /> 수요/경쟁 비율
          </span>
          <span>숫자 = 위탁 후보 수 · 셀 클릭 → 후보 리스트</span>
        </div>
      </div>

      {/* 드릴다운: 선택 셀 후보 리스트 */}
      {selected && selected.count > 0 && (
        <div className="rounded border border-gray-200 p-4">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="text-sm font-semibold">
              {TIERS.find((t) => t.code === selected.tier)?.label} · {selected.category}
              <span className="ml-2 text-gray-400 font-normal">
                {selected.count}개 · 수요합 {selected.demand.toFixed(0)} · 경쟁점수 {selected.competition.toFixed(0)}
                {selected.isPocket && <span className="ml-2 text-emerald-600 font-semibold">🟢 가격 포켓</span>}
              </span>
            </h3>
            <button onClick={() => setSelected(null)} className="text-xs text-gray-400 hover:text-black">
              닫기 ✕
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-100">
                  <th className="py-1 pr-3">상품</th>
                  <th className="py-1 px-2 text-right">도매가</th>
                  <th className="py-1 px-2 text-right">예상 판매가</th>
                  <th className="py-1 px-2 text-right">예상 마진</th>
                  <th className="py-1 px-2 text-right">마진%</th>
                  <th className="py-1 px-2 text-right">수요</th>
                  <th className="py-1 px-2 text-right">경쟁</th>
                </tr>
              </thead>
              <tbody>
                {[...selected.items]
                  .sort((a, b) => (b.expectedMarginPct ?? -999) - (a.expectedMarginPct ?? -999))
                  .map((c) => (
                    <tr key={c.goodsNo} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="py-1 pr-3 max-w-xs">
                        {c.detailUrl ? (
                          <a href={c.detailUrl} target="_blank" rel="noopener" className="hover:underline line-clamp-1" title={c.title}>
                            {c.isImminent && <span className="text-red-600 mr-1">임박</span>}
                            {c.title}
                          </a>
                        ) : (
                          <span className="line-clamp-1" title={c.title}>{c.title}</span>
                        )}
                      </td>
                      <td className="py-1 px-2 text-right text-gray-500 font-mono">{c.priceKrw.toLocaleString()}</td>
                      <td className="py-1 px-2 text-right font-mono">{c.expectedSell.toLocaleString()}</td>
                      <td className="py-1 px-2 text-right font-mono">{c.expectedMargin.toLocaleString()}</td>
                      <td className={`py-1 px-2 text-right font-mono ${(c.expectedMarginPct ?? 0) < 10 ? 'text-red-500' : 'text-emerald-600'}`}>
                        {c.expectedMarginPct != null ? `${c.expectedMarginPct}%` : '—'}
                      </td>
                      <td className="py-1 px-2 text-right font-mono text-gray-600">{c.demand != null ? c.demand.toFixed(0) : '—'}</td>
                      <td className="py-1 px-2 text-right font-mono text-gray-600">{c.competition != null ? c.competition.toFixed(0) : '—'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
