'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// 드롭십(ggsan 직배송) 흐름: 미발주 → 입금대기(결제완주·무통장) → 발주완료(입금완료) → 매입처발송 → 발송완료(쿠팡 등록) → 취소
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
  /** 쿠팡 주문번호(order_id) — 발주확인 로컬 헬퍼 폴백용 */
  orderId?: string
  status: string
  orderedAt: string | null
  ggsanOrderNo?: string | null
}

const HELPER = 'http://127.0.0.1:39201'

function fmtDate(s: string | null) {
  return s ? s.slice(0, 16).replace('T', ' ') : null
}

export function PurchaseStatusCell({ id, orderId, status, orderedAt, ggsanOrderNo }: Props) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ackMsg, setAckMsg] = useState<string | null>(null)
  const [orderNo, setOrderNo] = useState(ggsanOrderNo ?? '')
  const [noSaving, setNoSaving] = useState(false)
  const [noErr, setNoErr] = useState<string | null>(null)
  const [noOk, setNoOk] = useState(false)

  // ggsan 주문번호 입력란은 입금대기/발주완료/매입처발송 단계에서 노출(추적 린치핀 — 결제완주 시 자동 기록됨)
  const showOrderNo = status === 'AWAITING_DEPOSIT' || status === 'ORDERED' || status === 'SHIPPED'

  async function change(next: string) {
    setSaving(true); setErr(null); setAckMsg(null)
    try {
      const res = await fetch('/api/admin/coupang-orders/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, purchase_status: next }),
      })
      const j = await res.json()
      setSaving(false)
      if (!res.ok) { setErr(j.error || '실패'); return }
      // 발주완료(입금완료) 시 쿠팡 발주확인(결제완료→상품준비중) 결과 안내 — 네이버 셀과 동일 패턴
      if (j.ack) {
        if (j.ack.done) setAckMsg('✓ 쿠팡 상품준비중 처리 완료')
        else if (j.ack.skipped) setAckMsg(`발주확인 생략: ${j.ack.reason}`)
        else if (orderId) {
          // Vercel 서버 IP는 쿠팡 OpenAPI IP 접근제어 밖(403) → 로컬 헬퍼(집 PC = 허용 IP)로 폴백.
          // 로컬 ack는 멱등(이미 처리됨 통과)이라 실패 사유와 무관하게 재시도해도 안전.
          setAckMsg('로컬 헬퍼로 발주확인 중…')
          try {
            const hr = await fetch(`${HELPER}/coupang-ack?id=${encodeURIComponent(orderId)}`, { method: 'POST' })
            const hj = await hr.json()
            setAckMsg(hj.ok ? '✓ 쿠팡 상품준비중 처리 완료 (로컬)' : `⚠ 발주확인 실패: 로컬=${hj.detail} / 서버=${j.ack.reason}`)
          } catch {
            setAckMsg(`⚠ 발주확인 실패: 서버=${j.ack.reason} / 로컬 헬퍼(127.0.0.1:39201)도 꺼져 있음 — 이 PC에서 재시도하거나 Wing에서 상품준비중 처리하세요`)
          }
        }
        else setAckMsg(`⚠ 발주확인 실패: ${j.ack.reason}`)
      }
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
      {status === 'AWAITING_DEPOSIT' && (
        <button
          type="button"
          disabled={saving}
          onClick={() => change('ORDERED')}
          className="px-2 py-0.5 rounded bg-emerald-600 text-white text-[11px] font-semibold hover:bg-emerald-700 disabled:opacity-60"
          title="매입처 계좌로 이체를 마쳤으면 눌러주세요 — 발주완료로 전환되며 쿠팡 발주확인(상품준비중)도 자동 처리됩니다"
        >
          ✓ 입금완료
        </button>
      )}
      {orderedAt && <div className="text-[10px] text-gray-400">{fmtDate(orderedAt)}</div>}
      {err && <span className="text-[10px] text-rose-600">{err}</span>}
      {ackMsg && (
        <span className={`text-[10px] ${ackMsg.startsWith('✓') ? 'text-emerald-600' : ackMsg.startsWith('⚠') ? 'text-rose-600' : 'text-gray-500'}`}>
          {ackMsg}
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
            <span className="text-[10px] text-gray-400">입력 시 자동 추적</span>
          )}
        </div>
      )}
    </div>
  )
}
