'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Props {
  id: string
  field: 'dome' | 'list'
  value: number | null
  /** 매입가 셀: 배송비 표시용 */
  shipping?: number
  /** 판매가 셀: MSP 하한 + 쿠팡 push 가능 여부 */
  msp?: number | null
  canPushCoupang?: boolean
}

function fmt(n: number | null | undefined) {
  if (n == null) return '—'
  return n.toLocaleString()
}

export function PriceCell({ id, field, value, shipping, msp, canPushCoupang }: Props) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(String(value ?? 0))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [warn, setWarn] = useState<string | null>(null)

  async function post(num: number, confirm: boolean): Promise<Response> {
    return fetch('/api/admin/coupang-publish/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, field, value: num, confirm }),
    })
  }

  async function save() {
    const num = Math.round(Number(val))
    if (!Number.isFinite(num) || num < 0) { setErr('숫자 오류'); return }
    if (field === 'list' && msp && msp > 0 && num < msp) { setErr(`MSP ${msp.toLocaleString()} 이상`); return }
    setSaving(true); setErr(null); setWarn(null)
    try {
      let res = await post(num, false)
      let j = await res.json()
      // 급변동 confirm 요청 → 사용자 확인 후 재전송
      if (res.status === 409 && j.needConfirm) {
        if (!window.confirm(`${j.error}\n\n그래도 ${num.toLocaleString()}원으로 변경할까요?`)) { setSaving(false); return }
        res = await post(num, true)
        j = await res.json()
      }
      if (!res.ok) { setErr(j.error || '실패'); setSaving(false); return }
      // 손실/미반영 경고는 닫지 않고 잠깐 노출
      if (j.warning) setWarn(j.warning)
      else if (field === 'list' && j.pushedToCoupang === false) setWarn('DB만 갱신됨 — 쿠팡 미반영(미승인/미연동)')
      setSaving(false)
      if (!j.warning && !(field === 'list' && j.pushedToCoupang === false)) setEditing(false)
      router.refresh()
    } catch {
      setErr('네트워크 오류'); setSaving(false)
    }
  }

  if (!editing) {
    return (
      <div className="group flex flex-col items-end gap-0.5">
        <button
          type="button"
          onClick={() => { setVal(String(value ?? 0)); setEditing(true); setErr(null); setWarn(null) }}
          className={`tabular-nums hover:underline decoration-dotted ${field === 'list' ? 'font-semibold text-gray-900' : ''}`}
          title="클릭하여 수정"
        >
          {fmt(value)}
          <span className="ml-1 text-[10px] text-gray-300 group-hover:text-blue-500">✎</span>
        </button>
        {field === 'dome' && shipping != null && (
          <span className="text-[10px] text-gray-400">+배송 {fmt(shipping)}</span>
        )}
        {warn && <span className="text-[10px] text-rose-600 max-w-[160px] text-right leading-tight">{warn}</span>}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <input
          type="number"
          step={field === 'list' ? 100 : 1}
          min={field === 'list' && msp ? msp : 0}
          value={val}
          autoFocus
          disabled={saving}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
          className="w-24 px-1.5 py-0.5 text-sm text-right border border-blue-400 rounded tabular-nums"
        />
        <button type="button" onClick={save} disabled={saving} className="text-xs px-1.5 py-0.5 bg-blue-600 text-white rounded disabled:opacity-50">
          {saving ? '…' : '저장'}
        </button>
        <button type="button" onClick={() => setEditing(false)} disabled={saving} className="text-xs px-1 py-0.5 text-gray-400 hover:text-gray-700">✕</button>
      </div>
      {field === 'list' && (
        <span className="text-[10px] text-amber-600">
          {canPushCoupang === false ? 'DB만 (쿠팡 미연동/미승인)' : '저장 시 쿠팡 반영'}
        </span>
      )}
      {warn && <span className="text-[10px] text-rose-600 max-w-[180px] text-right leading-tight">{warn}</span>}
      {err && <span className="text-[10px] text-rose-600">{err}</span>}
    </div>
  )
}
