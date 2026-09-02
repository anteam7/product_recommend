'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

const VAT_DIVISOR = 11 // 부가세 = 결제금액 / 11

interface Props {
  id: string
  unitCost: number | null
  /** 매입 합계(= 상품가×수량 + 운송비). 운송비는 별도 컬럼 없이 여기서 파생 */
  totalCost: number | null
  quantity: number | null
  /** 고객 결제액 — 실수익 계산용 */
  paymentAmount: number | null
  /** 네이버 실제 수수료(주문 API commission 합) — 쿠팡의 요율 추정과 달리 실값 사용 */
  commissionAmount: number | null
}

/**
 * 매입 원가 인라인 입력(상품가+운송비) + 실수익 실시간 계산 (쿠팡 PurchaseCostCell 미러).
 * 실수익 = 결제금액 − 매입원가(상품가×수량+운송비) − 네이버수수료(실값) − 부가세
 */
export function PurchaseCostCell({ id, unitCost, totalCost, quantity, paymentAmount, commissionAmount }: Props) {
  const router = useRouter()
  const qty = quantity ?? 1
  // 상품가를 모르면(unitCost=null) 합계 전체를 운송비로 오인식하므로(2026-09-02 사용자 리포트,
  // coupang-orders/PurchaseCostCell.tsx와 동일 버그) 상품가가 실제로 저장돼 있을 때만 역산한다.
  const initShip = (totalCost == null || unitCost == null) ? '' : String(Math.max(0, totalCost - unitCost * qty))
  const [unit, setUnit] = useState(unitCost == null ? '' : String(unitCost))
  const [ship, setShip] = useState(initShip)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const unitNum = unit === '' ? 0 : Math.round(Number(unit))
  const shipNum = ship === '' ? 0 : Math.round(Number(ship))
  const cost = unitNum * qty + shipNum

  const revenue = paymentAmount ?? 0
  const fee = commissionAmount ?? 0
  const vat = Math.round(revenue / VAT_DIVISOR)
  const net = revenue - cost - fee - vat
  const netPct = revenue > 0 ? (net / revenue) * 100 : 0
  const hasCost = unitNum > 0

  async function save() {
    if (!Number.isFinite(unitNum) || unitNum < 0 || !Number.isFinite(shipNum) || shipNum < 0) { setErr('숫자 오류'); return }
    const newUnit = unitNum
    const newTotal = unitNum * qty + shipNum
    if (newUnit === (unitCost ?? 0) && newTotal === (totalCost ?? 0)) return
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/admin/naver-orders/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, purchase_unit_cost: newUnit, purchase_total_cost: newTotal }),
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
          onBlur={save}
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
          onBlur={save}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          className="w-20 px-1 py-0.5 text-right border border-gray-300 rounded tabular-nums focus:border-blue-400"
        />
      </label>

      <div className="mt-1 w-full border-t border-gray-100 pt-1 space-y-0.5 text-right">
        <div className="text-[10px] text-gray-500">
          매입 소요 <strong className="tabular-nums text-gray-700">{cost.toLocaleString()}</strong>{qty > 1 ? ` (×${qty})` : ''}
        </div>
        {hasCost ? (
          <>
            <div className="text-[10px] text-gray-400 tabular-nums">
              결제 {revenue.toLocaleString()} − 수수료 {fee.toLocaleString()} − 부가세 {vat.toLocaleString()}
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
