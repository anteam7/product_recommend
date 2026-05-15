'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export interface PinHealth {
  keyword: string
  source: string
  pinned_at: string
  status: string
  notes: string | null
  product_id: string | null
  product_name: string | null
  category_top: string | null
  entry_final: number | null
  entry_trend: number | null
  entry_commerce: number | null
  entry_supplier: number | null
  entry_competition: number | null
  current_final: number | null
  current_trend: number | null
  current_commerce: number | null
  current_supplier: number | null
  current_competition: number | null
  delta_final: number | null
  delta_trend: number | null
  delta_commerce: number | null
  delta_supplier: number | null
  delta_competition: number | null
  days_since_pin: number | null
  last_score_at: string | null
  signal_alive: boolean | null
}

function fmt(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '–'
  return Number(v).toFixed(digits)
}

function fmtDelta(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '–'
  const n = Number(v)
  return (n >= 0 ? '+' : '') + n.toFixed(1)
}

function classifyBadge(row: PinHealth): { label: string; cls: string } {
  if (row.status === 'exit_win')  return { label: '익절', cls: 'bg-emerald-100 text-emerald-700' }
  if (row.status === 'exit_loss') return { label: '손절', cls: 'bg-rose-100 text-rose-700' }
  if (row.status === 'exit_dead') return { label: '사망', cls: 'bg-gray-200 text-gray-600' }

  // status='live'
  if (row.signal_alive === false) return { label: '사망-시그널끊김', cls: 'bg-gray-300 text-gray-700' }
  const d = row.delta_final
  if (d === null || d === undefined) return { label: '신규', cls: 'bg-blue-100 text-blue-700' }
  if (d <= -15) return { label: '위험', cls: 'bg-rose-100 text-rose-700' }
  if (d >= 5)   return { label: '상승', cls: 'bg-emerald-100 text-emerald-700' }
  return { label: '유지', cls: 'bg-amber-50 text-amber-700' }
}

function Gauge({ entry, current }: { entry: number | null; current: number | null }) {
  const e = entry ?? 0
  const c = current ?? 0
  const max = 100
  const eL = Math.max(0, Math.min(100, (e / max) * 100))
  const cL = Math.max(0, Math.min(100, (c / max) * 100))
  const up = c >= e
  return (
    <div className="relative h-2 w-full bg-gray-100 rounded overflow-hidden">
      <div
        className={`absolute top-0 h-2 ${up ? 'bg-emerald-400' : 'bg-rose-400'} opacity-60`}
        style={{ left: `${Math.min(eL, cL)}%`, width: `${Math.abs(cL - eL)}%` }}
      />
      <div
        className="absolute top-0 h-2 w-[2px] bg-gray-700"
        style={{ left: `calc(${eL}% - 1px)` }}
        title={`진입 ${fmt(entry)}`}
      />
      <div
        className={`absolute top-0 h-2 w-[2px] ${up ? 'bg-emerald-700' : 'bg-rose-700'}`}
        style={{ left: `calc(${cL}% - 1px)` }}
        title={`현재 ${fmt(current)}`}
      />
    </div>
  )
}

function DeltaBar({ label, value }: { label: string; value: number | null }) {
  if (value === null || value === undefined) {
    return <span className="text-[10px] text-gray-400">{label} –</span>
  }
  const v = Number(value)
  const cls = v >= 0 ? 'text-emerald-600' : 'text-rose-600'
  return (
    <span className={`text-[10px] font-mono ${cls}`}>
      {label} {fmtDelta(v)}
    </span>
  )
}

export default function PinHealthRow({ row }: { row: PinHealth }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const badge = classifyBadge(row)
  const isExited = row.status !== 'live'

  const setStatus = async (status: string, reason?: string) => {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch('/api/admin/trends/pin/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: row.keyword, source: row.source, status, exit_reason: reason }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      router.refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid grid-cols-12 gap-3 items-center px-4 py-3 text-sm hover:bg-gray-50">
      <div className="col-span-3">
        <div className="flex items-center gap-2">
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${badge.cls}`}>{badge.label}</span>
          <span className="font-medium truncate" title={row.keyword}>{row.keyword}</span>
        </div>
        <div className="text-[11px] text-gray-500 mt-0.5 truncate">
          {row.source}
          {row.product_name && <> · {row.product_name}</>}
          {row.category_top && <> · {row.category_top}</>}
        </div>
        {row.notes && <div className="text-[11px] text-gray-500 mt-0.5 truncate">{row.notes}</div>}
      </div>

      <div className="col-span-2 text-[11px] font-mono text-gray-700">
        <div>진입 {fmt(row.entry_final)}</div>
        <div>현재 {fmt(row.current_final)}</div>
      </div>

      <div className="col-span-2">
        <Gauge entry={row.entry_final} current={row.current_final} />
        <div className="text-[11px] mt-1 font-mono text-center">
          Δfinal {fmtDelta(row.delta_final)}
        </div>
      </div>

      <div className="col-span-3 flex flex-col gap-0.5">
        <DeltaBar label="Δtrend" value={row.delta_trend} />
        <DeltaBar label="Δcom"   value={row.delta_commerce} />
        <DeltaBar label="Δsup"   value={row.delta_supplier} />
        <DeltaBar label="Δcomp"  value={row.delta_competition} />
      </div>

      <div className="col-span-2 text-right">
        <div className="text-[11px] text-gray-500 font-mono">
          핀 {row.pinned_at?.slice(0, 10)}
          {row.days_since_pin !== null && <> · {row.days_since_pin}일</>}
        </div>
        {!isExited ? (
          <div className="flex gap-1 justify-end mt-1">
            <button
              disabled={busy}
              onClick={() => setStatus('exit_win', 'manual')}
              className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
            >
              익절
            </button>
            <button
              disabled={busy}
              onClick={() => setStatus('exit_loss', 'manual')}
              className="text-[10px] px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 hover:bg-rose-100 disabled:opacity-50"
            >
              손절
            </button>
            <button
              disabled={busy}
              onClick={() => setStatus('exit_dead', 'signal_lost')}
              className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-50"
            >
              사망
            </button>
          </div>
        ) : (
          <button
            disabled={busy}
            onClick={() => setStatus('live')}
            className="mt-1 text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-50"
          >
            추적 재개
          </button>
        )}
        {err && <div className="text-[10px] text-rose-600 mt-0.5">{err}</div>}
      </div>
    </div>
  )
}
