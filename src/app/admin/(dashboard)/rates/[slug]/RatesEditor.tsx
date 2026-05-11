'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { Tables } from '@/lib/supabase'

type Rate = Tables<'shipping_rates'>

type Status = 'idle' | 'saving' | 'saved' | 'error'
type CellState = Record<string, { status: Status; error?: string }>

const COUNTRY_FLAGS: Record<string, string> = { US: '🇺🇸', JP: '🇯🇵', CN: '🇨🇳', EU: '🇪🇺' }

const EDITABLE_COLS = [
  'center_name',
  'weight_min',
  'weight_max',
  'price_krw',
  'price_usd',
  'price_jpy',
  'shipping_type',
  'member_grade',
  'grade_level',
] as const
type EditableCol = (typeof EDITABLE_COLS)[number]

const NUMERIC_COLS: readonly EditableCol[] = [
  'weight_min',
  'weight_max',
  'price_krw',
  'price_usd',
  'price_jpy',
  'grade_level',
]

function cellKey(id: string, col: string) {
  return `${id}:${col}`
}

export default function RatesEditor({
  forwarderId,
  forwarderName,
  slug,
  initialRates,
}: {
  forwarderId: string
  forwarderName: string
  slug: string
  initialRates: Rate[]
}) {
  const [rates, setRates] = useState<Rate[]>(initialRates)
  const [cellState, setCellState] = useState<CellState>({})
  const [adding, setAdding] = useState(false)

  const countries = useMemo(
    () => Array.from(new Set(rates.map((r) => r.country))).sort(),
    [rates],
  )

  const [activeCountry, setActiveCountry] = useState<string | null>(countries[0] ?? 'US')

  const grouped = useMemo(() => {
    const byCountry = new Map<string, Map<string, Rate[]>>() // country -> grade_level|member_grade -> rates
    for (const r of rates) {
      if (!byCountry.has(r.country)) byCountry.set(r.country, new Map())
      const k = `${r.grade_level}|${r.member_grade}`
      const g = byCountry.get(r.country)!
      if (!g.has(k)) g.set(k, [])
      g.get(k)!.push(r)
    }
    return byCountry
  }, [rates])

  async function updateCell(id: string, col: EditableCol, rawValue: string) {
    const key = cellKey(id, col)
    const rate = rates.find((r) => r.id === id)
    if (!rate) return

    let nextValue: number | string | null
    if (rawValue === '') {
      nextValue = null
    } else if (NUMERIC_COLS.includes(col)) {
      const n = Number(rawValue)
      if (!Number.isFinite(n)) {
        setCellState((s) => ({ ...s, [key]: { status: 'error', error: '숫자가 아닙니다' } }))
        return
      }
      nextValue = n
    } else {
      nextValue = rawValue
    }

    const existing = rate[col] as unknown
    if (existing === nextValue) return
    if (existing == null && nextValue == null) return

    setCellState((s) => ({ ...s, [key]: { status: 'saving' } }))

    try {
      const res = await fetch(`/api/admin/rates/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: { [col]: nextValue }, slug }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'PATCH 실패')

      setRates((list) => list.map((r) => (r.id === id ? { ...r, ...(data.rate as Rate) } : r)))
      setCellState((s) => ({ ...s, [key]: { status: 'saved' } }))
      setTimeout(() => {
        setCellState((s) => {
          const copy = { ...s }
          if (copy[key]?.status === 'saved') delete copy[key]
          return copy
        })
      }, 1500)
    } catch (err) {
      setCellState((s) => ({
        ...s,
        [key]: { status: 'error', error: err instanceof Error ? err.message : 'error' },
      }))
    }
  }

  async function deleteRate(id: string) {
    if (!confirm('이 요금 행을 DB에서 즉시 삭제합니다. 되돌릴 수 없습니다. 계속할까요?')) return
    const res = await fetch(`/api/admin/rates/${id}?slug=${slug}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      alert(`삭제 실패: ${data.error ?? res.status}`)
      return
    }
    setRates((list) => list.filter((r) => r.id !== id))
  }

  async function addRate(country: string, template?: Rate) {
    setAdding(true)
    try {
      const payload = {
        forwarder_id: forwarderId,
        country,
        center_name: template?.center_name ?? null,
        weight_min: template?.weight_max ?? 0,
        weight_max: template ? template.weight_max + 0.5 : 0.5,
        price_krw: null,
        price_usd: null,
        price_jpy: null,
        shipping_type: template?.shipping_type ?? 'air',
        member_grade: template?.member_grade ?? '일반',
        grade_level: template?.grade_level ?? 1,
        slug,
      }
      const res = await fetch('/api/admin/rates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '추가 실패')
      setRates((list) => [...list, data.rate as Rate])
    } catch (err) {
      alert(err instanceof Error ? err.message : '오류')
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* 국가 탭 */}
      <div className="bg-white border rounded-lg p-2 flex items-center gap-2 flex-wrap">
        {countries.length === 0 ? (
          <span className="text-sm text-gray-500 px-2">요금 데이터 없음. 아래에서 행을 추가하세요.</span>
        ) : (
          countries.map((c) => (
            <button
              key={c}
              onClick={() => setActiveCountry(c)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                activeCountry === c
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              <span className="mr-1">{COUNTRY_FLAGS[c] || '🌍'}</span>
              {c}
              <span className="ml-2 text-xs opacity-80">
                {rates.filter((r) => r.country === c).length}
              </span>
            </button>
          ))
        )}
        <div className="ml-auto flex gap-2">
          {['US', 'JP', 'CN', 'EU'].map((c) => {
            if (countries.includes(c)) return null
            return (
              <Button
                key={c}
                variant="outline"
                size="sm"
                disabled={adding}
                onClick={() => {
                  addRate(c)
                  setActiveCountry(c)
                }}
              >
                + {COUNTRY_FLAGS[c]} {c} 추가
              </Button>
            )
          })}
        </div>
      </div>

      {/* 테이블 — 활성 국가 */}
      {activeCountry && grouped.has(activeCountry) && (
        <div className="space-y-6">
          {Array.from(grouped.get(activeCountry)!.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([groupKey, groupRates]) => {
              const [level, grade] = groupKey.split('|')
              const sorted = [...groupRates].sort(
                (a, b) =>
                  (a.center_name ?? '').localeCompare(b.center_name ?? '') ||
                  a.weight_min - b.weight_min,
              )

              return (
                <div key={groupKey} className="bg-white border rounded-lg overflow-hidden">
                  <div className="bg-gray-50 border-b px-4 py-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge className="bg-gray-600">등급 {level}</Badge>
                      <span className="font-medium text-gray-900 text-sm">{grade}</span>
                    </div>
                    <span className="text-xs text-gray-500">{sorted.length}행</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs min-w-[760px]">
                      <thead className="bg-gray-50 border-b">
                        <tr>
                          <th className="text-left px-2 py-1.5 text-gray-500 font-medium">센터</th>
                          <th className="text-right px-2 py-1.5 text-gray-500 font-medium">무게 최소</th>
                          <th className="text-right px-2 py-1.5 text-gray-500 font-medium">무게 최대</th>
                          <th className="text-right px-2 py-1.5 text-gray-500 font-medium">KRW</th>
                          <th className="text-right px-2 py-1.5 text-gray-500 font-medium">USD</th>
                          <th className="text-right px-2 py-1.5 text-gray-500 font-medium">JPY</th>
                          <th className="text-left px-2 py-1.5 text-gray-500 font-medium">타입</th>
                          <th className="text-right px-2 py-1.5 text-gray-500 font-medium"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {sorted.map((r) => (
                          <RateRow
                            key={r.id}
                            rate={r}
                            cellState={cellState}
                            onCellUpdate={updateCell}
                            onDelete={() => deleteRate(r.id)}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="bg-gray-50 border-t px-3 py-2">
                    <button
                      onClick={() => addRate(activeCountry, sorted[sorted.length - 1])}
                      disabled={adding}
                      className="text-xs text-blue-600 hover:underline"
                    >
                      + 행 추가 (마지막 행 기준 무게 구간 연장)
                    </button>
                  </div>
                </div>
              )
            })}
        </div>
      )}

      {activeCountry && !grouped.has(activeCountry) && (
        <div className="bg-white border rounded-lg p-8 text-center text-sm text-gray-500">
          {activeCountry} 요금 없음. 상단 &ldquo;+ {activeCountry} 추가&rdquo; 버튼으로 첫 행을 생성하세요.
        </div>
      )}

      <p className="text-xs text-gray-500">
        💡 셀 클릭 → 값 변경 → 포커스 떠나면 자동 저장. 저장 성공 시 🟢, 실패 시 🔴로 표시됩니다. 저장 후{' '}
        <Link href={`/forwarders/${slug}`} target="_blank" className="text-blue-600 hover:underline">
          /forwarders/{slug}
        </Link>
        에 즉시 반영됩니다.
      </p>
    </div>
  )
}

function RateRow({
  rate,
  cellState,
  onCellUpdate,
  onDelete,
}: {
  rate: Rate
  cellState: CellState
  onCellUpdate: (id: string, col: EditableCol, value: string) => void
  onDelete: () => void
}) {
  return (
    <tr className="border-b last:border-b-0 hover:bg-blue-50/30">
      <Cell rate={rate} col="center_name" state={cellState} onChange={onCellUpdate} align="left" />
      <Cell rate={rate} col="weight_min" state={cellState} onChange={onCellUpdate} align="right" />
      <Cell rate={rate} col="weight_max" state={cellState} onChange={onCellUpdate} align="right" />
      <Cell rate={rate} col="price_krw" state={cellState} onChange={onCellUpdate} align="right" />
      <Cell rate={rate} col="price_usd" state={cellState} onChange={onCellUpdate} align="right" />
      <Cell rate={rate} col="price_jpy" state={cellState} onChange={onCellUpdate} align="right" />
      <Cell rate={rate} col="shipping_type" state={cellState} onChange={onCellUpdate} align="left" />
      <td className="px-2 py-1 text-right">
        <button onClick={onDelete} className="text-red-500 hover:text-red-700 text-xs" title="행 삭제">
          ✕
        </button>
      </td>
    </tr>
  )
}

function Cell({
  rate,
  col,
  state,
  onChange,
  align,
}: {
  rate: Rate
  col: EditableCol
  state: CellState
  onChange: (id: string, col: EditableCol, value: string) => void
  align: 'left' | 'right'
}) {
  const key = cellKey(rate.id, col)
  const cs = state[key]
  const raw = rate[col]
  const initial = raw == null ? '' : String(raw)

  const [value, setValue] = useState(initial)
  // 외부에서 데이터가 갱신될 때 동기화 (optimistic update 이후)
  if (value !== initial && !cs) {
    setValue(initial)
  }

  const isNumeric = NUMERIC_COLS.includes(col)

  return (
    <td className={`px-1 py-1 ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <div className="relative">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => onChange(rate.id, col, value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              setValue(initial)
              e.currentTarget.blur()
            }
          }}
          inputMode={isNumeric ? 'decimal' : 'text'}
          className={`w-full px-1.5 py-1 bg-transparent border border-transparent rounded hover:border-gray-200 focus:bg-white focus:border-blue-400 outline-none font-mono text-xs ${
            align === 'right' ? 'text-right' : 'text-left'
          }`}
        />
        {cs && (
          <span
            className={`absolute -right-0.5 -top-0.5 w-2 h-2 rounded-full ${
              cs.status === 'saving'
                ? 'bg-amber-400'
                : cs.status === 'saved'
                  ? 'bg-green-500'
                  : 'bg-red-500'
            }`}
            title={cs.error ?? cs.status}
          />
        )}
      </div>
    </td>
  )
}

