'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

type Row = {
  id: string
  name: string | null
  keyword: string | null
  my_price: number | null
  my_cost: number | null
  market_low: number | null
  market_median: number | null
  match_count: number | null
  best_match_title: string | null
  gap: number | null
  status: string | null
  cost_over_market: boolean | null
  checked_at: string | null
}

const won = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString('ko-KR'))
const badge: Record<string, string> = {
  WIN: 'bg-emerald-100 text-emerald-700',
  PAR: 'bg-amber-100 text-amber-700',
  LOSE: 'bg-rose-100 text-rose-700',
  UNKNOWN: 'bg-gray-100 text-gray-500',
}
const label: Record<string, string> = { WIN: '최저권', PAR: '중간', LOSE: '비쌈', UNKNOWN: '미매칭' }

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

  const stats = useMemo(() => {
    const s = { total: rows.length, WIN: 0, PAR: 0, LOSE: 0, UNKNOWN: 0, structural: 0 }
    for (const r of rows) { s[(r.status as keyof typeof s) ?? 'UNKNOWN']++; if (r.cost_over_market) s.structural++ }
    return s
  }, [rows])

  const view = useMemo(() => (filter ? rows.filter((r) => r.status === filter) : rows), [rows, filter])

  if (loading) return <p className="text-sm text-gray-500">불러오는 중…</p>
  if (!rows.length) return (
    <div className="text-sm text-gray-500 space-y-1">
      <p>아직 가격 모니터 결과가 없습니다.</p>
      <p className="text-xs">터미널: <code className="bg-gray-100 px-1 rounded">node scripts/coupang-pricewatch.mjs --collect</code> → 확장이 수집(페이싱) → <code className="bg-gray-100 px-1 rounded">--compare &lt;세션id&gt;</code> 로 발행하면 여기 표시됩니다.</p>
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
        <Stat n={stats.PAR} label="중간 PAR" />
        <Stat n={stats.LOSE} label="비쌈 LOSE" />
        <Stat n={stats.structural} label="구조적 적자" sep />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-gray-400 mr-1">필터</span>
        {chip('LOSE', '비쌈')}{chip('PAR', '중간')}{chip('WIN', '최저권')}{chip('UNKNOWN', '미매칭')}
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
              <th className="text-right font-medium px-3 py-2">가격차</th>
              <th className="text-center font-medium px-3 py-2">상태</th>
              <th className="text-right font-medium px-3 py-2">내 원가</th>
            </tr>
          </thead>
          <tbody>
            {view.map((r) => (
              <tr key={r.id} className="border-t border-gray-100 hover:bg-gray-50/60">
                <td className="px-3 py-2 max-w-[280px]">
                  <div className="truncate font-medium text-gray-800">{r.name}</div>
                  {r.best_match_title && r.status !== 'UNKNOWN' && (
                    <div className="truncate text-[11px] text-gray-400">최저가: {r.best_match_title}</div>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{won(r.my_price)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{won(r.market_low)}<span className="text-[10px] text-gray-400"> ({r.match_count ?? 0})</span></td>
                <td className={`px-3 py-2 text-right tabular-nums font-semibold ${(r.gap ?? 0) > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                  {r.gap == null ? '—' : (r.gap > 0 ? `+${won(r.gap)}` : won(r.gap))}
                </td>
                <td className="px-3 py-2 text-center">
                  <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-bold ${badge[r.status ?? 'UNKNOWN']}`}>{label[r.status ?? 'UNKNOWN']}</span>
                  {r.cost_over_market && <div className="text-[10px] text-rose-500 font-semibold mt-0.5">원가&gt;시세</div>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-500">{won(r.my_cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-500 leading-relaxed">
        <b className="text-gray-800">해석</b> — <b>비쌈(LOSE)</b>은 시세 최저보다 내 가격이 높아 아이템위너를 뺏긴 상태(노출·판매 급감). <b className="text-rose-600">원가&gt;시세</b> 표시는 <b>내 원가가 경쟁 최저가보다 높아</b> 가격을 낮춰도 못 이기는 <b>구조적 적자</b>입니다 — 이런 상품은 가격 조정이 아니라 소싱 교체/철수 대상입니다. 시세는 확장이 상품명으로 검색해 매칭한 결과라 방향성 참고치이며, 재확인은 <code className="bg-gray-100 px-1 rounded">coupang-pricewatch.mjs</code>로 재수집하세요.
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
