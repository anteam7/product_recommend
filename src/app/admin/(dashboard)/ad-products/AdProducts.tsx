'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

type Row = {
  seller_product_id: string
  name: string | null
  my_price: number | null
  market_low: number | null
  reprice_target: number | null
  margin_at_price: number | null
  margin_pct: number | null
  view_count: number | null
  sold_count: number | null
  match_count: number | null
  ad_score: number | null
  ad_reason: string | null
  ad_status: string
  note: string | null
  updated_at: string | null
}

const won = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString('ko-KR'))
const STATUS: { key: string; label: string; cls: string }[] = [
  { key: 'candidate', label: '후보', cls: 'bg-sky-100 text-sky-700' },
  { key: 'running', label: '광고중', cls: 'bg-emerald-100 text-emerald-700' },
  { key: 'hold', label: '보류', cls: 'bg-amber-100 text-amber-700' },
  { key: 'excluded', label: '제외', cls: 'bg-gray-100 text-gray-400' },
]
const stCls = (k: string) => STATUS.find((s) => s.key === k)?.cls ?? 'bg-gray-100 text-gray-500'

export default function AdProducts() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/ad-products', { cache: 'no-store' })
      const j = await r.json()
      if (Array.isArray(j.rows)) setRows(j.rows)
    } catch { /* noop */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const setStatus = useCallback(async (spid: string, ad_status: string) => {
    setSaving(spid)
    setRows((rs) => rs.map((r) => (r.seller_product_id === spid ? { ...r, ad_status } : r)))
    try {
      await fetch('/api/admin/ad-products', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seller_product_id: spid, ad_status }),
      })
    } catch { /* noop */ } finally { setSaving(null) }
  }, [])

  const stats = useMemo(() => {
    const s = { total: rows.length, candidate: 0, running: 0, hold: 0, excluded: 0 }
    for (const r of rows) if (r.ad_status in s) s[r.ad_status as keyof typeof s]++
    return s
  }, [rows])

  const view = useMemo(() => (filter ? rows.filter((r) => r.ad_status === filter) : rows), [rows, filter])

  if (loading) return <p className="text-sm text-gray-500">불러오는 중…</p>
  if (!rows.length) return (
    <div className="text-sm text-gray-500 space-y-1">
      <p>아직 광고 후보가 없습니다.</p>
      <p className="text-xs">시세 모니터 스윕(<code className="bg-gray-100 px-1 rounded">coupang-pricewatch.mjs --collect --all</code> → 확장 수집 → <code className="bg-gray-100 px-1 rounded">--compare</code>)이 가격경쟁 가능 + 마진여유 + 수요신호 상품을 자동 선별해 여기 채웁니다.</p>
    </div>
  )

  const chip = (k: string | null, txt: string) => (
    <button onClick={() => setFilter(filter === k ? null : k)} aria-pressed={filter === k}
      className={`rounded-full px-3 py-1 text-xs font-semibold border transition ${filter === k ? 'bg-gray-900 border-gray-900 text-white' : 'border-gray-300 text-gray-500 hover:border-gray-500'}`}>{txt}</button>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-gray-200 bg-white p-3 sm:p-4">
        <Stat n={stats.total} label="광고 후보" />
        <Stat n={stats.running} label="광고중" sep />
        <Stat n={stats.candidate} label="후보 대기" />
        <Stat n={stats.hold} label="보류" />
        <Stat n={stats.excluded} label="제외" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-gray-400 mr-1">필터</span>
        {chip('running', '광고중')}{chip('candidate', '후보')}{chip('hold', '보류')}{chip('excluded', '제외')}
        <span className="ml-auto text-xs text-gray-400">{view.length}건</span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-gray-200">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs">
            <tr>
              <th className="text-left font-medium px-3 py-2">상품</th>
              <th className="text-right font-medium px-3 py-2">내 판매가</th>
              <th className="text-right font-medium px-3 py-2">시세 최저</th>
              <th className="text-right font-medium px-3 py-2">마진</th>
              <th className="text-right font-medium px-3 py-2">조회/판매</th>
              <th className="text-center font-medium px-3 py-2">광고점수</th>
              <th className="text-center font-medium px-3 py-2">상태</th>
            </tr>
          </thead>
          <tbody>
            {view.map((r) => (
              <tr key={r.seller_product_id} className="border-t border-gray-100 hover:bg-gray-50/60 align-top">
                <td className="px-3 py-2 max-w-[300px]">
                  <div className="truncate font-medium text-gray-800">{r.name}</div>
                  {r.ad_reason && <div className="text-[11px] text-gray-400 leading-snug">{r.ad_reason}</div>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {won(r.my_price)}
                  {r.reprice_target != null && r.reprice_target < (r.my_price ?? 0) && (
                    <div className="text-[10px] text-sky-600">→ {won(r.reprice_target)} 조정후</div>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{won(r.market_low)}<span className="text-[10px] text-gray-400"> ({r.match_count ?? 0})</span></td>
                <td className="px-3 py-2 text-right tabular-nums">
                  <span className="font-semibold text-emerald-700">{won(r.margin_at_price)}</span>
                  {r.margin_pct != null && <span className="text-[10px] text-gray-400"> ({r.margin_pct}%)</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-500">{won(r.view_count)}/{won(r.sold_count)}</td>
                <td className="px-3 py-2 text-center tabular-nums font-semibold">{r.ad_score != null ? r.ad_score.toFixed(2) : '—'}</td>
                <td className="px-3 py-2 text-center">
                  <div className="inline-flex flex-col gap-1 items-stretch min-w-[92px]">
                    <span className={`rounded px-2 py-0.5 text-[11px] font-bold ${stCls(r.ad_status)}`}>{STATUS.find((s) => s.key === r.ad_status)?.label ?? r.ad_status}</span>
                    <select
                      value={r.ad_status}
                      disabled={saving === r.seller_product_id}
                      onChange={(e) => setStatus(r.seller_product_id, e.target.value)}
                      className="text-[11px] border border-gray-200 rounded px-1 py-0.5 bg-white disabled:opacity-50"
                    >
                      {STATUS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                    </select>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-500 leading-relaxed">
        <b className="text-gray-800">선별 기준</b> — ① 가격경쟁 가능(이미 최저 <b>WIN</b> 또는 MSP 지키며 조정 가능한 <b>REPRICE</b>) ② 광고비 감당할 마진 여유(≥3,000원·≥12%) ③ 수요 신호(판매 이력·조회수·경쟁매칭). <b>구조적 적자</b>(원가&gt;시세) 상품은 광고해도 위너를 못 잡아 제외됩니다. <b>광고점수</b>는 마진·수요·가격경쟁력 가중합. 상태를 <b>광고중</b>으로 바꾸면 실제 광고 집행 대상으로 추적됩니다.
      </p>
    </div>
  )
}

function Stat({ n, label, sep }: { n: number; label: string; sep?: boolean }) {
  return (
    <div className={`flex flex-col ${sep ? 'border-l border-gray-200 pl-4 sm:pl-6' : ''}`}>
      <b className="text-lg tabular-nums leading-tight">{n}</b>
      <span className="text-[11px] text-gray-400">{label}</span>
    </div>
  )
}
