'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// 흔한 국내 택배사 (쿠팡 API 연동 아님 — 이름만 기록)
const CARRIERS = ['CJ대한통운', '한진택배', '롯데택배', '우체국택배', '로젠택배', '경동택배', 'GSPostbox', '대신택배', '기타']

interface Props {
  id: string
  invoiceNumber: string | null
  deliveryCompany: string | null
  shippedAt: string | null
}

function fmtDate(s: string | null) {
  return s ? s.slice(0, 16).replace('T', ' ') : null
}

/**
 * 송장(택배사+송장번호) 입력 + 발송 추적. 쿠팡에 등록하지 않고 내부 기록만.
 * 송장번호 저장 시 서버가 발송시각 + 발주상태 '발송완료'를 자동 처리.
 */
export function InvoiceCell({ id, invoiceNumber, deliveryCompany, shippedAt }: Props) {
  const router = useRouter()
  const [company, setCompany] = useState(deliveryCompany ?? '')
  const [invoice, setInvoice] = useState(invoiceNumber ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const dirty = company !== (deliveryCompany ?? '') || invoice.trim() !== (invoiceNumber ?? '')

  async function save() {
    if (!invoice.trim()) { setErr('송장번호 입력'); return }
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/admin/coupang-orders/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, delivery_company: company || null, invoice_number: invoice.trim() }),
      })
      const j = await res.json()
      setSaving(false)
      if (!res.ok) { setErr(j.error || '실패'); return }
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
          className="text-[10px] px-1.5 py-0.5 bg-blue-600 text-white rounded disabled:opacity-40"
        >
          {saving ? '…' : '발송'}
        </button>
      </div>
      {shippedAt && <div className="text-[10px] text-emerald-600">✓ 발송 {fmtDate(shippedAt)}</div>}
      {err && <span className="text-[10px] text-rose-600">{err}</span>}
    </div>
  )
}
