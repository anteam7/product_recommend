'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { SOURCE_META } from './sources'

export interface CatalogRow {
  source: string
  goods_no: string
  title: string | null
  brand: string | null
  thumb_url: string | null
  detail_url: string | null
  supply_price: number | null
  list_price: number | null
  ship_fee: number | null
  ship_basis: string | null
  msp: number | null
  status: string | null
  is_active: boolean
  supports_coupang: boolean
  coupang_target: boolean
  note: string | null
  real_cost: number | null
  breakeven_price: number | null
  fee_rate: number | null
  fee_category: string | null
  msp_fee: number | null
  msp_vat: number | null
  msp_margin: number | null
  msp_margin_pct: number | null
  msp_suspicious: boolean
  seller_product_id: number | null
  listing_status: string | null
  listed_price: number | null
  is_registered: boolean
}

const won = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString())
const keyOf = (r: CatalogRow) => `${r.source}:${r.goods_no}`
/** 체크 가능 = 쿠팡 등록기가 있는 매입처 · 아직 미등록 · 공급처 기준 등록 가능 상태 */
const selectable = (r: CatalogRow) => r.supports_coupang && !r.is_registered && r.coupang_target

export function CatalogTable({ rows }: { rows: CatalogRow[] }) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const pickable = useMemo(() => rows.filter(selectable), [rows])
  const allPicked = pickable.length > 0 && pickable.every((r) => selected.has(keyOf(r)))
  const picked = useMemo(() => rows.filter((r) => selected.has(keyOf(r))), [rows, selected])
  const marginSum = picked.reduce((s, r) => s + (r.msp_margin ?? 0), 0)

  function toggle(r: CatalogRow) {
    setSelected((prev) => {
      const next = new Set(prev)
      const k = keyOf(r)
      if (next.has(k)) next.delete(k); else next.add(k)
      return next
    })
  }
  function toggleAll() {
    setSelected((prev) => {
      if (allPicked) {
        const next = new Set(prev)
        for (const r of pickable) next.delete(keyOf(r))
        return next
      }
      return new Set([...prev, ...pickable.map(keyOf)])
    })
  }

  async function submit() {
    if (!picked.length || busy) return
    if (!window.confirm(`${picked.length}건을 쿠팡 등록 큐에 넣습니다.\n실제 등록은 집 PC의 register-agent 가 실행합니다. 계속할까요?`)) return
    setBusy(true); setMsg(null)
    try {
      const res = await fetch('/api/admin/register-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: picked.map((r) => ({ source: r.source, goods_no: r.goods_no })) }),
      })
      const j = await res.json()
      if (!res.ok) { setMsg(`실패: ${j.error ?? res.status}`); return }
      const rejected = (j.rejected ?? []) as { goods_no: string; reason: string }[]
      setMsg(`큐 등록 ${j.queued}건${rejected.length ? ` · 제외 ${rejected.length}건 (${rejected.slice(0, 3).map((x) => `${x.goods_no}: ${x.reason}`).join(', ')}${rejected.length > 3 ? '…' : ''})` : ''}`)
      setSelected(new Set())
      if (j.ids?.length) void poll(j.ids as string[])
      router.refresh()
    } catch (e) {
      setMsg(`실패: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  /** 집 PC 러너가 처리할 때까지 상태를 따라간다(최대 5분). 러너가 꺼져 있으면 QUEUED 로 남는다. */
  async function poll(ids: string[]) {
    for (let i = 0; i < 100; i++) {
      await new Promise((s) => setTimeout(s, 3000))
      try {
        const res = await fetch(`/api/admin/register-jobs?ids=${ids.join(',')}`)
        const j = await res.json()
        if (!res.ok) return
        const c = j.counts ?? {}
        setMsg(`등록 진행 — 대기 ${c.QUEUED ?? 0} · 실행 ${c.RUNNING ?? 0} · 완료 ${c.DONE ?? 0} · 실패 ${c.FAILED ?? 0}`)
        if (!j.active) { router.refresh(); return }
      } catch { return }
    }
  }

  return (
    <div className="relative">
      <div className="overflow-x-auto rounded border">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-600">
            <tr>
              <th className="p-2 w-8">
                <input type="checkbox" checked={allPicked} onChange={toggleAll} disabled={!pickable.length} title="이 페이지의 등록 가능한 상품 전체 선택" />
              </th>
              <th className="p-2 text-left">상품</th>
              <th className="p-2 text-right">공급가</th>
              <th className="p-2 text-right">배송비</th>
              <th className="p-2 text-right">원가</th>
              <th className="p-2 text-right">MSP</th>
              <th className="p-2 text-right">수수료</th>
              <th className="p-2 text-right">MSP 마진</th>
              <th className="p-2 text-right">손익분기</th>
              <th className="p-2 text-center">쿠팡</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.length === 0 && (
              <tr><td colSpan={10} className="p-6 text-center text-gray-400">조건에 맞는 상품이 없습니다.</td></tr>
            )}
            {rows.map((r) => {
              const meta = SOURCE_META[r.source]
              const url = r.detail_url ?? meta?.url(r.goods_no) ?? null
              const can = selectable(r)
              const neg = (r.msp_margin ?? 0) < 0
              return (
                <tr key={keyOf(r)} className={selected.has(keyOf(r)) ? 'bg-blue-50' : undefined}>
                  <td className="p-2 align-top">
                    <input type="checkbox" checked={selected.has(keyOf(r))} disabled={!can} onChange={() => toggle(r)}
                      title={can ? '' : r.is_registered ? '이미 등록됨' : !r.supports_coupang ? '쿠팡 등록기 없는 매입처' : '등록 대상 아님(MSP 없음·품절 등)'} />
                  </td>
                  <td className="p-2">
                    <div className="flex gap-2">
                      {r.thumb_url
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={r.thumb_url} alt="" className="w-10 h-10 rounded object-cover border" />
                        : <div className="w-10 h-10 rounded border bg-gray-50" />}
                      <div className="min-w-0">
                        <div className="flex items-center gap-1 flex-wrap">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] ${meta?.cls ?? 'bg-gray-100 text-gray-600'}`}>{meta?.label ?? r.source}</span>
                          {url
                            ? <a href={url} target="_blank" rel="noreferrer" className="font-medium hover:underline">{r.title ?? '(제목 없음)'}</a>
                            : <span className="font-medium">{r.title ?? '(제목 없음)'}</span>}
                        </div>
                        <div className="text-[11px] text-gray-400 mt-0.5">
                          {r.goods_no}
                          {r.brand && <> · {r.brand}</>}
                          {!r.is_active && <span className="ml-1 text-rose-500">· {r.status}</span>}
                          {r.note && <span className="ml-1 text-amber-600">· {r.note}</span>}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="p-2 text-right tabular-nums">{won(r.supply_price)}</td>
                  <td className="p-2 text-right tabular-nums text-gray-500" title={r.ship_basis ?? ''}>{won(r.ship_fee)}</td>
                  <td className="p-2 text-right tabular-nums text-gray-500">{won(r.real_cost)}</td>
                  <td className="p-2 text-right tabular-nums">
                    {won(r.msp)}
                    {r.msp_suspicious && <span className="ml-1 text-amber-600" title="MSP가 공급가보다 낮습니다 — 수집 파싱 오류 의심">⚠</span>}
                  </td>
                  <td className="p-2 text-right tabular-nums text-gray-500 text-[11px]" title={`수수료 카테고리: ${r.fee_category ?? '미확인'}`}>
                    {r.fee_rate != null ? `${(r.fee_rate * 100).toFixed(1)}%` : '—'}
                  </td>
                  <td className={`p-2 text-right tabular-nums ${neg ? 'text-rose-600' : 'text-emerald-700'}`}>
                    {won(r.msp_margin)}
                    {r.msp_margin_pct != null && <span className="ml-1 text-[11px] text-gray-400">{r.msp_margin_pct}%</span>}
                  </td>
                  <td className="p-2 text-right tabular-nums text-gray-500">{won(r.breakeven_price)}</td>
                  <td className="p-2 text-center whitespace-nowrap">
                    {r.is_registered
                      ? <span className={`px-1.5 py-0.5 rounded text-[10px] ${r.listing_status === 'SKIPPED' || r.listing_status === 'FAILED' ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'}`}>
                          {r.listing_status}{r.listed_price ? ` · ${won(r.listed_price)}` : ''}
                        </span>
                      : <span className="px-1.5 py-0.5 rounded text-[10px] bg-gray-100 text-gray-500">미등록</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {(picked.length > 0 || msg) && (
        <div className="sticky bottom-0 mt-2 flex flex-wrap items-center gap-3 rounded border bg-white/95 p-3 shadow-lg">
          <span className="text-sm font-medium">{picked.length}건 선택</span>
          {picked.length > 0 && (
            <span className="text-xs text-gray-500">
              MSP 기준 마진 합계 {marginSum.toLocaleString()}원
              {picked.some((r) => (r.msp_margin ?? 0) < 0) && <span className="ml-1 text-rose-600">· 적자 상품 포함(등록가는 손익분기 이상으로 올라갑니다)</span>}
            </span>
          )}
          <button type="button" onClick={submit} disabled={busy || !picked.length}
            className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white disabled:opacity-40">
            {busy ? '등록 요청 중…' : '쿠팡 일괄등록'}
          </button>
          {picked.length > 0 && (
            <button type="button" onClick={() => setSelected(new Set())} className="text-xs text-gray-500 hover:underline">선택 해제</button>
          )}
          {msg && <span className="text-xs text-gray-600">{msg}</span>}
        </div>
      )}
    </div>
  )
}
