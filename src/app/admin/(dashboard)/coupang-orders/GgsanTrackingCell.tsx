'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * 매입처(ggsan) 추적 셀 — 읽기 + 반자동 [확인·등록] 버튼.
 *
 * 설계 캐논: docs/plan-ggsan-coupang-invoice-sync.md ⑥(관리자 UI).
 * 표시:
 *   - ggsan 발송상태 배지(ggsan_order_status, 송장 발급 시 '발송')
 *   - 매입처 송장(택배사 · 번호)
 *   - coupang_invoice_status 배지 + (pending/acknowledged/failed) 액션 버튼
 *
 * 버튼은 register-invoice 라우트(단일 진실 소스)를 호출한다. InvoiceCell 패턴 참고.
 */

const COUPANG_INVOICE_BADGE: Record<string, { label: string; cls: string }> = {
  none: { label: '–', cls: 'text-gray-400' },
  pending: { label: '🟡 등록대기', cls: 'bg-amber-100 text-amber-700' },
  acknowledged: { label: '🟡 등록대기', cls: 'bg-amber-100 text-amber-700' },
  uploaded: { label: '✓ 쿠팡등록', cls: 'bg-emerald-100 text-emerald-700' },
  duplicate: { label: '⚪ 중복', cls: 'bg-zinc-100 text-zinc-600' },
  manual_done: { label: '수동완료', cls: 'bg-gray-100 text-gray-500' },
  failed: { label: '🔴 실패', cls: 'bg-rose-100 text-rose-700' },
}

interface Props {
  id: string
  ggsanOrderNo: string | null
  ggsanOrderStatus: string | null
  ggsanInvoiceNumber: string | null
  ggsanCarrierName: string | null
  ggsanShippedAt: string | null
  coupangInvoiceStatus: string | null
  needsAttention: boolean | null
  attentionReason: string | null
}

function fmtDate(s: string | null) {
  return s ? s.slice(0, 16).replace('T', ' ') : null
}

export function GgsanTrackingCell({
  id,
  ggsanOrderNo,
  ggsanOrderStatus,
  ggsanInvoiceNumber,
  ggsanCarrierName,
  ggsanShippedAt,
  coupangInvoiceStatus,
  needsAttention,
  attentionReason,
}: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [msgErr, setMsgErr] = useState(false)

  const invStatus = coupangInvoiceStatus ?? 'none'
  const badge = COUPANG_INVOICE_BADGE[invStatus] ?? COUPANG_INVOICE_BADGE.none
  // [확인·등록]: 아직 등록 안 된 대기 상태 / [재시도]: 실패
  const canRegister = invStatus === 'pending' || invStatus === 'acknowledged'
  const canRetry = invStatus === 'failed'

  // 발송 신호: 송장이 있거나 coupang_invoice_status 가 none 이상으로 진행됐으면 발송됨
  const shipped = Boolean(ggsanInvoiceNumber) || invStatus !== 'none'

  async function register() {
    setBusy(true)
    setMsg(null)
    setMsgErr(false)
    try {
      const res = await fetch('/api/admin/coupang-orders/register-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
        credentials: 'same-origin',
      })
      const j = await res.json().catch(() => ({}))
      setBusy(false)
      if (!res.ok) {
        setMsgErr(true)
        setMsg(j.error || `실패(HTTP ${res.status})`)
        return
      }
      if (j.ok && (j.coupang_invoice_status === 'uploaded' || j.coupang_invoice_status === 'duplicate')) {
        setMsgErr(false)
        setMsg(j.coupang_invoice_status === 'duplicate' ? '중복(기등록) — 확인 필요' : '등록 완료')
      } else if (j.aborted) {
        setMsgErr(true)
        setMsg(j.reason || '중단')
      } else if (j.deferred) {
        setMsgErr(true)
        setMsg(j.reason || '보류')
      } else if (!j.ok) {
        setMsgErr(true)
        setMsg(j.reason || j.message || '등록 실패')
      } else {
        setMsgErr(false)
        setMsg(j.message || '처리됨')
      }
      router.refresh()
    } catch {
      setBusy(false)
      setMsgErr(true)
      setMsg('네트워크 오류')
    }
  }

  return (
    <div className="flex flex-col gap-1 text-xs min-w-[150px]">
      {/* ggsan 발송상태 */}
      <div className="flex items-center gap-1 flex-wrap">
        {shipped ? (
          <span className="inline-block px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 font-medium">발송</span>
        ) : (
          <span className="inline-block px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">미발송</span>
        )}
        {ggsanOrderStatus && <span className="text-[10px] text-gray-500">{ggsanOrderStatus}</span>}
      </div>

      {/* 매입처 송장 (택배사 · 번호) */}
      {ggsanInvoiceNumber ? (
        <div className="text-[11px] text-gray-700 tabular-nums leading-tight">
          {ggsanCarrierName && <span className="text-gray-500">{ggsanCarrierName} </span>}
          <span className="font-medium">{ggsanInvoiceNumber}</span>
          {ggsanShippedAt && <div className="text-[10px] text-gray-400">{fmtDate(ggsanShippedAt)}</div>}
        </div>
      ) : (
        ggsanOrderNo && <div className="text-[10px] text-gray-400">송장 대기</div>
      )}

      {/* 쿠팡 등록 상태 배지 + 액션 */}
      <div className="flex items-center gap-1 flex-wrap">
        <span className={`inline-block px-1.5 py-0.5 rounded ${badge.cls}`}>{badge.label}</span>
        {(canRegister || canRetry) && (
          <button
            type="button"
            onClick={register}
            disabled={busy}
            className="text-[10px] px-1.5 py-0.5 bg-blue-600 text-white rounded disabled:opacity-40 hover:bg-blue-700"
          >
            {busy ? '…' : canRetry ? '재시도' : '확인·등록'}
          </button>
        )}
      </div>

      {/* needs_attention 사유 */}
      {needsAttention && (
        <div className="text-[10px] text-rose-600">⚠ {attentionReason || '확인 필요'}</div>
      )}

      {/* 버튼 결과 메시지 */}
      {msg && <span className={`text-[10px] ${msgErr ? 'text-rose-600' : 'text-emerald-600'}`}>{msg}</span>}
    </div>
  )
}
