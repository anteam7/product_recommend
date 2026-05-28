'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface MapRow {
  id: string
  taxonomy_category: string
  hs_code_prefix: string
  label: string | null
  is_active: boolean
}

export function TaxonomyMapEditor({ rows }: { rows: MapRow[] }) {
  const router = useRouter()
  const [tax, setTax] = useState('')
  const [hs, setHs] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function add() {
    if (!tax || !hs) return
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch('/api/admin/trend-radar/customs-taxonomy-map', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taxonomy_category: tax, hs_code_prefix: hs, label: label || null }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
      setTax('')
      setHs('')
      setLabel('')
      router.refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    if (!confirm('삭제하시겠습니까?')) return
    setBusy(true)
    try {
      const res = await fetch(`/api/admin/trend-radar/customs-taxonomy-map?id=${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
      router.refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-12 gap-2 text-xs">
        <input
          value={tax}
          onChange={(e) => setTax(e.target.value)}
          placeholder="taxonomy_category (health/living/digital)"
          className="col-span-3 border border-gray-300 rounded px-2 py-1"
        />
        <input
          value={hs}
          onChange={(e) => setHs(e.target.value)}
          placeholder="HS prefix (예: 2106)"
          className="col-span-2 border border-gray-300 rounded px-2 py-1 font-mono"
        />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="라벨 (선택)"
          className="col-span-5 border border-gray-300 rounded px-2 py-1"
        />
        <button
          disabled={busy || !tax || !hs}
          onClick={add}
          className="col-span-2 rounded bg-black text-white text-xs py-1 disabled:opacity-40"
        >
          {busy ? '…' : '추가'}
        </button>
      </div>
      {err && <div className="text-xs text-red-600">{err}</div>}

      <div className="rounded border border-gray-200 divide-y divide-gray-100">
        <div className="grid grid-cols-12 px-3 py-1 bg-gray-50 text-xs text-gray-500">
          <div className="col-span-3">taxonomy</div>
          <div className="col-span-2">HS prefix</div>
          <div className="col-span-5">label</div>
          <div className="col-span-1">active</div>
          <div className="col-span-1"></div>
        </div>
        {rows.map((r) => (
          <div key={r.id} className="grid grid-cols-12 px-3 py-1 text-sm items-center">
            <div className="col-span-3 font-mono">{r.taxonomy_category}</div>
            <div className="col-span-2 font-mono">{r.hs_code_prefix}</div>
            <div className="col-span-5 text-gray-600 truncate">{r.label ?? '—'}</div>
            <div className="col-span-1 text-xs">{r.is_active ? '✓' : '○'}</div>
            <div className="col-span-1 text-right">
              <button
                disabled={busy}
                onClick={() => remove(r.id)}
                className="text-xs text-red-600 hover:underline"
              >
                삭제
              </button>
            </div>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="px-3 py-4 text-xs text-gray-400 text-center">매핑 없음</div>
        )}
      </div>
    </div>
  )
}
