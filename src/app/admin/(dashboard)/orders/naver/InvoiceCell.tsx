'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { waitForJob } from '@/lib/coupang-job-client'

// 흔한 국내 택배사 — 네이버 발송처리 코드로 변환된다(scripts/lib/naver-order-ops.mjs carrierToNaverCode)
const CARRIERS = ['CJ대한통운', '한진택배', '롯데택배', '우체국택배', '로젠택배', '경동택배', 'GSPostbox', '대신택배', '기타']

const DISPATCH_LABEL: Record<string, { label: string; cls: string }> = {
  pending: { label: '⏳ 네이버 발송처리 대기', cls: 'text-sky-700' },
  registered: { label: '✓ 네이버 발송처리 완료', cls: 'text-emerald-600' },
  manual_done: { label: '✓ 네이버 발송됨(동기화)', cls: 'text-emerald-600' },
  failed: { label: '⚠ 네이버 발송처리 실패', cls: 'text-rose-600' },
}

interface Props {
  id: string
  trackingNumber: string | null
  deliveryCompany: string | null
  shippedAt: string | null
  dispatchStatus?: string | null
  dispatchError?: string | null
  /** 매입처 주문상세에서 송장을 자동 감지한 경우 */
  supplierInvoice?: string | null
}

function fmtDate(s: string | null) {
  return s ? s.slice(0, 16).replace('T', ' ') : null
}

/**
 * 송장(택배사+송장번호) 입력 + 네이버 발송처리.
 * 저장하면 매입처발송(SHIPPED) + 네이버 발송처리 잡이 집 PC 큐에 등록되고, 성공 시 발송완료(RECEIVED).
 * 매입처(건강산·유픽) 송장은 매시 크론이 자동으로 채우고 발송처리까지 한다 — 직접 입력은 그 외 경우용.
 */
export function InvoiceCell({ id, trackingNumber, deliveryCompany, shippedAt, dispatchStatus, dispatchError, supplierInvoice }: Props) {
  const router = useRouter()
  const [company, setCompany] = useState(deliveryCompany ?? '')
  const [invoice, setInvoice] = useState(trackingNumber ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const dirty = company !== (deliveryCompany ?? '') || invoice.trim() !== (trackingNumber ?? '')
  const ds = dispatchStatus && dispatchStatus !== 'none' ? DISPATCH_LABEL[dispatchStatus] : null

  async function save() {
    if (!invoice.trim()) { setErr('송장번호 입력'); return }
    if (!company) { setErr('택배사 선택'); return }
    setSaving(true); setErr(null); setMsg(null)
    try {
      const res = await fetch('/api/admin/naver-orders/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, delivery_company: company || null, tracking_number: invoice.trim() }),
      })
      const j = await res.json()
      if (!res.ok) { setSaving(false); setErr(j.error || '실패'); return }
      router.refresh()
      if (j.dispatch?.queued && j.dispatch.job_id) {
        setMsg(`집 PC에서 네이버 발송처리 중… (잡 #${j.dispatch.job_id})`)
        const r = await waitForJob(j.dispatch.job_id)
        setMsg(r.status === 'done' ? `✓ ${r.result_msg ?? '네이버 발송처리 완료'}`
          : r.status === 'error' ? `⚠ ${r.result_msg ?? '발송처리 실패'}`
          : `⏳ 발송처리 대기(잡 #${j.dispatch.job_id}) — 헬퍼가 켜지면 처리, 안 되면 매시 크론이 재시도`)
        router.refresh()
      } else if (j.dispatch && !j.dispatch.queued) {
        setMsg(`⚠ 발송처리 요청 실패: ${j.dispatch.reason ?? '원인 미상'} (매시 크론이 재시도)`)
      }
      setSaving(false)
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
          title="저장하면 네이버 발송처리까지 자동으로 진행됩니다(집 PC 헬퍼)"
        >
          {saving ? '…' : '발송'}
        </button>
      </div>
      {supplierInvoice && <div className="text-[10px] text-gray-500">📦 매입처 송장 자동감지</div>}
      {ds && <div className={`text-[10px] ${ds.cls}`}>{ds.label}</div>}
      {dispatchStatus === 'failed' && dispatchError && <div className="text-[10px] text-rose-600 line-clamp-2" title={dispatchError}>{dispatchError}</div>}
      {shippedAt && <div className="text-[10px] text-emerald-600">발송 {fmtDate(shippedAt)}</div>}
      {msg && <span className={`text-[10px] ${msg.startsWith('✓') ? 'text-emerald-600' : msg.startsWith('⚠') ? 'text-rose-600' : 'text-gray-500'}`}>{msg}</span>}
      {err && <span className="text-[10px] text-rose-600">{err}</span>}
    </div>
  )
}
