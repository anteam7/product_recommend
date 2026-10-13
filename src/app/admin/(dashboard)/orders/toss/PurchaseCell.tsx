'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// 드롭십 흐름(쿠팡·네이버와 동일): 미발주 → 입금대기(결제완주·무통장) → 발주완료(입금완료) → 매입처발송 → 발송완료 → 취소
// 토스 발주확인(PREPARING_PRODUCT)·송장 등록은 로컬 크론이 자동 처리 — 이 셀은 매입 추적 기록만.
const STATUS_OPTIONS = [
  { v: 'PENDING', label: '미발주' },
  { v: 'AWAITING_DEPOSIT', label: '💰 입금대기' },
  { v: 'ORDERED', label: '발주완료' },
  { v: 'SHIPPED', label: '매입처발송' },
  { v: 'RECEIVED', label: '발송완료' },
  { v: 'CANCELLED', label: '취소' },
] as const

const STATUS_CLS: Record<string, string> = {
  PENDING: 'bg-rose-100 text-rose-700',
  AWAITING_DEPOSIT: 'bg-orange-100 text-orange-700',
  ORDERED: 'bg-amber-100 text-amber-700',
  SHIPPED: 'bg-sky-100 text-sky-700',
  RECEIVED: 'bg-emerald-100 text-emerald-700',
  CANCELLED: 'bg-zinc-200 text-zinc-600',
}

interface Props {
  id: string
  status: string
  orderedAt: string | null
  ggsanOrderNo: string | null
  needsAttention: boolean
  attentionReason: string | null
}

function fmtDate(s: string | null) {
  return s ? s.slice(0, 16).replace('T', ' ') : null
}

export function PurchaseCell({ id, status, orderedAt, ggsanOrderNo, needsAttention, attentionReason }: Props) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [orderNo, setOrderNo] = useState(ggsanOrderNo ?? '')
  const [noOk, setNoOk] = useState(false)

  async function post(payload: Record<string, unknown>) {
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/admin/toss-orders/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...payload }),
      })
      const j = await res.json()
      setSaving(false)
      if (!res.ok) { setErr(j.error || '실패'); return false }
      router.refresh()
      return true
    } catch { setSaving(false); setErr('네트워크 오류'); return false }
  }

  const showOrderNo = status === 'AWAITING_DEPOSIT' || status === 'ORDERED' || status === 'SHIPPED'

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
      {status === 'AWAITING_DEPOSIT' && (
        <button
          type="button"
          disabled={saving}
          onClick={() => post({ purchase_status: 'ORDERED' })}
          className="px-2 py-0.5 rounded bg-emerald-600 text-white text-[11px] font-semibold hover:bg-emerald-700 disabled:opacity-60"
          title="매입처 계좌로 이체를 마쳤으면 눌러주세요 — 발주완료로 전환되며, 이후 매시간 크론이 ggsan 송장을 감지해 토스에 자동 등록합니다"
        >
          ✓ 입금완료
        </button>
      )}
      {orderedAt && <div className="text-[10px] text-gray-400">{fmtDate(orderedAt)}</div>}
      {err && <span className="text-[10px] text-rose-600">{err}</span>}

      {showOrderNo && (
        <div className="flex flex-col items-center gap-0.5 mt-0.5">
          <input
            type="text"
            value={orderNo} disabled={saving} placeholder="매입처 주문번호"
            onChange={(e) => { setOrderNo(e.target.value); setNoOk(false) }}
            onBlur={async () => {
              const next = orderNo.replace(/\s/g, '')
              if (next === (ggsanOrderNo ?? '')) return
              if (await post({ ggsan_order_no: next })) setNoOk(true)
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            className="w-[120px] px-1 py-0.5 text-[11px] border border-gray-300 rounded tabular-nums text-center focus:border-blue-400"
          />
          <span className={`text-[10px] ${noOk ? 'text-emerald-600' : 'text-gray-400'}`}>{noOk ? '✓ 저장됨' : '발주 후 번호 기록 → 크론이 송장 자동등록'}</span>
        </div>
      )}

      {needsAttention && (
        <button
          type="button"
          disabled={saving}
          onClick={() => post({ clear_attention: true })}
          className="px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 text-[10px] hover:bg-rose-200"
          title={`${attentionReason ?? '확인 필요'} — 처리했으면 눌러 해제`}
        >
          ⚠ {attentionReason ?? '확인 필요'} ✕
        </button>
      )}
    </div>
  )
}
