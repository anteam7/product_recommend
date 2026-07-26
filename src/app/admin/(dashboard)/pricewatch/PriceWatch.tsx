'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

type Row = {
  id: string
  name: string | null
  my_price: number | null
  my_cost: number | null
  msp_price_krw: number | null
  market_low: number | null
  match_count: number | null
  best_match_title: string | null
  gap: number | null
  status: string | null
  cost_over_market: boolean | null
  price_verdict: string | null
  reprice_target: number | null
  margin_at_target: number | null
  repriced_at: string | null
  ad_candidate: boolean | null
  sold_count: number | null
  view_count: number | null
  checked_at: string | null
}

const won = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString('ko-KR'))
const badge: Record<string, string> = {
  WIN: 'bg-emerald-100 text-emerald-700',
  REPRICE: 'bg-sky-100 text-sky-700',
  STRUCTURAL: 'bg-rose-100 text-rose-700',
  MSP_HOLE: 'bg-amber-100 text-amber-700',
  UNKNOWN: 'bg-gray-100 text-gray-500',
}
const label: Record<string, string> = { WIN: '최저권', REPRICE: '조정가능', STRUCTURAL: '구조적적자', MSP_HOLE: 'MSP없음', UNKNOWN: '미매칭' }

export default function PriceWatch() {
  const [rows, setRows] = useState<Row[]>([])
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/pricewatch', { cache: 'no-store' })
      const j = await r.json()
      if (Array.isArray(j.rows)) setRows(j.rows)
      setCheckedAt(j.checkedAt ?? null)
    } catch { /* noop */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const vOf = (r: Row) => r.price_verdict ?? 'UNKNOWN'
  const stats = useMemo(() => {
    const s = { total: rows.length, WIN: 0, REPRICE: 0, STRUCTURAL: 0, MSP_HOLE: 0, UNKNOWN: 0, ad: 0 }
    for (const r of rows) { const v = vOf(r); if (v in s) s[v as keyof typeof s]++; if (r.ad_candidate) s.ad++ }
    return s
  }, [rows])

  const view = useMemo(() => (filter ? rows.filter((r) => vOf(r) === filter) : rows), [rows, filter])

  if (loading) return <p className="text-sm text-gray-500">불러오는 중…</p>
  if (!rows.length) return (
    <div className="text-sm text-gray-500 space-y-1">
      <p>아직 가격 모니터 결과가 없습니다.</p>
      <p className="text-xs">터미널: <code className="bg-gray-100 px-1 rounded">node scripts/coupang-pricewatch.mjs --collect --all</code> → 확장이 수집(페이싱) → <code className="bg-gray-100 px-1 rounded">--compare &lt;세션id&gt;</code> 로 발행하면 여기 표시됩니다.</p>
    </div>
  )

  const chip = (k: string, txt: string) => (
    <button onClick={() => setFilter(filter === k ? null : k)} aria-pressed={filter === k}
      className={`rounded-full px-3 py-1 text-xs font-semibold border transition ${filter === k ? 'bg-gray-900 border-gray-900 text-white' : 'border-gray-300 text-gray-500 hover:border-gray-500'}`}>{txt}</button>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-gray-200 bg-white p-3 sm:p-4">
        <Stat n={stats.total} label="모니터 상품" />
        <Stat n={stats.WIN} label="최저권 WIN" sep />
        <Stat n={stats.REPRICE} label="조정가능" />
        <Stat n={stats.STRUCTURAL} label="구조적적자" />
        <Stat n={stats.MSP_HOLE} label="MSP없음" />
        <Stat n={stats.ad} label="광고후보" sep />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-gray-400 mr-1">필터</span>
        {chip('REPRICE', '조정가능')}{chip('STRUCTURAL', '구조적적자')}{chip('MSP_HOLE', 'MSP없음')}{chip('WIN', '최저권')}{chip('UNKNOWN', '미매칭')}
        <span className="ml-auto text-xs text-gray-400">
          {checkedAt ? `수집 ${new Date(checkedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''} · {view.length}건
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-gray-200">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs">
            <tr>
              <th className="text-left font-medium px-3 py-2">상품</th>
              <th className="text-right font-medium px-3 py-2">내 판매가</th>
              <th className="text-right font-medium px-3 py-2">시세 최저</th>
              <th className="text-right font-medium px-3 py-2">MSP</th>
              <th className="text-center font-medium px-3 py-2">판정 · 조치</th>
              <th className="text-right font-medium px-3 py-2">내 원가</th>
            </tr>
          </thead>
          <tbody>
            {view.map((r) => {
              const v = vOf(r)
              return (
                <tr key={r.id} className="border-t border-gray-100 hover:bg-gray-50/60 align-top">
                  <td className="px-3 py-2 max-w-[280px]">
                    <div className="truncate font-medium text-gray-800">{r.name}</div>
                    {r.best_match_title && v !== 'UNKNOWN' && (
                      <div className="truncate text-[11px] text-gray-400">최저가: {r.best_match_title}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {won(r.my_price)}
                    {r.gap != null && r.gap > 0 && <div className="text-[10px] text-rose-500">시세+{won(r.gap)}</div>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{won(r.market_low)}<span className="text-[10px] text-gray-400"> ({r.match_count ?? 0})</span></td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-500">{won(r.msp_price_krw)}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-bold ${badge[v]}`}>{label[v]}</span>
                    {v === 'REPRICE' && r.reprice_target != null && (
                      <div className="text-[11px] text-sky-600 font-semibold mt-0.5">→ {won(r.reprice_target)} <span className="text-gray-400">(마진 {won(r.margin_at_target)})</span></div>
                    )}
                    {r.repriced_at && <div className="text-[10px] text-emerald-500 mt-0.5">✓ 조정완료</div>}
                    {r.ad_candidate && <div className="text-[10px] text-sky-500 font-semibold mt-0.5">📣 광고후보</div>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-500">{won(r.my_cost)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-500 leading-relaxed">
        <b className="text-gray-800">판정(하한=MSP 준수)</b> — <b className="text-sky-700">조정가능(REPRICE)</b>: MSP를 지키면서 시세 최저 이하로 내려 <b>흑자로 아이템위너</b>가 될 수 있음 → 목표가로 자동 조정 대상. <b className="text-rose-700">구조적적자(STRUCTURAL)</b>: MSP 하한까지 내려도 시세보다 비싸거나 적자 → <b>소싱 교체/철수</b>. <b className="text-amber-700">MSP없음</b>: 최저판매가 미설정 → ggsan 백필 후 재판정. 시세는 확장이 상품명으로 검색·매칭한 결과라 방향성 참고치(매칭수 적으면 신뢰도↓)입니다. 자동조정은 <code className="bg-gray-100 px-1 rounded">coupang-pricewatch.mjs --reprice --apply</code>.
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
