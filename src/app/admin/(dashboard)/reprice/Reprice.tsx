'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

type Row = {
  seller_product_id: string
  name: string | null
  my_price: number | null
  my_cost: number | null
  msp_price_krw: number | null
  market_low: number | null
  match_count: number | null
  best_match_title: string | null
  reprice_target: number | null
  margin_at_target: number | null
  reprice_approved_at: string | null
  sold_count: number | null
  view_count: number | null
}

const won = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString('ko-KR'))

// 집PC --reprice 안전게이트와 동일 기준으로 근거/판정 계산
function gate(r: Row) {
  const my = r.my_price ?? 0, t = r.reprice_target ?? 0, msp = r.msp_price_krw ?? 0
  const drop = my > 0 && t > 0 ? (my - t) / my : 0
  const w: string[] = []
  if (!t || t >= my) w.push('내릴 것 없음')
  if (!msp || t < msp) w.push('MSP 위반')
  if ((r.match_count ?? 0) < 5) w.push('매칭<5(팩 오매칭 위험)')
  if (drop > 0.45) w.push('인하 과대(>45%)')
  if ((r.margin_at_target ?? -1) < 0) w.push('목표가 적자')
  return { drop, safe: w.length === 0, warnings: w }
}

export default function Reprice() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/reprice', { cache: 'no-store' })
      const j = await r.json()
      if (Array.isArray(j.rows)) setRows(j.rows)
    } catch { /* noop */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const approve = useCallback(async (spid: string, on: boolean) => {
    setBusy(spid)
    setRows((rs) => rs.map((r) => (r.seller_product_id === spid ? { ...r, reprice_approved_at: on ? new Date().toISOString() : null } : r)))
    try {
      await fetch('/api/admin/reprice', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seller_product_id: spid, approve: on }),
      })
    } catch { /* noop */ } finally { setBusy(null) }
  }, [])

  const approveAllSafe = useCallback(async () => {
    const targets = rows.filter((r) => gate(r).safe && !r.reprice_approved_at)
    for (const r of targets) await approve(r.seller_product_id, true)
  }, [rows, approve])

  const stats = useMemo(() => {
    let safe = 0, approved = 0
    for (const r of rows) { if (gate(r).safe) safe++; if (r.reprice_approved_at) approved++ }
    return { total: rows.length, safe, approved }
  }, [rows])

  if (loading) return <p className="text-sm text-gray-500">불러오는 중…</p>
  if (!rows.length) return (
    <div className="text-sm text-gray-500 space-y-1">
      <p>현재 가격수정 대상(REPRICE)이 없습니다.</p>
      <p className="text-xs">시세 스윕이 진행되면 <b>MSP를 지키며 흑자로 위너 가능한</b> 상품이 여기 쌓입니다. 영양제는 대부분 구조적 적자라 대상이 아닙니다 — 생활잡화·기타 카테고리에서 나올 가능성이 큽니다.</p>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-gray-200 bg-white p-3 sm:p-4">
        <Stat n={stats.total} label="가격수정 대상" />
        <Stat n={stats.safe} label="안전(게이트 통과)" sep />
        <Stat n={stats.approved} label="승인됨" />
        <button
          onClick={approveAllSafe}
          disabled={stats.safe === 0 || !!busy}
          className="ml-auto rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
        >안전한 것 모두 승인</button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-gray-200">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs">
            <tr>
              <th className="text-left font-medium px-3 py-2">상품</th>
              <th className="text-right font-medium px-3 py-2">내 판매가 → 목표가</th>
              <th className="text-right font-medium px-3 py-2">시세 · MSP</th>
              <th className="text-right font-medium px-3 py-2">인하 · 목표마진</th>
              <th className="text-center font-medium px-3 py-2">게이트</th>
              <th className="text-center font-medium px-3 py-2">승인</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const g = gate(r)
              const approved = !!r.reprice_approved_at
              return (
                <tr key={r.seller_product_id} className="border-t border-gray-100 hover:bg-gray-50/60 align-top">
                  <td className="px-3 py-2 max-w-[280px]">
                    <div className="truncate font-medium text-gray-800">{r.name}</div>
                    {r.best_match_title && <div className="truncate text-[11px] text-gray-400">시세 최저가: {r.best_match_title}</div>}
                    <div className="text-[10px] text-gray-400">조회 {won(r.view_count)} · 판매 {won(r.sold_count)} · 원가 {won(r.my_cost)}</div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                    <span className="text-gray-400 line-through">{won(r.my_price)}</span>
                    <span className="mx-1 text-sky-600 font-semibold">→ {won(r.reprice_target)}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                    {won(r.market_low)}<span className="text-[10px] text-gray-400"> ({r.match_count ?? 0})</span>
                    <div className="text-[10px] text-gray-400">MSP {won(r.msp_price_krw)}</div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                    <span className={g.drop > 0.45 ? 'text-rose-600 font-semibold' : 'text-gray-700'}>{Math.round(g.drop * 100)}%</span>
                    <div className={`text-[11px] font-semibold ${(r.margin_at_target ?? 0) > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>마진 {won(r.margin_at_target)}</div>
                  </td>
                  <td className="px-3 py-2 text-center">
                    {g.safe
                      ? <span className="inline-block rounded px-2 py-0.5 text-[11px] font-bold bg-emerald-100 text-emerald-700">안전</span>
                      : <span className="inline-block rounded px-2 py-0.5 text-[11px] font-bold bg-amber-100 text-amber-700" title={g.warnings.join(', ')}>검토</span>}
                    {!g.safe && <div className="text-[10px] text-amber-600 mt-0.5 max-w-[130px] mx-auto leading-tight">{g.warnings.join(' · ')}</div>}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <button
                      onClick={() => approve(r.seller_product_id, !approved)}
                      disabled={busy === r.seller_product_id}
                      className={`rounded-lg px-3 py-1 text-xs font-semibold border transition disabled:opacity-40 ${approved ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-gray-300 text-gray-600 hover:border-gray-500'}`}
                    >{approved ? '✓ 승인됨' : '승인'}</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-500 leading-relaxed">
        <b className="text-gray-800">근거</b> — <b>목표가</b>는 시세 최저를 살짝 언더컷하되 <b>MSP 미만 금지</b>. <b>목표마진</b>은 그 가격에서 배송비·수수료·부가세 제한 순익. <b className="text-emerald-700">안전</b>은 게이트(매칭≥5·MSP준수·인하≤45%·마진&gt;0) 전부 통과. 승인 후 집 PC에서 <code className="bg-gray-100 px-1 rounded">node scripts/coupang-pricewatch.mjs --reprice --apply</code> 실행 시 <b>승인+안전</b>한 건만 vendor-item API로 실제 조정됩니다(리스팅 강등 없음). 시세는 확장 검색 매칭이라 방향성 참고치 — <b>검토</b> 표시는 팩 오매칭 등 위험이 있으니 육안 확인 후 승인하세요.
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
