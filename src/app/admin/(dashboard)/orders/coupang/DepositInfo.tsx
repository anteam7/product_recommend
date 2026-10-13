'use client'

import { useState } from 'react'

// 77bio 가상계좌 완주 시 order-server.mjs 가 purchase_note 에 남기는 문자열을 행에서 바로 보여준다.
//   [가상계좌] 기업은행 07503199897236 (예금주 디에이치트레이딩) 14,300원을 2026-09-18 까지 입금
// 가상계좌는 주문마다 번호가 새로 발급돼서(건강산·유픽B2B 의 고정 무통장 계좌와 다름)
// 이 값이 안 보이면 사람이 어디로 얼마를 보내야 할지 알 수 없다 — 입금 후 [✓입금완료] 처리 전제 조건.
const RE = /^\[가상계좌\]\s*(\S+)\s+([\d-]+)\s*(?:\(예금주\s*([^)]*)\))?\s*([\d,]+)원을\s*(.*?)\s*(?:까지\s*)*입금/

export function DepositInfo({ note, awaiting }: { note: string; awaiting: boolean }) {
  const [copied, setCopied] = useState(false)
  const m = RE.exec(note.trim())
  if (!m) {
    // 가상계좌 형식이 아닌 메모(매입처 변경 기록 등)는 조용히 한 줄로만
    return <div className="mt-1 text-[11px] text-gray-500 line-clamp-2">📝 {note}</div>
  }
  const [, bank, account, holder, amount, deadline] = m

  async function copy() {
    try {
      await navigator.clipboard.writeText(account.replace(/-/g, ''))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* 클립보드 거부 — 화면 값을 직접 복사하면 된다 */ }
  }

  if (!awaiting) {
    return (
      <div className="mt-1 text-[10px] text-gray-400">
        입금계좌 {bank} <span className="font-mono">{account}</span> · {amount}원
      </div>
    )
  }
  return (
    <div className="mt-1 rounded border border-orange-200 bg-orange-50 px-2 py-1 text-[11px] text-orange-900">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="font-semibold">💰 {bank}</span>
        <span className="font-mono text-[12px] font-bold tracking-tight select-all">{account}</span>
        <button type="button" onClick={copy} className="rounded border border-orange-300 bg-white px-1.5 py-0.5 text-[10px] hover:bg-orange-100">
          {copied ? '복사됨' : '복사'}
        </button>
        <span className="font-semibold">{amount}원</span>
      </div>
      <div className="text-[10px] text-orange-700 mt-0.5">
        예금주 {holder || '-'}{deadline ? ` · ${deadline}까지 입금` : ''} — 이체 후 [✓ 입금완료]
      </div>
    </div>
  )
}
