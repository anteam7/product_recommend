'use client'

import { useState } from 'react'
import { parsePurchaseNote } from '../depositNote'

// 결제진행 완주 시 order-server.mjs 가 purchase_note 에 남기는 입금 정보를 행에서 바로 보여준다(형식은 depositNote.ts).
// 가상계좌(77bio)는 주문마다 번호가 새로 발급되고, 캠핑문은 적립금을 먼저 써서 매입 합계와 실제 입금액이 다르다(2026-11-01) —
// 이 값이 안 보이면 사람이 어디로 얼마를 보내야 할지 알 수 없다. 입금 후 [✓입금완료] 처리 전제 조건.
export function DepositInfo({ note, awaiting }: { note: string; awaiting: boolean }) {
  const [copied, setCopied] = useState(false)
  const { deposit, prepaid, mileageUsed, rest } = parsePurchaseNote(note)
  const restLine = rest.length ? <div className="mt-1 text-[11px] text-gray-500 line-clamp-2">📝 {rest.join(' / ')}</div> : null
  const mileageLine = mileageUsed ? `적립금 ${mileageUsed.toLocaleString()}원 사용` : null
  // 선충전 결제(도매아토즈 적립금·웰루트 예치금) — 결제 후 남은 잔액을 결제 행마다 보여 충전할 때를 알게(사장님 2026-11-01)
  const prepaidLine = prepaid ? (
    <div className="mt-1 inline-flex flex-wrap items-center gap-x-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-900">
      <span>🎟 {prepaid.label} {prepaid.paid.toLocaleString()}원 결제</span>
      {prepaid.balanceAfter != null && (
        <span className="font-semibold">· 남은 {prepaid.label} {prepaid.approx ? '약 ' : ''}{prepaid.balanceAfter.toLocaleString()}원</span>
      )}
    </div>
  ) : null
  if (!deposit) {
    // 결제 기록이 아닌 메모(매입처 변경 기록 등)는 조용히 한 줄로만
    return <>{prepaidLine}{mileageLine && <div className="mt-1 text-[11px] text-gray-500">🎟 {mileageLine}</div>}{restLine}</>
  }
  const { bank, account, holder, amount, deadline } = deposit

  async function copy() {
    try {
      await navigator.clipboard.writeText(account.replace(/-/g, ''))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* 클립보드 거부 — 화면 값을 직접 복사하면 된다 */ }
  }

  if (!awaiting) {
    return (
      <>
        <div className="mt-1 text-[10px] text-gray-400">
          입금계좌 {bank} <span className="font-mono">{account}</span> · {amount.toLocaleString()}원{mileageLine ? ` (${mileageLine})` : ''}
        </div>
        {prepaidLine}
        {restLine}
      </>
    )
  }
  return (
    <>
      <div className="mt-1 rounded border border-orange-200 bg-orange-50 px-2 py-1 text-[11px] text-orange-900">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-semibold">💰 {bank}</span>
          <span className="font-mono text-[12px] font-bold tracking-tight select-all">{account}</span>
          <button type="button" onClick={copy} className="rounded border border-orange-300 bg-white px-1.5 py-0.5 text-[10px] hover:bg-orange-100">
            {copied ? '복사됨' : '복사'}
          </button>
          <span className="font-semibold">입금 {amount.toLocaleString()}원</span>
        </div>
        {mileageLine && (
          <div className="text-[10px] font-semibold text-orange-800 mt-0.5">🎟 {mileageLine} — 매입 합계가 아니라 위 금액만 이체</div>
        )}
        <div className="text-[10px] text-orange-700 mt-0.5">
          예금주 {holder || '-'}{deadline ? ` · ${deadline}까지 입금` : ''} — 이체 후 [✓ 입금완료]
        </div>
      </div>
      {prepaidLine}
      {restLine}
    </>
  )
}
