'use client'

import { useMemo, useState } from 'react'

export type ChannelCode = 'smartstore' | 'coupang' | '11st' | 'self'

export interface PnlCell {
  channel_code: ChannelCode
  channel_label: string
  natural_traffic_possible: boolean
  fee_pct: number
  cpc_krw: number
  seo_difficulty: number          // 0~1
  weekly_gmv_krw: number
  weekly_ad_spend_krw: number
  weekly_clicks: number
  net_margin_pct: number | null   // -2 ~ 1 사이 가능
  assumed_price_krw: number
}

export interface PnlRow {
  product_id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  alias_count: number
  cells: PnlCell[]
}

const CHANNEL_ORDER: ChannelCode[] = ['smartstore', 'coupang', '11st', 'self']

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${(v * 100).toFixed(1)}%`
}

function fmtKRW(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${Math.round(v).toLocaleString()}원`
}

function marginColor(m: number | null): string {
  if (m == null) return 'text-gray-400'
  if (m >= 0.30) return 'text-emerald-700'
  if (m >= 0.15) return 'text-amber-700'
  if (m >= 0) return 'text-orange-700'
  return 'text-red-700'
}

function diffLabel(d: number): string {
  if (d < 0.4) return '쉬움'
  if (d < 0.65) return '보통'
  if (d < 0.8) return '어려움'
  return '극난'
}

