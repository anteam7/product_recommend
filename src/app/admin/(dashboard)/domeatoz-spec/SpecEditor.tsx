'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

type Unit = 'g' | 'ml'
interface Current { unit: Unit | null; per: number | null; pieces: number | null; attrs?: Record<string, string>; note?: string | null }
interface Props {
  idx: string
  view: string
  needAttrs: string[]
  defaults: { unit: Unit | null; pieces: number | null }
  current: Current | null
  by: string | null
  at: string | null
}

export function SpecEditor(p: Props) {
  const router = useRouter()
  const cur = p.current
  const attrNames = [...new Set([...p.needAttrs, ...Object.keys(cur?.attrs ?? {})])]
  const [editing, setEditing] = useState(!cur && p.view !== 'skipped')
  const [per, setPer] = useState(cur?.per != null ? String(cur.per) : '')
  const [unit, setUnit] = useState<Unit>(cur?.unit ?? p.defaults.unit ?? 'g')
  const [pieces, setPieces] = useState(cur?.pieces != null ? String(cur.pieces) : p.defaults.pieces != null ? String(p.defaults.pieces) : '')
  const [attrs, setAttrs] = useState<Record<string, string>>(Object.fromEntries(attrNames.map((n) => [n, cur?.attrs?.[n] ?? ''])))
  const [note, setNote] = useState(cur?.note ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function post(body: Record<string, unknown>) {
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/admin/domeatoz-spec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idx: p.idx, ...body }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(j.error || '저장 실패'); setSaving(false); return }
      setSaving(false); setEditing(false)
      router.refresh()
    } catch {
      setErr('네트워크 오류'); setSaving(false)
    }
  }

  function save() {
    const perN = per.trim() === '' ? null : Number(per)
    const piecesN = pieces.trim() === '' ? null : Number(pieces)
    if (perN != null && !(perN > 0)) { setErr('1개당 값은 0보다 커야 합니다'); return }
    if (piecesN != null && !(Number.isInteger(piecesN) && piecesN >= 1)) { setErr('총 개수는 1 이상 정수'); return }
    for (const n of p.needAttrs) if (!attrs[n]?.trim()) { setErr(`${n} 값을 넣으세요`); return }
    if (p.view === 'weight' && perN == null) { setErr('1개당 중량(또는 용량)을 넣으세요'); return }
    if (perN != null && piecesN != null && perN * piecesN > 200_000 && !window.confirm(`총 ${(perN * piecesN).toLocaleString()}${unit} 입니다. 맞나요?`)) return
    post({ action: 'set', per: perN, unit, pieces: piecesN, attrs, note })
  }

  if (p.view === 'skipped') {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="text-gray-500">등록 안 함</span>
        <button disabled={saving} onClick={() => post({ action: 'unskip' })} className="px-2 py-1 rounded border hover:bg-gray-50 disabled:opacity-50">되돌리기</button>
        {err && <span className="text-rose-600">{err}</span>}
      </div>
    )
  }

  if (!editing && cur) {
    const parts = [cur.per != null ? `1개 ${cur.per}${cur.unit ?? ''}` : null, cur.pieces != null ? `총 ${cur.pieces}개` : null, ...Object.entries(cur.attrs ?? {}).map(([k, v]) => `${k}: ${v}`)].filter(Boolean)
    return (
      <div className="text-sm space-y-1">
        <div className="font-medium text-violet-700">✍️ {parts.join(' · ') || '—'}</div>
        {cur.note && <div className="text-xs text-gray-500">메모: {cur.note}</div>}
        <div className="text-[10px] text-gray-400">{p.by ?? ''} {p.at ? p.at.slice(0, 16).replace('T', ' ') : ''}</div>
        <div className="flex gap-2 pt-1">
          <button onClick={() => setEditing(true)} className="px-2 py-1 text-xs rounded border hover:bg-gray-50">수정</button>
          <button disabled={saving} onClick={() => { if (window.confirm('입력값을 지우고 다시 등록 제외로 돌릴까요? (이미 쿠팡에 올라간 상품은 그대로입니다)')) post({ action: 'clear' }) }} className="px-2 py-1 text-xs rounded border text-gray-500 hover:bg-gray-50 disabled:opacity-50">입력 해제</button>
        </div>
        {err && <div className="text-xs text-rose-600">{err}</div>}
      </div>
    )
  }

  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-[11px] text-gray-500">
          1개당 중량·용량
          <span className="flex items-center gap-1">
            <input inputMode="decimal" value={per} onChange={(e) => setPer(e.target.value)} placeholder="예: 12" className="w-24 px-2 py-1 border rounded text-sm text-gray-900" />
            <select value={unit} onChange={(e) => setUnit(e.target.value as Unit)} className="px-1 py-1 border rounded text-sm text-gray-900">
              <option value="g">g</option>
              <option value="ml">ml</option>
            </select>
          </span>
        </label>
        <label className="flex flex-col text-[11px] text-gray-500">
          총 개수(낱개)
          <input inputMode="numeric" value={pieces} onChange={(e) => setPieces(e.target.value)} placeholder="예: 300" className="w-24 px-2 py-1 border rounded text-sm text-gray-900" />
        </label>
        {attrNames.map((n) => (
          <label key={n} className="flex flex-col text-[11px] text-gray-500">
            {n}{p.needAttrs.includes(n) ? ' (필수)' : ''}
            <input value={attrs[n] ?? ''} onChange={(e) => setAttrs({ ...attrs, [n]: e.target.value })} placeholder={n.includes('맛') ? '예: 오리지널' : ''} className="w-32 px-2 py-1 border rounded text-sm text-gray-900" />
          </label>
        ))}
      </div>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="메모(선택) — 어디서 찾았는지 등" className="w-full max-w-md px-2 py-1 border rounded text-xs text-gray-900" />
      <div className="flex flex-wrap gap-2">
        <button disabled={saving} onClick={save} className="px-3 py-1 text-xs rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">{saving ? '저장 중…' : '저장 → 등록 대상'}</button>
        {cur && <button onClick={() => setEditing(false)} className="px-3 py-1 text-xs rounded border hover:bg-gray-50">취소</button>}
        {!cur && <button disabled={saving} onClick={() => { if (window.confirm('이 상품은 등록하지 않을까요?')) post({ action: 'skip' }) }} className="px-3 py-1 text-xs rounded border text-gray-500 hover:bg-gray-50 disabled:opacity-50">등록 안 함</button>}
      </div>
      {err && <div className="text-xs text-rose-600 whitespace-pre-line">{err}</div>}
    </div>
  )
}
