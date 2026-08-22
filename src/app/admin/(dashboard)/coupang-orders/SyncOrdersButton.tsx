'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { runCoupangJob } from '@/lib/coupang-job-client'

// 특정 주문이 아닌 전역 동작이라 order_key는 고정 센티널(잡 등록 API가 숫자 6~24자리를 요구).
// 고정값이라 동시에 여러 개 큐잉되지 않고(중복 가드), 진행 중이면 그 잡을 재사용해 대기한다.
const SYNC_JOB_KEY = '000001'

/**
 * [지금 수집] — 매시 정각 크론을 기다리지 않고 쿠팡 주문을 즉시 수집.
 * 집 PC 큐(coupang_orders_sync 잡) → order-server 폴러가 실행(scripts/lib/coupang-orders-sync.mjs, 크론과 동일 로직).
 */
export default function SyncOrdersButton() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [msgErr, setMsgErr] = useState(false)

  const onClick = async () => {
    setBusy(true)
    setMsg(null)
    setMsgErr(false)
    const out = await runCoupangJob(SYNC_JOB_KEY, 'coupang_orders_sync', { doing: '주문 수집', done: '수집 완료' }, (m) => { setMsgErr(false); setMsg(m) })
    setBusy(false)
    setMsgErr(!out.startsWith('✓'))
    setMsg(out)
    router.refresh()
  }

  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700 disabled:opacity-60"
        title="매시 정각 자동 수집을 기다리지 않고 지금 쿠팡 주문을 즉시 가져옵니다(집 PC 큐 실행, 수 초~수십 초 소요)"
      >
        🔄 지금 수집{busy ? '…' : ''}
      </button>
      {msg && <span className={`text-[11px] ${msgErr ? 'text-rose-600' : 'text-emerald-600'}`}>{msg}</span>}
    </span>
  )
}