export default function ChannelPnLMatrix({ rows }: { rows: PnlRow[] }) {
  const [minMargin, setMinMargin] = useState(0)      // 0~50 (%)
  const [naturalOnly, setNaturalOnly] = useState(false)
  const [cateFilter, setCateFilter] = useState<string>('')
  const [modal, setModal] = useState<{ row: PnlRow; cell: PnlCell } | null>(null)

  const categories = useMemo(
    () => Array.from(new Set(rows.map((r) => r.category_top))).sort(),
    [rows],
  )

  const filtered = useMemo(() => {
    return rows.filter((row) => {
      if (cateFilter && row.category_top !== cateFilter) return false
      // 행 단위 필터: 어느 채널이라도 조건 통과하면 표시
      const cells = row.cells.filter((c) => {
        if (naturalOnly && !c.natural_traffic_possible) return false
        if (c.net_margin_pct == null) return false
        return c.net_margin_pct * 100 >= minMargin
      })
      return cells.length > 0
    })
  }, [rows, minMargin, naturalOnly, cateFilter])

  return (
    <div className="space-y-4">
      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-6">
          <label className="flex items-center gap-3 text-xs">
            <span className="text-gray-500">최소 순마진율</span>
            <input
              type="range"
              min={-20}
              max={50}
              step={5}
              value={minMargin}
              onChange={(e) => setMinMargin(Number(e.target.value))}
              className="w-40"
            />
            <span className="font-mono text-gray-800 w-12 text-right">{minMargin}%</span>
          </label>

          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={naturalOnly}
              onChange={(e) => setNaturalOnly(e.target.checked)}
            />
            <span>자연유입 가능 채널만</span>
          </label>

          <label className="flex items-center gap-2 text-xs">
            <span className="text-gray-500">카테고리</span>
            <select
              value={cateFilter}
              onChange={(e) => setCateFilter(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-xs"
            >
              <option value="">전체</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>

          <span className="text-xs text-gray-400 ml-auto">
            {filtered.length} / {rows.length} 핀 표시
          </span>
        </div>
      </div>

      {/* 매트릭스 */}
      {filtered.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 text-sm">
          조건에 맞는 핀이 없습니다. 슬라이더를 낮추거나 필터를 해제해보세요.
        </div>
      ) : (
        <div className="overflow-x-auto border border-gray-200 rounded">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="sticky left-0 bg-gray-50 px-3 py-2 text-left font-medium text-gray-600 w-64">
                  핀 후보
                </th>
                {CHANNEL_ORDER.map((c) => (
                  <th key={c} className="px-2 py-2 text-left font-medium text-gray-600">
                    {c === 'smartstore' && 'Smartstore'}
                    {c === 'coupang' && 'Coupang'}
                    {c === '11st' && '11번가'}
                    {c === 'self' && '자사몰'}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((row) => {
                const cells = CHANNEL_ORDER.map(
                  (cc) => row.cells.find((c) => c.channel_code === cc) ?? null,
                )
                // ⭐: 최고 순마진 채널
                const best = cells.reduce<{ idx: number; m: number } | null>((acc, c, i) => {
                  if (!c || c.net_margin_pct == null) return acc
                  if (!acc || c.net_margin_pct > acc.m) return { idx: i, m: c.net_margin_pct }
                  return acc
                }, null)

                return (
                  <tr key={row.product_id} className="hover:bg-gray-50">
                    <td className="sticky left-0 bg-white px-3 py-2 align-top">
                      <div className="font-medium leading-tight">{row.canonical_name}</div>
                      <div className="text-[10px] text-gray-400 mt-0.5">
                        {row.category_top}
                        {row.category_mid ? ` · ${row.category_mid}` : ''} · alias{' '}
                        {row.alias_count}
                      </div>
                    </td>
                    {cells.map((c, i) => {
                      if (!c) {
                        return (
                          <td key={i} className="px-2 py-2 text-gray-300">
                            —
                          </td>
                        )
                      }
                      const isBest = best?.idx === i
                      return (
                        <td
                          key={i}
                          onClick={() => setModal({ row, cell: c })}
                          className={`px-2 py-2 cursor-pointer hover:bg-amber-50 align-top ${
                            isBest ? 'bg-emerald-50/60' : ''
                          }`}
                          title="클릭하여 P&L breakdown 보기"
                        >
                          <div className="flex items-center gap-1 mb-1">
                            {isBest && <span className="text-amber-500">⭐</span>}
                            <span
                              className={`font-bold font-mono text-sm ${marginColor(c.net_margin_pct)}`}
                            >
                              {fmtPct(c.net_margin_pct)}
                            </span>
                          </div>
                          <div className="text-[10px] text-gray-600 leading-tight space-y-0.5">
                            <div>수수료 {(c.fee_pct * 100).toFixed(1)}%</div>
                            <div>CPC {c.cpc_krw.toLocaleString()}원</div>
                            <div>SEO {diffLabel(c.seo_difficulty)}</div>
                            <div className="text-gray-500">
                              주 GMV {Math.round(c.weekly_gmv_krw / 1000).toLocaleString()}k
                            </div>
                          </div>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 모달 */}
      {modal && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          onClick={() => setModal(null)}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-md w-full p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-baseline justify-between border-b border-gray-100 pb-3">
              <div>
                <div className="text-xs text-gray-500">{modal.cell.channel_label}</div>
                <h2 className="text-lg font-bold">{modal.row.canonical_name}</h2>
              </div>
              <button
                onClick={() => setModal(null)}
                className="text-gray-400 hover:text-black text-2xl leading-none"
              >
                ×
              </button>
            </header>

            <div className="space-y-2 text-sm">
              <Row k="가정 판매가" v={fmtKRW(modal.cell.assumed_price_krw)} />
              <Row k="채널 수수료" v={fmtPct(modal.cell.fee_pct)} />
              <Row k="평균 CPC" v={fmtKRW(modal.cell.cpc_krw)} />
              <Row k="SEO 난이도" v={`${diffLabel(modal.cell.seo_difficulty)} (${modal.cell.seo_difficulty.toFixed(2)})`} />
              <Row k="자연유입" v={modal.cell.natural_traffic_possible ? '가능' : '거의 불가'} />
              <div className="border-t border-gray-100 my-2" />
              <Row k="주간 클릭 추정" v={`${modal.cell.weekly_clicks.toLocaleString()}회`} />
              <Row k="주간 GMV 추정" v={fmtKRW(modal.cell.weekly_gmv_krw)} />
              <Row k="주간 광고비 추정" v={fmtKRW(modal.cell.weekly_ad_spend_krw)} />
              <div className="border-t border-gray-100 my-2" />
              <Row
                k="순마진율"
                v={
                  <span className={`font-bold ${marginColor(modal.cell.net_margin_pct)}`}>
                    {fmtPct(modal.cell.net_margin_pct)}
                  </span>
                }
              />
            </div>

            <div className="text-[10px] text-gray-400 pt-2 border-t border-gray-100 leading-relaxed">
              공식: net_margin = 1 - fee_pct - (CPC / (CR × price)). 판매가 25,000원
              고정 가정 (V0). 카테고리 평균 CR/CTR 사용. ggsan 도매가 연동은 V1.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between text-sm">
      <span className="text-gray-500">{k}</span>
      <span className="font-mono">{v}</span>
    </div>
  )
}
