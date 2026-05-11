'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { AdditionalService, SERVICE_CATEGORIES } from '@/types'

type Status = 'idle' | 'saving' | 'saved' | 'error'
type CellState = Record<string, { status: Status; error?: string }>

const EDITABLE_COLS = [
  'category',
  'service_name',
  'price_text',
  'description',
  'display_order',
  'is_active',
] as const
type EditableCol = (typeof EDITABLE_COLS)[number]

function cellKey(id: string, col: string) {
  return `${id}:${col}`
}

export default function ServicesEditor({
  forwarderId,
  forwarderSlug,
  initial,
}: {
  forwarderId: string
  forwarderSlug: string
  initial: AdditionalService[]
}) {
  const [items, setItems] = useState<AdditionalService[]>(initial)
  const [cellStates, setCellStates] = useState<CellState>({})
  const [newCategory, setNewCategory] = useState<string>('')
  const [adding, setAdding] = useState(false)

  const byCategory = useMemo(() => {
    const m = new Map<string, AdditionalService[]>()
    for (const s of items) {
      if (!m.has(s.category)) m.set(s.category, [])
      m.get(s.category)!.push(s)
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
    }
    return m
  }, [items])

  const presentCategories = Array.from(byCategory.keys()).sort()
  const remainingCategories = SERVICE_CATEGORIES.filter((c) => !presentCategories.includes(c))

  function setCell(id: string, col: string, state: { status: Status; error?: string }) {
    setCellStates((prev) => ({ ...prev, [cellKey(id, col)]: state }))
    if (state.status === 'saved') {
      setTimeout(() => {
        setCellStates((prev) => {
          const nx = { ...prev }
          delete nx[cellKey(id, col)]
          return nx
        })
      }, 1500)
    }
  }

  async function saveField(item: AdditionalService, col: EditableCol, value: unknown) {
    setCell(item.id, col, { status: 'saving' })
    try {
      const res = await fetch(`/api/admin/services/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [col]: value, slug: forwarderSlug }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || res.statusText)
      }
      const j = await res.json()
      setItems((prev) => prev.map((s) => (s.id === item.id ? (j.service as AdditionalService) : s)))
      setCell(item.id, col, { status: 'saved' })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setCell(item.id, col, { status: 'error', error: msg })
    }
  }

  async function addRow(category: string) {
    setAdding(true)
    try {
      const res = await fetch('/api/admin/services', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          forwarder_id: forwarderId,
          category,
          service_name: '새 서비스',
          display_order: (byCategory.get(category)?.length ?? 0),
          slug: forwarderSlug,
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      const j = await res.json()
      setItems((prev) => [...prev, j.service as AdditionalService])
    } catch (e) {
      console.error(e)
      alert('추가 실패: ' + (e as Error).message)
    } finally {
      setAdding(false)
    }
  }

  async function deleteRow(item: AdditionalService) {
    if (!confirm(`"${item.service_name}"을(를) 삭제할까요?`)) return
    try {
      const res = await fetch(`/api/admin/services/${item.id}?slug=${forwarderSlug}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(await res.text())
      setItems((prev) => prev.filter((s) => s.id !== item.id))
    } catch (e) {
      alert('삭제 실패: ' + (e as Error).message)
    }
  }

  return (
    <div className="space-y-6">
      {presentCategories.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded p-4 text-sm text-amber-900">
          아직 등록된 서비스가 없습니다. 아래에서 카테고리를 선택해 추가하세요.
        </div>
      )}

      {presentCategories.map((cat) => {
        const rows = byCategory.get(cat) ?? []
        return (
          <div key={cat} className="bg-white border rounded-lg overflow-hidden">
            <div className="bg-gray-50 border-b px-4 py-2 flex items-center gap-3">
              <Badge className="bg-blue-600">{cat}</Badge>
              <span className="text-xs text-gray-500">{rows.length}개</span>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto h-7 text-xs"
                disabled={adding}
                onClick={() => addRow(cat)}
              >
                + 행 추가
              </Button>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 w-[200px]">서비스명</th>
                  <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 w-[160px]">가격 (원문)</th>
                  <th className="text-right px-3 py-1.5 text-xs font-semibold text-gray-500 w-[100px]">파싱값</th>
                  <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500">설명</th>
                  <th className="text-center px-3 py-1.5 text-xs font-semibold text-gray-500 w-[50px]">순서</th>
                  <th className="text-center px-3 py-1.5 text-xs font-semibold text-gray-500 w-[60px]">활성</th>
                  <th className="w-[40px]"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <Row key={item.id} item={item} cellStates={cellStates} save={saveField} remove={() => deleteRow(item)} />
                ))}
              </tbody>
            </table>
          </div>
        )
      })}

      {remainingCategories.length > 0 && (
        <div className="bg-white border rounded-lg p-4 flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-gray-700 mr-1">카테고리 추가:</span>
          <select
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            className="text-sm border rounded px-2 py-1"
          >
            <option value="">선택…</option>
            {remainingCategories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <Button
            size="sm"
            disabled={!newCategory || adding}
            onClick={() => {
              if (!newCategory) return
              addRow(newCategory)
              setNewCategory('')
            }}
          >
            + 첫 행 생성
          </Button>
        </div>
      )}
    </div>
  )
}

