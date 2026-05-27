'use client'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import type { AdGateItem } from './page'

type Quadrant = AdGateItem['quadrant']

const QUADRANTS: { key: Quadrant; label: string; help: string; tone: string }[] = [
  {
    key: 'ad_roi',
    label: '광고 ROI 가능',
    help: 'CPC 가 마진의 50% 이하 → 광고 태우면 ROAS 양수 기대',
    tone: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  },
  {
    key: 'organic_seo',
    label: 'Organic SEO 가능',
    help: '광고 ROI 애매하지만 검색량 있음 → 콘텐츠·블로그로 노려라',
    tone: 'border-sky-300 bg-sky-50 text-sky-900',
  },
  {
    key: 'low_search',
    label: '검색량 부족',
    help: '월간 1,000 미만 — 어떤 채널로도 의미 있는 트래픽 안 나옴',
    tone: 'border-gray-300 bg-gray-50 text-gray-700',
  },
  {
    key: 'blocked',
    label: '진입 불가',
    help: 'CPC × CVR 한 건 광고비가 마진보다 큼 → 광고 ROI 음수 확정',
    tone: 'border-rose-300 bg-rose-50 text-rose-900',
  },
]

function fmtKrw(v: number | null) {
  if (v == null) return '-'
  return '₩' + Math.round(v).toLocaleString('ko-KR')
}

function fmtPct(v: number | null, digits = 1) {
  if (v == null || !Number.isFinite(v)) return '-'
  return v.toFixed(digits) + '%'
}

function fmtRatio(v: number | null) {
  if (v == null || !Number.isFinite(v)) return '-'
  return (v * 100).toFixed(0) + '%'
}

export default function AdGateBoard({ items }: { items: AdGateItem[] }) {
  const [filter, setFilter] = useState<Quadrant | 'all'>('all')

  const counts = useMemo(() => {
    const c: Record<Quadrant, number> = { ad_roi: 0, organic_seo: 0, blocked: 0, low_search: 0 }
    for (const it of items) c[it.quadrant] += 1
    return c
  }, [items])

  const visible = useMemo(() => {
    const base = filter === 'all' ? items : items.filter((i) => i.quadrant === filter)
    return [...base].sort((a, b) => {
      // 광고 ROI 순 → 검색량 큰 순 → 마진 큰 순
      const ra = a.adMarginBurnRatio ?? 99
      const rb = b.adMarginBurnRatio ?? 99
      if (ra !== rb) return ra - rb
      return b.monthlySearch - a.monthlySearch
    })
  }, [items, filter])

  return (
    <div className="space-y-6">
      {/* 사분면 카드 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {QUADRANTS.map((q) => {
          const active = filter === q.key
          return (
            <button
              key={q.key}
              onClick={() => setFilter(active ? 'all' : q.key)}
              className={`rounded border p-4 text-left transition ${q.tone} ${active ? 'ring-2 ring-offset-1 ring-black/30' : 'hover:ring-1 hover:ring-black/10'}`}
            >
              <div className="text-xs uppercase tracking-wider opacity-70">{q.label}</div>
              <div className="text-3xl font-bold mt-1">{counts[q.key]}</div>
              <div className="text-xs mt-1 leading-snug opacity-80">{q.help}</div>
            </button>
          )
        })}
      </div>

      {/* 필터 토글 */}
      <div className="flex items-center gap-3 text-sm">
        <span className="text-gray-500">필터:</span>
        <button
          onClick={() => setFilter('all')}
          className={`px-3 py-1 rounded border ${filter === 'all' ? 'bg-black text-white border-black' : 'border-gray-300 hover:bg-gray-50'}`}
        >
          전체 {items.length}
        </button>
        {QUADRANTS.map((q) => (
          <button
            key={q.key}
            onClick={() => setFilter(q.key)}
            className={`px-3 py-1 rounded border ${filter === q.key ? 'bg-black text-white border-black' : 'border-gray-300 hover:bg-gray-50'}`}
          >
            {q.label} {counts[q.key]}
          </button>
        ))}
      </div>

      {/* 테이블 */}
      <div className="overflow-x-auto rounded border border-gray-200">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left">키워드</th>
              <th className="px-3 py-2 text-left">카테고리</th>
              <th className="px-3 py-2 text-right">월 검색량</th>
              <th className="px-3 py-2 text-right">CPC(평균)</th>
              <th className="px-3 py-2 text-left">경쟁</th>
              <th className="px-3 py-2 text-right">도매가</th>
              <th className="px-3 py-2 text-right">판매가(추정)</th>
              <th className="px-3 py-2 text-right">건당 마진</th>
              <th className="px-3 py-2 text-right">건당 광고비</th>
              <th className="px-3 py-2 text-right">Ad-Margin Burn</th>
              <th className="px-3 py-2 text-right">손익분기 CVR</th>
              <th className="px-3 py-2 text-left">진단</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((it, i) => {
              const quad = QUADRANTS.find((q) => q.key === it.quadrant)!
              const burn = it.adMarginBurnRatio
              const burnTone =
                burn == null
                  ? 'text-gray-400'
                  : burn <= 0.5
                  ? 'text-emerald-600 font-semibold'
                  : burn <= 1.0
                  ? 'text-amber-600 font-semibold'
                  : 'text-rose-600 font-semibold'
              return (
                <tr key={it.keyword + i} className="border-t border-gray-100 hover:bg-gray-50/60">
                  <td className="px-3 py-2 font-medium">
                    {it.productId ? (
                      <Link
                        href={`/admin/trend-radar/products/${it.productId}`}
                        className="hover:underline"
                      >
                        {it.keyword}
                      </Link>
                    ) : (
                      it.keyword
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-600">{it.category}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {it.monthlySearch.toLocaleString('ko-KR')}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtKrw(it.cpcAvg)}</td>
                  <td className="px-3 py-2 text-gray-600">{it.competition}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtKrw(it.supplierPriceKrw)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtKrw(it.salePriceKrw)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtKrw(it.marginPerSaleKrw)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtKrw(it.costPerSaleAdKrw)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${burnTone}`}>
                    {fmtRatio(burn)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtPct(it.breakEvenCvr)}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs border ${quad.tone}`}>
                      {quad.label}
                    </span>
                  </td>
                </tr>
              )
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={12} className="px-3 py-12 text-center text-gray-400">
                  해당 사분면에 키워드 없음.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-gray-500 leading-relaxed border-t border-gray-100 pt-4">
        <div className="font-semibold text-gray-700 mb-1">계산 공식</div>
        <ul className="list-disc pl-5 space-y-0.5">
          <li>건당 마진 = 판매가(추정) × 마진율</li>
          <li>건당 광고비 = CPC(평균) ÷ 평균 전환율 — 한 건 판매까지 들어가는 누적 광고비</li>
          <li>Ad-Margin Burn = 건당 광고비 ÷ 건당 마진 (1.0 이상 = 광고 ROI 음수)</li>
          <li>손익분기 CVR = CPC ÷ 건당 마진 × 100 — 이 전환율 이상이면 광고비 회수</li>
          <li>사분면 분류: 검색량 1,000 미만 = 검색량 부족 / Burn≤50% = 광고 ROI / Burn 50~100% = SEO / Burn&gt;100% = 진입 불가</li>
        </ul>
      </div>
    </div>
  )
}
