'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// 드롭십 흐름(쿠팡과 동일): 미발주 → 입금대기(결제완주·무통장) → 발주완료(입금완료) → 매입처발송 → 발송완료 → 취소
// 발주완료 선택 시 서버가 네이버 발주확인(confirm)을 자동 호출한다.
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
  /** 네이버 상품주문번호 — 발주확인 로컬 헬퍼 폴백용 */
  productOrderId: string
  status: string
  orderedAt: string | null
  supplierOrderNo?: string | null
}

const HELPER = 'http://127.0.0.1:39201'

function fmtDate(s: string | null) {
  return s ? s.slice(0, 16).replace('T', ' ') : null
}

export function PurchaseStatusCell({ id, productOrderId, status, orderedAt, supplierOrderNo }: Props) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [confirmMsg, setConfirmMsg] = useState<string | null>(null)
  const [orderNo, setOrderNo] = useState(supplierOrderNo ?? '')
  const [noSaving, setNoSaving] = useState(false)
  const [noErr, setNoErr] = useState<string | null>(null)
  const [noOk, setNoOk] = useState(false)

  const showOrderNo = status === 'AWAITING_DEPOSIT' || status === 'ORDERED' || status === 'SHIPPED'

  async function change(next: string) {
    setSaving(true); setErr(null); setConfirmMsg(null)
    try {
      const res = await fetch('/api/admin/naver-orders/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, purchase_status: next }),
      })
      const j = await res.json()
      setSaving(false)
      if (!res.ok) { setErr(j.error || '실패'); return }
      // 발주완료 시 네이버 발주확인 결과 안내
      if (j.confirm) {
        if (j.confirm.done) setConfirmMsg('✓ 네이버 발주확인 완료')
        else if (j.confirm.skipped) setConfirmMsg(`발주확인 생략: ${j.confirm.reason}`)
        else if (/IP_NOT_ALLOWED|허용되지 않은 IP/i.test(j.confirm.reason ?? '')) {
          // Vercel 서버 IP는 네이버 허용목록 밖 → 로컬 헬퍼(집 PC = 허용 IP)로 폴백
          setConfirmMsg('로컬 헬퍼로 발주확인 중…')
          try {
            const hr = await fetch(`${HELPER}/naver-confirm?id=${productOrderId}`, { method: 'POST' })
            const hj = await hr.json()
            setConfirmMsg(hj.ok ? '✓ 네이버 발주확인 완료 (로컬)' : `⚠ 발주확인 실패: ${hj.detail}`)
          } catch {
            setConfirmMsg('⚠ 발주확인 실패: 로컬 헬퍼(127.0.0.1:39201)가 꺼져 있습니다 — 이 PC에서 재시도하세요')
          }
        }
        else setConfirmMsg(`⚠ 발주확인 실패: ${j.confirm.reason}`)
      }
      router.refresh()
    } catch { setSaving(false); setErr('네트워크 오류') }
  }

  async function saveOrderNo() {
    const next = orderNo.replace(/\s/g, '')
    if (next === (supplierOrderNo ?? '')) return
    setNoSaving(true); setNoErr(null); setNoOk(false)
    try {
      const res = await fetch('/api/admin/naver-orders/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, supplier_order_no: next }),
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
      {status === 'AWAITING_DEPOSIT' && (
        <button
          type="button"
          disabled={saving}
          onClick={() => change('ORDERED')}
          className="px-2 py-0.5 rounded bg-emerald-600 text-white text-[11px] font-semibold hover:bg-emerald-700 disabled:opacity-60"
          title="매입처 계좌로 이체를 마쳤으면 눌러주세요 — 발주완료로 전환되며 네이버 발주확인도 자동 호출됩니다"
        >
          ✓ 입금완료
        </button>
      )}
      {orderedAt && <div className="text-[10px] text-gray-400">{fmtDate(orderedAt)}</div>}
      {err && <span className="text-[10px] text-rose-600">{err}</span>}
      {confirmMsg && (
        <span className={`text-[10px] ${confirmMsg.startsWith('✓') ? 'text-emerald-600' : confirmMsg.startsWith('⚠') ? 'text-rose-600' : 'text-gray-500'}`}>
          {confirmMsg}
        </span>
      )}

      {showOrderNo && (
        <div className="flex flex-col items-center gap-0.5 mt-0.5">
          <input
            type="text"
            value={orderNo} disabled={noSaving} placeholder="매입처 주문번호"
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
            <span className="text-[10px] text-gray-400">발주 후 번호 기록</span>
          )}
        </div>
      )}
    </div>
  )
}
