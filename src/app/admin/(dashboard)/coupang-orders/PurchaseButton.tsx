'use client'

import { useState } from 'react'

const HELPER = 'http://127.0.0.1:39201'

/**
 * 결제진행 버튼 — 로컬 자동주문 헬퍼(order-server, 127.0.0.1:39201) 연동.
 * 1) /health 프로브로 서버 생존 확인 → 살아 있으면 주문 확인 페이지 새 탭
 * 2) 죽어 있으면 jimorder:// 커스텀 프로토콜로 폴백 — order-launch.vbs 가
 *    서버를 띄우고(이미 떠 있으면 스킵) 같은 페이지를 연다.
 *    (프로토콜 등록: scripts/order-launch.vbs 헤더 참고 — 이 PC에서만 작동)
 */
export default function PurchaseButton({ orderId }: { orderId: number }) {
  const [busy, setBusy] = useState(false)

  const onClick = async () => {
    if (busy) return
    setBusy(true)
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 1500)
      // no-cors: 응답 내용은 못 읽지만 연결 성공/실패만 판별하면 충분
      await fetch(`${HELPER}/health`, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
      clearTimeout(t)
      window.open(`${HELPER}/order?id=${orderId}`, '_blank', 'noopener,noreferrer')
    } catch {
      // 서버 다운(또는 프로브 차단) → 프로토콜 핸들러가 서버 기동 + 페이지 오픈
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
      title="로컬 헬퍼로 ggsan 주문서 자동작성 → 결제 직전 정지(결제는 직접). 헬퍼가 꺼져 있으면 자동 기동."
    >
      💳 결제진행{busy ? '…' : ''}
    </button>
  )
}
