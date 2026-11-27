'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { runCoupangJob, type CoupangJobMode } from '@/lib/coupang-job-client'

// 특정 주문이 아닌 전역 동작이라 order_key는 고정 센티널(잡 등록 API가 숫자 6~24자리를 요구).
// 고정값이라 동시에 여러 개 큐잉되지 않고(중복 가드), 진행 중이면 그 잡을 재사용해 대기한다. 버튼마다 다른 값.
const SYNC_JOB_KEY = '000001'
const STATUS_SYNC_JOB_KEY = '000002'

interface JobButtonProps {
  jobKey: string
  mode: CoupangJobMode
  labels: { doing: string; done: string }
  text: string
  title: string
  className: string
  wait?: { timeoutMs: number; intervalMs: number; hint: string }
}

/** 집 PC 큐 잡을 등록하고 끝날 때까지 기다린 뒤 화면을 새로고침하는 버튼 */
function JobButton({ jobKey, mode, labels, text, title, className, wait }: JobButtonProps) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [msgErr, setMsgErr] = useState(false)

  const onClick = async () => {
    setBusy(true)
    setMsg(null)
    setMsgErr(false)
    const out = await runCoupangJob(jobKey, mode, labels, (m) => { setMsgErr(false); setMsg(m) }, wait)
    setBusy(false)
    setMsgErr(!out.startsWith('✓'))
    setMsg(out)
    router.refresh()
  }

  return (
    <span className="inline-flex flex-col items-start gap-0.5 max-w-md">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className={`inline-flex items-center gap-1 px-3 py-1.5 rounded text-white text-xs font-semibold disabled:opacity-60 ${className}`}
        title={title}
      >
        {text}{busy ? '…' : ''}
      </button>
      {msg && <span className={`text-[11px] ${msgErr ? 'text-rose-600' : 'text-emerald-600'}`}>{msg}</span>}
    </span>
  )
}

/**
 * [지금 수집] — 매시 정각 크론을 기다리지 않고 쿠팡 주문을 즉시 수집.
 * 집 PC 큐(coupang_orders_sync 잡) → order-server 폴러가 실행(scripts/lib/coupang-orders-sync.mjs, 크론과 동일 로직).
 */
export default function SyncOrdersButton() {
  return (
    <JobButton
      jobKey={SYNC_JOB_KEY}
      mode="coupang_orders_sync"
      labels={{ doing: '주문 수집', done: '수집 완료' }}
      text="🔄 쿠팡 주문 지금 수집"
      title="매시 정각 자동 수집을 기다리지 않고 지금 쿠팡 주문을 즉시 가져옵니다(집 PC 큐 실행, 수 초~수십 초 소요)"
      className="bg-emerald-600 hover:bg-emerald-700"
    />
  )
}

/**
 * [주문 상태 싱크] — 매시 :30 크론(scripts/local-cron-ggsan-sync.mjs)을 지금 실행 (2026-11-27).
 * 매입처 주문을 조회해 입금확인(입금대기→발주완료 + 쿠팡 발주확인)·송장 감지(→매입처발송 + 쿠팡 송장등록)·취소 감지를 반영.
 * 집 PC 큐(coupang_status_sync 잡) → order-server 가 같은 스크립트를 자식 프로세스로 띄운다. 매입처 로그인·조회로 1~5분.
 */
export function SyncStatusButton() {
  return (
    <JobButton
      jobKey={STATUS_SYNC_JOB_KEY}
      mode="coupang_status_sync"
      labels={{ doing: '주문 상태 싱크', done: '상태 싱크 완료' }}
      text="🔁 주문 상태 싱크"
      title="매시 :30 자동 싱크를 기다리지 않고 지금 매입처 주문을 조회해 입금확인·송장(발송)·취소를 매입상태에 반영하고, 쿠팡 발주확인·송장등록까지 합니다(집 PC 큐 실행, 1~5분 소요)"
      className="bg-sky-600 hover:bg-sky-700"
      wait={{ timeoutMs: 7 * 60 * 1000, intervalMs: 4000, hint: '매입처 로그인·조회로 1~5분 걸립니다' }}
    />
  )
}
