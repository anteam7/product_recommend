'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

const STATUS_OPTIONS = [
  { v: 'PENDING', label: '미발주' },
  { v: 'ORDERED', label: '매입 발주' },
  { v: 'RECEIVED', label: '매입 입고' },
  { v: 'CANCELLED', label: '취소' },
] as const

const STATUS_CLS: Record<string, string> = {
  PENDING: 'bg-rose-100 text-rose-700',
  ORDERED: 'bg-amber-100 text-amber-700',
  RECEIVED: 'bg-emerald-100 text-emerald-700',
  CANCELLED: 'bg-zinc-200 text-zinc-600',
}

interface Props {
  id: string
  status: string
  unitCost: number | null
  shippingCount: number | null
  orderedAt: string | null
}

function fmtDate(s: string | null) {
  return s ? s.slice(0, 16).replace('T', ' ') : null
}

export function PurchaseStatusCell({ id, status, unitCost, shippingCount, orderedAt }: Props) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [editingCost, setEditingCost] = useState(false)
  const [costVal, setCostVal] = useState(String(unitCost ?? ''))

  async function post(payload: Record<string, unknown>) {
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/admin/coupang-orders/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...payload }),
      })
      const j = await res.json()
      setSaving(false)
      if (!res.ok) { setErr(j.error || '실패'); return false }
      setEditingCost(false)
      router.refresh()
      return true
    } catch {
      setSaving(false); setErr('네트워크 오류'); return false
    }
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <select
        value={status}
        disabled={saving}
        onChange={(e) => post({ purchase_status: e.target.value })}
        className={`text-xs rounded px-1.5 py-0.5 border-0 cursor-pointer font-medium ${STATUS_CLS[status] ?? 'bg-gray-100'}`}
      >
        {STATUS_OPTIONS.map((o) => (
          <option key={o.v} value={o.v}>{o.label}</option>
        ))}
      </select>

      {orderedAt && <div className="text-[10px] text-gray-400">{fmtDate(orderedAt)}</div>}

      {/* 매입 단가 인라인 편집 */}
      {editingCost ? (
        <div className="flex items-center gap-1">
          <input
            type="number"
            step={100}
            value={costVal}
            autoFocus
            disabled={saving}
            onChange={(e) => setCostVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') post({ purchase_unit_cost: Math.round(Number(costVal)) })
              if (e.key === 'Escape') setEditingCost(false)
            }}
            placeholder="매입단가"
            className="w-20 px-1 py-0.5 text-[11px] text-right border border-blue-400 rounded tabular-nums"
          />
          <button type="button" disabled={saving} onClick={() => post({ purchase_unit_cost: Math.round(Number(costVal)) })}
            className="text-[10px] px-1 py-0.5 bg-blue-600 text-white rounded disabled:opacity-50">{saving ? '…' : '저장'}</button>
        </div>
      ) : (
        <button type="button" onClick={() => { setCostVal(String(unitCost ?? '')); setEditingCost(true); setErr(null) }}
          className="text-[10px] text-gray-500 hover:text-blue-600 hover:underline decoration-dotted">
          {unitCost != null
            ? `단가 ${unitCost.toLocaleString()}${shippingCount && shippingCount > 1 ? ` ×${shippingCount}` : ''} ✎`
            : '＋매입단가'}
        </button>
      )}
      {err && <span className="text-[10px] text-rose-600">{err}</span>}
    </div>
  )
}
