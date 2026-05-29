'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Props {
  id: string
  unitCost: number | null
  shippingCost: number | null
  shippingCount: number | null
}

/**
 * 매입 원가 인라인 입력 — 상품가 + 운송비를 별도 칸으로, 클릭 없이 바로 입력/수정.
 * blur 또는 Enter 시 변경분만 저장. 합계 = 상품가 × 수량 + 운송비.
 */
export function PurchaseCostCell({ id, unitCost, shippingCost, shippingCount }: Props) {
  const router = useRouter()
  const qty = shippingCount ?? 1
  const [unit, setUnit] = useState(unitCost == null ? '' : String(unitCost))
  const [ship, setShip] = useState(shippingCost == null ? '' : String(shippingCost))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const unitNum = unit === '' ? 0 : Math.round(Number(unit))
  const shipNum = ship === '' ? 0 : Math.round(Number(ship))
  const total = unitNum * qty + shipNum

  async function save(field: 'purchase_unit_cost' | 'purchase_shipping_cost', raw: string, prev: number | null) {
    const num = raw === '' ? 0 : Math.round(Number(raw))
    if (!Number.isFinite(num) || num < 0) { setErr('숫자 오류'); return }
    if (num === (prev ?? 0)) return // 변경 없음 → 저장 생략
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/admin/coupang-orders/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, [field]: num }),
      })
      const j = await res.json()
      setSaving(false)
      if (!res.ok) { setErr(j.error || '실패'); return }
      router.refresh()
    } catch { setSaving(false); setErr('네트워크 오류') }
  }

  return (
    <div className="flex flex-col items-end gap-0.5 text-xs">
      <label className="flex items-center gap-1 justify-end">
        <span className="text-[10px] text-gray-400 w-8 text-right">상품가</span>
        <input
          type="number" step={100} inputMode="numeric"
          value={unit} disabled={saving} placeholder="0"
          onChange={(e) => setUnit(e.target.value)}
          onBlur={() => save('purchase_unit_cost', unit, unitCost)}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          className="w-20 px-1 py-0.5 text-right border border-gray-300 rounded tabular-nums focus:border-blue-400"
        />
      </label>
      <label className="flex items-center gap-1 justify-end">
        <span className="text-[10px] text-gray-400 w-8 text-right">운송비</span>
        <input
          type="number" step={100} inputMode="numeric"
          value={ship} disabled={saving} placeholder="0"
          onChange={(e) => setShip(e.target.value)}
          onBlur={() => save('purchase_shipping_cost', ship, shippingCost)}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          className="w-20 px-1 py-0.5 text-right border border-gray-300 rounded tabular-nums focus:border-blue-400"
        />
      </label>
      <div className="text-[10px] text-gray-500 pt-0.5">
        합계 <strong className="tabular-nums">{total.toLocaleString()}</strong>{qty > 1 ? ` (×${qty})` : ''}
      </div>
      {err && <span className="text-[10px] text-rose-600">{err}</span>}
    </div>
  )
}
