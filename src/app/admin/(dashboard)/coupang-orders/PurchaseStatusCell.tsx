'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// 드롭십(ggsan 직배송) 흐름: 미발주 → 발주완료 → 매입처발송 → 발송완료(쿠팡 등록) → 취소
const STATUS_OPTIONS = [
  { v: 'PENDING', label: '미발주' },
  { v: 'ORDERED', label: '발주완료' },
  { v: 'SHIPPED', label: '매입처발송' },
  { v: 'RECEIVED', label: '발송완료' },
  { v: 'CANCELLED', label: '취소' },
] as const

const STATUS_CLS: Record<string, string> = {
  PENDING: 'bg-rose-100 text-rose-700',
  ORDERED: 'bg-amber-100 text-amber-700',
  SHIPPED: 'bg-sky-100 text-sky-700',
  RECEIVED: 'bg-emerald-100 text-emerald-700',
  CANCELLED: 'bg-zinc-200 text-zinc-600',
}

interface Props {
  id: string
  status: string
  orderedAt: string | null
  ggsanOrderNo?: string | null
}

function fmtDate(s: string | null) {
  return s ? s.slice(0, 16).replace('T', ' ') : null
}

export function PurchaseStatusCell({ id, status, orderedAt, ggsanOrderNo }: Props) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [orderNo, setOrderNo] = useState(ggsanOrderNo ?? '')
  const [noSaving, setNoSaving] = useState(false)
  const [noErr, setNoErr] = useState<string | null>(null)
  const [noOk, setNoOk] = useState(false)

  // ggsan 주문번호 입력란은 발주완료/매입처발송 단계에서만 노출(추적 린치핀)
  const showOrderNo = status === 'ORDERED' || status === 'SHIPPED'

  async function change(next: string) {
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/admin/coupang-orders/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, purchase_status: next }),
      })
      const j = await res.json()
      setSaving(false)
      if (!res.ok) { setErr(j.error || '실패'); return }
      router.refresh()
    } catch { setSaving(false); setErr('네트워크 오류') }
  }

  async function saveOrderNo() {
    const next = orderNo.replace(/\s/g, '')
    if (next === (ggsanOrderNo ?? '')) return // 변경 없음
    setNoSaving(true); setNoErr(null); setNoOk(false)
    try {
      const res = await fetch('/api/admin/coupang-orders/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ggsan_order_no: next }),
      })
      const j = await res.json()
      setNoSaving(false)
      if (!res.ok) { setNoErr(j.error || '실패'); return }
      setNoOk(true)
      router.refresh()
    } catch { setNoSaving(false); setNoErr('네트워크 오류') }
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <select
        value={status}
        disabled={saving}
        onChange={(e) => change(e.target.value)}
        className={`text-xs rounded px-1.5 py-0.5 border-0 cursor-pointer font-medium ${STATUS_CLS[status] ?? 'bg-gray-100'}`}
      >
        {STATUS_OPTIONS.map((o) => (
          <option key={o.v} value={o.v}>{o.label}</option>
        ))}
      </select>
      {orderedAt && <div className="text-[10px] text-gray-400">{fmtDate(orderedAt)}</div>}
      {err && <span className="text-[10px] text-rose-600">{err}</span>}

      {showOrderNo && (
        <div className="flex flex-col items-center gap-0.5 mt-0.5">
          <input
            type="text" inputMode="numeric"
            value={orderNo} disabled={noSaving} placeholder="ggsan 주문번호"
            onChange={(e) => { setOrderNo(e.target.value); setNoOk(false); setNoErr(null) }}
            onBlur={saveOrderNo}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            className="w-[120px] px-1 py-0.5 text-[11px] border border-gray-300 rounded tabular-nums text-center focus:border-blue-400"
          />
          {noErr ? (
            <span className="text-[10px] text-rose-600">{noErr}</span>
          ) : noOk ? (
            <span className="text-[10px] text-emerald-600">✓ 저장됨</span>
          ) : (
            <span className="text-[10px] text-gray-400">입력 시 자동 추적</span>
          )}
        </div>
      )}
    </div>
  )
}
