'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// 마진 공식 — src/lib/coupang/price.ts 와 동일하게 유지 (client는 node:crypto 의존 때문에 import 불가)
const FEE_RATE = 0.13   // 쿠팡 카테고리 수수료 + 결제 수수료 근사
const VAT_DIVISOR = 11  // 부가세 = 판매가 / 11

interface Props {
  id: string
  unitCost: number | null
  shippingCost: number | null
  shippingCount: number | null
  /** 이 주문 라인의 실제 매출(고객 결제액) — 실수익 계산용 */
  orderPrice: number | null
}

/**
 * 매입 원가 인라인 입력(상품가+운송비) + 실수익 실시간 계산.
 * 실수익 = 주문금액 − 매입원가(상품가×수량+운송비) − 쿠팡수수료 − 부가세
 */
export function PurchaseCostCell({ id, unitCost, shippingCost, shippingCount, orderPrice }: Props) {
  const router = useRouter()
  const qty = shippingCount ?? 1
  const [unit, setUnit] = useState(unitCost == null ? '' : String(unitCost))
  const [ship, setShip] = useState(shippingCost == null ? '' : String(shippingCost))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const unitNum = unit === '' ? 0 : Math.round(Number(unit))
  const shipNum = ship === '' ? 0 : Math.round(Number(ship))
  const cost = unitNum * qty + shipNum

  const revenue = orderPrice ?? 0
  const fee = Math.round(revenue * FEE_RATE)
  const vat = Math.round(revenue / VAT_DIVISOR)
  const net = revenue - cost - fee - vat
  const netPct = revenue > 0 ? (net / revenue) * 100 : 0
  const hasCost = unitNum > 0 // 매입가 입력됨

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

      {/* 매입 소요 + 실수익 */}
      <div className="mt-1 w-full border-t border-gray-100 pt-1 space-y-0.5 text-right">
        <div className="text-[10px] text-gray-500">
          매입 소요 <strong className="tabular-nums text-gray-700">{cost.toLocaleString()}</strong>{qty > 1 ? ` (×${qty})` : ''}
        </div>
        {hasCost ? (
          <>
            <div className="text-[10px] text-gray-400 tabular-nums">
              주문 {revenue.toLocaleString()} − 수수료 {fee.toLocaleString()} − 부가세 {vat.toLocaleString()}
            </div>
            <div className={`text-[11px] font-semibold tabular-nums ${net >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
              실수익 {net.toLocaleString()}원 ({netPct.toFixed(1)}%)
            </div>
          </>
        ) : (
          <div className="text-[10px] text-gray-300">매입가 입력 시 실수익 계산</div>
        )}
      </div>
      {err && <span className="text-[10px] text-rose-600">{err}</span>}
    </div>
  )
}
