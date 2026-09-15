'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Props {
  productNo: string
  msp: number | null
  tiers: Record<string, number> | null
  source: string | null
  detected: number | null
  detectedTiers: Record<string, number> | null
  note: string | null
  verifiedBy: string | null
  verifiedAt: string | null
}

const QTYS = [2, 3, 4, 5, 6]
const fmt = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString())

export function MspEditor(p: Props) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [one, setOne] = useState('')
  const [tierVals, setTierVals] = useState<Record<number, string>>({})
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const entered = p.source === 'manual' || p.source === 'ocr'

  function openEditor() {
    const base = p.msp ?? p.detected
    const bt = p.tiers ?? p.detectedTiers ?? {}
    setOne(base != null ? String(base) : '')
    setTierVals(Object.fromEntries(QTYS.map((q) => [q, bt[String(q)] != null ? String(bt[String(q)]) : ''])))
    setNote(p.source === 'manual' ? p.note ?? '' : '')
    setErr(null)
    setEditing(true)
  }

  function post(body: Record<string, unknown>) {
    return fetch('/api/admin/wellroot-msp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_no: p.productNo, ...body }),
    })
  }

  async function save() {
    const msp = Math.round(Number(one))
    if (!one || !Number.isFinite(msp) || msp <= 0) { setErr('1개 최저판매가를 입력하세요'); return }
    const tiers: Record<string, number> = {}
    for (const q of QTYS) {
      const v = tierVals[q]
      if (!v) continue
      const n = Math.round(Number(v))
      if (!Number.isFinite(n) || n <= 0) { setErr(`${q}개 값 오류`); return }
      tiers[String(q)] = n
    }
    setSaving(true); setErr(null)
    try {
      let res = await post({ action: 'set', msp, tiers, note, confirm: false })
      let j = await res.json()
      if (res.status === 409 && j.needConfirm) {
        if (!window.confirm(`${j.error}\n\n그대로 저장할까요?`)) { setSaving(false); return }
        res = await post({ action: 'set', msp, tiers, note, confirm: true })
        j = await res.json()
      }
      if (!res.ok) { setErr(j.error || '저장 실패'); setSaving(false); return }
      setSaving(false); setEditing(false)
      router.refresh()
    } catch {
      setErr('네트워크 오류'); setSaving(false)
    }
  }

  async function revert() {
    if (!window.confirm('입력된 MSP를 지우고 수집기 탐지값으로 되돌릴까요? (탐지값이 없으면 등록 제외됩니다)')) return
    setSaving(true); setErr(null)
    try {
      const res = await post({ action: 'revert' })
      const j = await res.json()
      if (!res.ok) { setErr(j.error || '실패'); setSaving(false); return }
      setSaving(false)
      router.refresh()
    } catch {
      setErr('네트워크 오류'); setSaving(false)
    }
  }

  if (!editing) {
    const tierEntries = Object.entries(p.tiers ?? {}).filter(([q]) => q !== '1').sort((a, b) => Number(a[0]) - Number(b[0]))
    return (
      <div className="flex flex-col items-end gap-1 text-right">
        {p.msp != null ? (
          <>
            <div className="tabular-nums font-semibold text-gray-900">{fmt(p.msp)}<span className="text-[10px] text-gray-400 font-normal ml-0.5">원/1개</span></div>
            {tierEntries.length > 0 && (
              <div className="text-[10px] text-gray-500 leading-tight max-w-[180px]">
                {tierEntries.map(([q, v]) => `${q}개 ${fmt(v)}`).join(' · ')}
              </div>
            )}
            {p.source === 'manual' && (
              <div className="text-[10px] text-violet-600 leading-tight">
                ✍️ {p.verifiedBy?.split('@')[0] ?? ''} {(p.verifiedAt ?? '').slice(5, 16).replace('T', ' ')}
                {p.note && <div className="text-gray-500 max-w-[180px]">“{p.note}”</div>}
              </div>
            )}
            {p.source === 'ocr' && (
              <div className="text-[10px] text-indigo-600 leading-tight">🤖 이미지 판독 {(p.verifiedAt ?? '').slice(5, 10)} · 이미지와 대조</div>
            )}
          </>
        ) : (
          <div className="text-xs text-rose-600 font-semibold">MSP 없음 · 등록 제외</div>
        )}
        <div className="flex gap-1">
          <button type="button" onClick={openEditor} className="text-xs px-2 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-700">
            {p.msp != null ? '수정' : '입력'}
          </button>
          {entered && (
            <button type="button" onClick={revert} disabled={saving} className="text-xs px-2 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50">
              되돌리기
            </button>
          )}
        </div>
        {err && <span className="text-[10px] text-rose-600">{err}</span>}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-end gap-1.5 min-w-[210px]">
      <label className="flex items-center gap-1 text-xs">
        <span className="text-gray-600 font-semibold">1개</span>
        <input
          type="number"
          step={100}
          min={0}
          value={one}
          autoFocus
          disabled={saving}
          onChange={(e) => setOne(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
          className="w-28 px-1.5 py-0.5 text-sm text-right border border-blue-400 rounded tabular-nums"
          placeholder="필수"
        />
      </label>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
        {QTYS.map((q) => (
          <label key={q} className="flex items-center gap-1 text-[11px]">
            <span className="text-gray-500 w-6 text-right">{q}개</span>
            <input
              type="number"
              step={100}
              min={0}
              value={tierVals[q] ?? ''}
              disabled={saving}
              onChange={(e) => setTierVals((s) => ({ ...s, [q]: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
              className="w-20 px-1 py-0.5 text-xs text-right border border-gray-300 rounded tabular-nums"
              placeholder="선택"
            />
          </label>
        ))}
      </div>
      <input
        type="text"
        value={note}
        disabled={saving}
        onChange={(e) => setNote(e.target.value)}
        className="w-full px-1.5 py-0.5 text-xs border border-gray-300 rounded"
        placeholder="확인 메모 (예: 채널톡 답변 9/16)"
      />
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-gray-400">배송비 포함 금액</span>
        <button type="button" onClick={save} disabled={saving} className="text-xs px-2 py-0.5 bg-blue-600 text-white rounded disabled:opacity-50">
          {saving ? '…' : '저장'}
        </button>
        <button type="button" onClick={() => setEditing(false)} disabled={saving} className="text-xs px-1 py-0.5 text-gray-400 hover:text-gray-700">✕</button>
      </div>
      {err && <span className="text-[10px] text-rose-600 whitespace-pre-line text-right">{err}</span>}
    </div>
  )
}