function Row({
  item,
  cellStates,
  save,
  remove,
}: {
  item: AdditionalService
  cellStates: CellState
  save: (item: AdditionalService, col: EditableCol, value: unknown) => void
  remove: () => void
}) {
  const status = (col: string) => cellStates[cellKey(item.id, col)]?.status
  const err = (col: string) => cellStates[cellKey(item.id, col)]?.error

  return (
    <tr className="border-b hover:bg-gray-50/50">
      <Cell>
        <input
          defaultValue={item.service_name}
          onBlur={(e) => {
            const v = e.target.value.trim()
            if (v !== item.service_name) save(item, 'service_name', v)
          }}
          className="w-full bg-transparent outline-none focus:bg-white focus:ring-1 focus:ring-blue-300 rounded px-1 py-0.5"
        />
        <StatusDot status={status('service_name')} err={err('service_name')} />
      </Cell>
      <Cell>
        <input
          defaultValue={item.price_text ?? ''}
          placeholder="예: 3,500원/박스"
          onBlur={(e) => {
            const v = e.target.value.trim()
            if (v !== (item.price_text ?? '')) save(item, 'price_text', v)
          }}
          className="w-full bg-transparent outline-none focus:bg-white focus:ring-1 focus:ring-blue-300 rounded px-1 py-0.5"
        />
        <StatusDot status={status('price_text')} err={err('price_text')} />
      </Cell>
      <td className="px-3 py-1.5 text-right font-mono text-xs text-gray-500 whitespace-nowrap">
        {item.price_numeric !== null ? (
          <>
            {Number(item.price_numeric).toLocaleString()}
            <span className="text-gray-400 ml-0.5">{item.price_currency || ''}</span>
          </>
        ) : (
          <span className="text-gray-300">—</span>
        )}
      </td>
      <Cell>
        <input
          defaultValue={item.description ?? ''}
          onBlur={(e) => {
            const v = e.target.value.trim()
            if (v !== (item.description ?? '')) save(item, 'description', v || null)
          }}
          className="w-full bg-transparent outline-none focus:bg-white focus:ring-1 focus:ring-blue-300 rounded px-1 py-0.5 text-xs text-gray-600"
        />
        <StatusDot status={status('description')} err={err('description')} />
      </Cell>
      <Cell center>
        <input
          type="number"
          defaultValue={item.display_order}
          onBlur={(e) => {
            const v = Number(e.target.value)
            if (v !== item.display_order) save(item, 'display_order', v)
          }}
          className="w-12 bg-transparent outline-none focus:bg-white focus:ring-1 focus:ring-blue-300 rounded px-1 py-0.5 text-center"
        />
      </Cell>
      <Cell center>
        <input
          type="checkbox"
          defaultChecked={item.is_active}
          onChange={(e) => save(item, 'is_active', e.target.checked)}
          className="cursor-pointer"
        />
      </Cell>
      <td className="px-2 py-1.5 text-right">
        <button
          onClick={remove}
          className="text-xs text-red-500 hover:text-red-700 hover:underline"
          title="삭제"
        >
          ✕
        </button>
      </td>
    </tr>
  )
}

function Cell({ children, center }: { children: React.ReactNode; center?: boolean }) {
  return (
    <td className={`px-3 py-1.5 ${center ? 'text-center' : ''} relative`}>{children}</td>
  )
}

function StatusDot({ status, err }: { status?: Status; err?: string }) {
  if (!status || status === 'idle') return null
  if (status === 'saving') return <span className="absolute right-1 top-1 text-[9px] text-blue-500">…</span>
  if (status === 'saved') return <span className="absolute right-1 top-1 text-[9px] text-green-600">✓</span>
  if (status === 'error') return <span className="absolute right-1 top-1 text-[9px] text-red-600" title={err}>✕</span>
  return null
}
