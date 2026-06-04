'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'

export interface ReturnMarginRow {
  id: string
  name: string
  category: string
  commerce: number
  final: number
  returnRate: number | null
  surfaceMargin: number | null
  effectiveMargin: number | null
}

function pct(n: number | null, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(digits)}%`
}

// 표면 마진은 높은데 반품 보정 후 마진이 무너지는 후보 = 적색 다운랭크.
function isCollapsing(r: ReturnMarginRow): boolean {
  if (r.surfaceMargin == null || r.effectiveMargin == null) return false
  // 표면은 흑자(>5%)인데 보정 후 적자거나 표면 대비 절반 이상 증발.
  if (r.surfaceMargin > 0.05 && r.effectiveMargin <= 0) return true
  if (r.surfaceMargin > 0 && r.effectiveMargin < r.surfaceMargin * 0.5) return true
  return false
}

export default function ReturnMarginTable({ rows }: { rows: ReturnMarginRow[] }) {
  const [onlyCollapsing, setOnlyCollapsing] = useState(false)

  const sorted = useMemo(() => {
    // 마진 누수가 큰 순(표면 - 실효)으로 정렬, 데이터 없으면 뒤로.
    const withGap = rows.map((r) => {
      const gap =
        r.surfaceMargin != null && r.effectiveMargin != null
          ? r.surfaceMargin - r.effectiveMargin
          : -1
      return { r, gap }
    })
    withGap.sort((a, b) => b.gap - a.gap)
    return withGap.map((x) => x.r)
  }, [rows])

  const view = onlyCollapsing ? sorted.filter(isCollapsing) : sorted
  const collapseCount = useMemo(() => rows.filter(isCollapsing).length, [rows])

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-lg font-semibold">반품 보정 마진</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            표면 마진은 높지만 반품·교환 비용(왕복배송비 + 재포장 손실) 반영 후 무너지는 후보를 적색 다운랭크.
            <span className="ml-1 font-medium text-red-600">{collapseCount}개</span> 위험.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={onlyCollapsing}
            onChange={(e) => setOnlyCollapsing(e.target.checked)}
            className="h-4 w-4"
          />
          무너지는 후보만
        </label>
      </div>

      <div className="overflow-x-auto rounded border border-gray-200">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-3 py-2 font-medium">상품</th>
              <th className="px-3 py-2 font-medium">카테고리</th>
              <th className="px-3 py-2 font-medium text-right">commerce</th>
              <th className="px-3 py-2 font-medium text-right">추정 반품률</th>
              <th className="px-3 py-2 font-medium text-right">표면 마진</th>
              <th className="px-3 py-2 font-medium text-right">반품 보정 마진</th>
            </tr>
          </thead>
          <tbody>
            {view.map((r) => {
              const collapse = isCollapsing(r)
              return (
                <tr
                  key={r.id}
                  className={collapse ? 'bg-red-50' : 'odd:bg-white even:bg-gray-50/50'}
                >
                  <td className="px-3 py-2">
                    <Link
                      href={`/admin/trend-radar/products/${r.id}`}
                      className="text-gray-900 hover:underline"
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-gray-600">{r.category}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.commerce?.toFixed(0) ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{pct(r.returnRate)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{pct(r.surfaceMargin)}</td>
                  <td
                    className={
                      'px-3 py-2 text-right tabular-nums font-medium ' +
                      (collapse
                        ? 'text-red-700'
                        : (r.effectiveMargin ?? 0) < 0
                          ? 'text-red-600'
                          : 'text-gray-900')
                    }
                  >
                    {pct(r.effectiveMargin)}
                    {collapse && <span className="ml-1 text-xs text-red-600">▼</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {view.length === 0 && (
        <div className="rounded border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
          반품 리스크 데이터 없음. <code>scripts/recompute-return-risk.mjs</code> 실행 후 표시됩니다.
        </div>
      )}
    </section>
  )
}
