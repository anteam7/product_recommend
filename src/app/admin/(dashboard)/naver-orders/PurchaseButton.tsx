'use client'

import { useState } from 'react'

const HELPER = 'http://127.0.0.1:39201'

/**
 * 결제진행 버튼 — 쿠팡 주문매입의 PurchaseButton 미러(네이버는 id가 string).
 * order-server 가 id 로 쿠팡/네이버 주문을 자동 판별한다 (쿠팡 order_id → 네이버 product_order_id 순).
 * 서버가 꺼져 있으면 jimorder:// 프로토콜로 자동 기동 (id가 숫자 문자열이라 vbs 숫자 가드 통과).
 */
export default function PurchaseButton({ orderId }: { orderId: string }) {
  const [busy, setBusy] = useState(false)

  const onClick = async () => {
    if (busy) return
    setBusy(true)
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 1500)
      await fetch(`${HELPER}/health`, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
      clearTimeout(t)
      window.open(`${HELPER}/order?id=${orderId}`, '_blank', 'noopener,noreferrer')
    } catch {
      window.location.href = `jimorder://order/${orderId}`
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-600 text-white text-[11px] font-semibold hover:bg-blue-700 disabled:opacity-60"
      title="로컬 헬퍼로 매입처(건강산/유픽B2B) 주문서 자동작성 → 결제 직전 정지(결제는 직접). 헬퍼가 꺼져 있으면 자동 기동."
    >
      💳 결제진행{busy ? '…' : ''}
    </button>
  )
}
