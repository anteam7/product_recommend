'use client'
import { useMemo, useState } from 'react'

interface WeaknessCell {
  category_top: string
  aspect: string
  neg_count: number
  total_count: number
  neg_ratio: number
  last_30d: boolean
}
interface SnippetRow {
  category_top: string
  aspect: string
  snippet: string | null
  sku_external_id: string
  product_title: string | null
  confidence: number
}

interface Props {
  categories: string[]
  aspectOrder: string[]
  aspectLabels: Record<string, string>
  categoryLabels: Record<string, string>
  cells: Record<string, WeaknessCell>
  snippetsByCell: Record<string, SnippetRow[]>
}

// neg_ratio(0~1) → 빨강 계열 배경
function heatColor(ratio: number, total: number): string {
  if (total === 0) return 'transparent'
  const r = Math.min(1, Math.max(0, ratio))
  const alpha = 0.12 + r * 0.78
  return `rgba(220, 38, 38, ${alpha.toFixed(3)})`
}

// 부정 스니펫 → 토픽 워드 빈도 (간이 워드클라우드)
function topWords(snippets: SnippetRow[], topN = 24): { word: string; count: number }[] {
  const stop = new Set([
    '그리고', '하지만', '너무', '정말', '조금', '진짜', '근데', '그냥', '아주', '매우',
    '있어요', '있습니다', '같아요', '합니다', '해요', '되어', '에서', '으로', '에게', '이런',
    '저런', '그런', '제품', '상품', '구매', '주문', '배송', '입니다',
  ])
  const freq = new Map<string, number>()
  for (const s of snippets) {
    if (!s.snippet) continue
    const tokens = s.snippet
      .replace(/[^가-힣a-zA-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2 && !stop.has(t))
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1)
  }
  return Array.from(freq.entries())
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN)
}

export default function WeakAxisHeatmap({
  categories,
  aspectOrder,
  aspectLabels,
  categoryLabels,
  cells,
  snippetsByCell,
}: Props) {
  const [selected, setSelected] = useState<string | null>(null)

  const selectedSnippets = selected ? snippetsByCell[selected] ?? [] : []
  const words = useMemo(() => topWords(selectedSnippets), [selectedSnippets])
  const maxWord = words[0]?.count ?? 1

  return (
    <div className="space-y-5">
      <div className="overflow-x-auto rounded border border-gray-200">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-gray-50">
              <th className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-left text-xs font-semibold text-gray-500">
                카테고리 \ 속성
              </th>
              {aspectOrder.map((a) => (
                <th key={a} className="px-2 py-2 text-center text-xs font-semibold text-gray-600 whitespace-nowrap">
                  {aspectLabels[a] ?? a}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((cat) => (
              <tr key={cat} className="border-t border-gray-100">
                <td className="sticky left-0 z-10 bg-white px-3 py-2 text-left text-xs font-medium text-gray-700 whitespace-nowrap">
                  {categoryLabels[cat] ?? cat}
                </td>
                {aspectOrder.map((a) => {
                  const key = `${cat}::${a}`
                  const cell = cells[key]
                  const ratio = cell?.neg_ratio ?? 0
                  const total = cell?.total_count ?? 0
                  const isSel = selected === key
                  return (
                    <td
                      key={a}
                      onClick={() => total > 0 && setSelected(isSel ? null : key)}
                      className={`px-2 py-2 text-center align-middle ${
                        total > 0 ? 'cursor-pointer' : 'text-gray-300'
                      } ${isSel ? 'ring-2 ring-black ring-inset' : ''}`}
                      style={{ backgroundColor: heatColor(ratio, total) }}
                      title={total > 0 ? `부정 ${cell!.neg_count}/${total} (${Math.round(ratio * 100)}%)` : '데이터 없음'}
                    >
                      {total > 0 ? (
                        <div className="leading-tight">
                          <div className={`font-semibold ${ratio >= 0.5 ? 'text-white' : 'text-gray-900'}`}>
                            {Math.round(ratio * 100)}%
                          </div>
                          <div className={`text-[10px] ${ratio >= 0.5 ? 'text-red-50' : 'text-gray-500'}`}>
                            n={total}
                          </div>
                        </div>
                      ) : (
                        <span className="text-[10px]">·</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-400">
        셀 = 부정률(%) · n = 분석 리뷰 발화 수 · 색이 진할수록 약점. 빈 셀은 수집 데이터 없음.
      </p>

      {selected && (
        <section className="rounded border border-gray-200 p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">
              {categoryLabels[selected.split('::')[0]] ?? selected.split('::')[0]} ·{' '}
              {aspectLabels[selected.split('::')[1]] ?? selected.split('::')[1]} — 부정 스니펫{' '}
              <span className="text-gray-400 font-normal">({selectedSnippets.length})</span>
            </h2>
            <button onClick={() => setSelected(null)} className="text-xs text-gray-400 hover:text-black">
              닫기 ✕
            </button>
          </div>

          {words.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 items-baseline">
              {words.map((w) => (
                <span
                  key={w.word}
                  className="text-red-700"
                  style={{ fontSize: `${0.75 + (w.count / maxWord) * 0.9}rem`, opacity: 0.55 + (w.count / maxWord) * 0.45 }}
                  title={`${w.count}회`}
                >
                  {w.word}
                </span>
              ))}
            </div>
          )}

          <ul className="mt-4 space-y-1.5 max-h-72 overflow-y-auto">
            {selectedSnippets.slice(0, 80).map((s, i) => (
              <li key={i} className="text-xs text-gray-700 border-l-2 border-red-200 pl-2">
                “{s.snippet}”
                <span className="text-gray-400 ml-1">
                  — {s.product_title ?? s.sku_external_id}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
