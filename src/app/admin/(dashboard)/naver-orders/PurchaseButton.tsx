'use client'

import { useState } from 'react'

const HELPER = 'http://127.0.0.1:39201'

/**
 * 결제진행 버튼 — 쿠팡 주문매입의 PurchaseButton 미러(네이버는 id가 string).
 * order-server 가 id 로 쿠팡/네이버 주문을 자동 판별한다 (쿠팡 order_id → 네이버 product_order_id 순).
 * 1) 로컬 헬퍼 생존 → 확인 페이지 새 탭 (완주/직전정지 선택)
 * 2) 닿지 않으면(원격/헬퍼 다운) → 원격 큐(purchase-jobs)에 완주 잡 등록. 집 PC 폴러가 실행해
 *    무통장 결제 완주 + 💰입금대기·주문번호 자동 기록. jimorder:// 는 숨은 iframe으로 함께 발사.
 */
export default function PurchaseButton({ orderId }: { orderId: string }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const fireProtocol = () => {
    try {
      const f = document.createElement('iframe')
      f.style.display = 'none'
      f.src = `jimorder://order/${orderId}`
      document.body.appendChild(f)
      setTimeout(() => f.remove(), 3000)
    } catch { /* noop */ }
  }

  const pollJob = async (jobId: number) => {
    for (let i = 0; i < 90; i++) {
      await new Promise((s) => setTimeout(s, 3000))
      try {
        const r = await fetch(`/api/admin/purchase-jobs?id=${jobId}`, { cache: 'no-store' })
        const j = await r.json()
        const st = j.job?.status
        if (st === 'running') setMsg('⏳ 집 PC에서 실행 중…')
        else if (st === 'done') { setMsg(`✓ ${j.job.result_msg ?? '완료'}`); setTimeout(() => window.location.reload(), 2500); return }
        else if (st === 'error') { setMsg(`✗ ${j.job.result_msg ?? '실패'}`); return }
        else setMsg('⏳ 원격 대기중 — 집 PC 헬퍼가 곧 집습니다…')
      } catch { /* 폴링 일시 실패 무시 */ }
    }
    setMsg('⏱ 응답 시간 초과 — 집 PC 헬퍼 상태를 확인하세요')
  }

  const onClick = async () => {
    if (busy) return
    setBusy(true); setMsg(null)
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 1500)
      await fetch(`${HELPER}/health`, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
      clearTimeout(t)
      window.open(`${HELPER}/order?id=${orderId}`, '_blank', 'noopener,noreferrer')
      setBusy(false)
    } catch {
      if (!window.confirm('로컬 헬퍼에 연결할 수 없습니다.\n원격 실행할까요? 집 PC가 무통장 결제까지 완주하고 💰입금대기로 기록합니다.\n(입금 이체는 직접 하신 뒤 [입금완료]를 눌러주세요)')) { setBusy(false); return }
      fireProtocol()
      try {
        const r = await fetch('/api/admin/purchase-jobs', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order_key: orderId, mode: 'full' }),
        })
        const j = await r.json()
        if (!r.ok) { setMsg(`✗ ${j.error ?? '잡 등록 실패'}`); setBusy(false); return }
        setMsg('⏳ 원격 잡 등록됨 — 집 PC 실행 대기…')
        await pollJob(j.id)
      } catch { setMsg('✗ 네트워크 오류') }
      setBusy(false)
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-600 text-white text-[11px] font-semibold hover:bg-blue-700 disabled:opacity-60"
        title="로컬 헬퍼로 매입처(건강산/유픽B2B) 주문서 자동작성. 이 PC면 완주/직전정지 선택, 원격이면 완주(입금대기 기록). 헬퍼가 꺼져 있으면 자동 기동."
      >
        💳 결제진행{busy ? '…' : ''}
      </button>
      {msg && <span className={`text-[10px] ${msg.startsWith('✓') ? 'text-emerald-600' : msg.startsWith('✗') ? 'text-rose-600' : 'text-gray-500'}`}>{msg}</span>}
    </span>
  )
}
