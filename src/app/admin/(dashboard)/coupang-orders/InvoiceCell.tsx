'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { runCoupangJob } from '@/lib/coupang-job-client'

// 쿠팡 송장등록 가능 택배사(register-invoice 라우트 CARRIER_MAP 과 동일 집합 — 쿠팡 공식 코드표 기준).
// '기타'는 쿠팡 자동등록 불가 → 내부 기록만, Wing 에서 직접 등록.
const CARRIERS = ['CJ대한통운', '한진택배', '롯데택배', '우체국택배', '로젠택배', '경동택배', '대신택배', '기타(쿠팡 수동등록)']

interface Props {
  id: string
  /** 쿠팡 주문번호(order_id) — 집 PC 큐 잡 키 */
  orderId?: string
  invoiceNumber: string | null
  deliveryCompany: string | null
  shippedAt: string | null
  coupangInvoiceStatus?: string | null
}

function fmtDate(s: string | null) {
  return s ? s.slice(0, 16).replace('T', ' ') : null
}

const INV_DONE = new Set(['uploaded', 'duplicate', 'manual_done'])

/**
 * 송장(택배사+송장번호) 입력 + 발송처리.
 * [발송] = ① 내부 기록(update: SHIPPED+pending) → ② 집 PC 큐에 coupang_invoice 잡 등록 → order-server 가
 *          쿠팡 발주확인+송장등록(→배송지시) 실행 → 성공 시 '발송완료'(RECEIVED). 결과는 여기서 폴링해 표시.
 * (Vercel 은 쿠팡 IP 접근제어 밖이라 직접 호출하지 않는다 — 2026-08-20)
 */
export function InvoiceCell({ id, orderId, invoiceNumber, deliveryCompany, shippedAt, coupangInvoiceStatus }: Props) {
  const router = useRouter()
  const [company, setCompany] = useState(deliveryCompany ?? '')
  const [invoice, setInvoice] = useState(invoiceNumber ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [regMsg, setRegMsg] = useState<string | null>(null)

  const dirty = company !== (deliveryCompany ?? '') || invoice.trim() !== (invoiceNumber ?? '')
  const invDone = INV_DONE.has(coupangInvoiceStatus ?? 'none')

  async function registerOnCoupang(): Promise<string> {
    if (!orderId) return '⚠ 주문번호 없음 — 쿠팡 등록 불가'
    return runCoupangJob(orderId, 'coupang_invoice', { doing: '쿠팡 송장등록', done: '쿠팡 송장등록 완료 → 배송지시' }, setRegMsg)
  }

  async function save() {
    if (!invoice.trim()) { setErr('송장번호 입력'); return }
    if (!company) { setErr('택배사 선택'); return }
    setSaving(true); setErr(null); setRegMsg(null)
    try {
      // ① 내부 기록 (SHIPPED + pending)
      const res = await fetch('/api/admin/coupang-orders/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, delivery_company: company || null, invoice_number: invoice.trim() }),
      })
      const j = await res.json()
      if (!res.ok) { setSaving(false); setErr(j.error || '실패'); return }
      // ②③ 쿠팡 등록 (이미 등록 완료 건은 재호출 안 함 — 기록만 갱신)
      if (!invDone) {
        setRegMsg('쿠팡 송장등록 요청 중…')
        const msg = await registerOnCoupang()
        setRegMsg(msg)
      }
      setSaving(false)
      router.refresh()
    } catch { setSaving(false); setErr('네트워크 오류') }
  }

  return (
    <div className="flex flex-col gap-1 text-xs min-w-[150px]">
      <select
        value={company}
        disabled={saving}
        onChange={(e) => setCompany(e.target.value)}
        className="px-1 py-0.5 text-xs border border-gray-300 rounded"
      >
        <option value="">택배사 선택</option>
        {CARRIERS.map((c) => <option key={c} value={c}>{c}</option>)}
        {company && !CARRIERS.includes(company) && <option value={company}>{company}</option>}
      </select>
      <div className="flex items-center gap-1">
        <input
          type="text" inputMode="numeric"
          value={invoice} disabled={saving} placeholder="송장번호"
          onChange={(e) => setInvoice(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save() }}
          className="flex-1 w-0 px-1 py-0.5 border border-gray-300 rounded tabular-nums focus:border-blue-400"
        />
        <button
          type="button" onClick={save} disabled={saving || !dirty}
          title="내부 기록 후 집 PC가 쿠팡에 송장을 등록(발주확인+배송지시)합니다"
          className="text-[10px] px-1.5 py-0.5 bg-blue-600 text-white rounded disabled:opacity-40"
        >
          {saving ? '…' : '발송'}
        </button>
      </div>
      {shippedAt && <div className="text-[10px] text-emerald-600">✓ 발송 {fmtDate(shippedAt)}</div>}
      {err && <span className="text-[10px] text-rose-600">{err}</span>}
      {regMsg && (
        <span className={`text-[10px] ${regMsg.startsWith('✓') ? 'text-emerald-600' : regMsg.startsWith('⚠') ? 'text-rose-600' : regMsg.startsWith('⏳') ? 'text-amber-600' : 'text-gray-500'}`}>
          {regMsg}
        </span>
      )}
    </div>
  )
}
