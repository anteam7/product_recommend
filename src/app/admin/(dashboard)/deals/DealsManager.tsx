'use client'

import { useState, useTransition, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  COMMON_COUNTRIES,
  SALE_EVENT_STATUS_LABEL,
  SALE_EVENT_STATUSES,
  countryLabel,
  saleEventPhase,
  type SaleEvent,
  type SaleEventInput,
  type SaleEventStatus,
} from '@/lib/deals'

type Msg = { type: 'success' | 'error' | 'info'; text: string }

export default function DealsManager({ initial }: { initial: SaleEvent[] }) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [msg, setMsg] = useState<Msg | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [filter, setFilter] = useState<SaleEventStatus | 'all'>('all')
  const [editing, setEditing] = useState<SaleEvent | 'new' | null>(null)

  const counts = useMemo(() => {
    const acc: Record<string, number> = { all: initial.length }
    for (const s of SALE_EVENT_STATUSES) acc[s] = 0
    for (const e of initial) acc[e.status] = (acc[e.status] ?? 0) + 1
    return acc
  }, [initial])

  const filtered = filter === 'all' ? initial : initial.filter((e) => e.status === filter)

  function refresh() {
    startTransition(() => router.refresh())
  }

  async function changeStatus(ev: SaleEvent, next: SaleEventStatus) {
    if (next === ev.status) return
    if (next === 'rejected' && !confirm(`"${ev.name}" 를 거부 상태로 바꿉니다.`)) return
    setBusyId(ev.id)
    try {
      const res = await fetch(`/api/admin/deals/${ev.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? '변경 실패')
      setMsg({ type: 'success', text: `상태 변경 완료 → ${SALE_EVENT_STATUS_LABEL[next].label}` })
      refresh()
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : '오류' })
    } finally {
      setBusyId(null)
    }
  }

  async function revalidatePublic() {
    setBusyId('revalidate')
    try {
      const res = await fetch('/api/admin/deals/revalidate', { method: 'POST' })
      if (!res.ok) throw new Error((await res.json()).error ?? '재검증 실패')
      setMsg({
        type: 'success',
        text: '프론트 캐시 재검증 요청 전송됨 — 몇 초 후 /deals 에서 최신 상태 확인',
      })
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : '오류' })
    } finally {
      setBusyId(null)
    }
  }

  async function refreshUrl(ev: SaleEvent) {
    setBusyId(ev.id)
    setMsg({ type: 'info', text: `"${ev.name}" URL AI 로 재탐색 중… (10~30초)` })
    try {
      const res = await fetch(`/api/admin/deals/${ev.id}/refresh-url`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'URL 갱신 실패')
      if (data.updated) {
        setMsg({ type: 'success', text: `URL 갱신: ${data.url}` })
      } else if (data.url) {
        setMsg({ type: 'info', text: `동일 URL — 변경 없음: ${data.url}` })
      } else {
        setMsg({ type: 'info', text: `적합한 URL 을 찾지 못함 — ${data.reason ?? 'NULL 유지'}` })
      }
      refresh()
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : '오류' })
    } finally {
      setBusyId(null)
    }
  }

  async function remove(ev: SaleEvent) {
    if (!confirm(`"${ev.name}" 를 영구 삭제합니다. 되돌릴 수 없습니다.`)) return
    setBusyId(ev.id)
    try {
      const res = await fetch(`/api/admin/deals/${ev.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error((await res.json()).error ?? '삭제 실패')
      setMsg({ type: 'success', text: '삭제됨' })
      refresh()
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : '오류' })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-4">
      {/* 필터 + 추가 */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex gap-1.5 flex-wrap">
          <FilterPill
            label={`전체 ${counts.all}`}
            active={filter === 'all'}
            onClick={() => setFilter('all')}
          />
          {SALE_EVENT_STATUSES.map((s) => (
            <FilterPill
              key={s}
              label={`${SALE_EVENT_STATUS_LABEL[s].label} ${counts[s] ?? 0}`}
              active={filter === s}
              onClick={() => setFilter(s)}
            />
          ))}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={revalidatePublic}
            disabled={busyId === 'revalidate'}
            title="/deals 와 홈 페이지 Vercel Edge Cache 강제 재검증"
          >
            {busyId === 'revalidate' ? '갱신 중…' : '🔄 프론트 캐시 갱신'}
          </Button>
          <Button
            onClick={() => setEditing('new')}
            className="bg-blue-600 hover:bg-blue-700"
          >
            + 새 이벤트
          </Button>
        </div>
      </div>

      {msg && (
        <div
          className={`text-xs rounded px-3 py-2 border ${
            msg.type === 'success'
              ? 'bg-green-50 border-green-100 text-green-700'
              : msg.type === 'error'
                ? 'bg-red-50 border-red-100 text-red-700'
                : 'bg-blue-50 border-blue-100 text-blue-700'
          }`}
        >
          {msg.text}
        </div>
      )}

      {/* 리스트 */}
      {filtered.length === 0 ? (
        <div className="text-sm text-gray-500 bg-white border rounded-lg p-8 text-center">
          {filter === 'all' ? '등록된 이벤트가 없습니다.' : '이 상태의 이벤트가 없습니다.'}
        </div>
      ) : (
        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                  상태
                </th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                  이벤트
                </th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                  국가
                </th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                  기간
                </th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                  출처
                </th>
                <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                  액션
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((ev) => {
                const phase = saleEventPhase(ev)
                const statusMeta = SALE_EVENT_STATUS_LABEL[ev.status]
                return (
                  <tr key={ev.id} className="border-b last:border-b-0 hover:bg-gray-50">
                    <td className="px-4 py-2">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded ${statusMeta.color}`}>
                        {statusMeta.label}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <div className="font-medium text-gray-900 truncate max-w-[320px] flex items-center gap-1.5">
                        <span className="truncate">{ev.name}</span>
                        {ev.external_url && (
                          <a
                            href={ev.external_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 text-xs text-blue-600 hover:underline"
                            title={ev.external_url}
                          >
                            ↗
                          </a>
                        )}
                      </div>
                      {ev.description && (
                        <div className="text-xs text-gray-500 truncate max-w-[320px]">
                          {ev.description}
                        </div>
                      )}
                      {(ev.external_url || ev.source_url) && (
                        <div className="text-[10px] text-gray-400 truncate max-w-[320px] mt-0.5 space-x-2">
                          {ev.external_url && (
                            <a
                              href={ev.external_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:underline"
                            >
                              공식: {ev.external_url.replace(/^https?:\/\//, '').slice(0, 45)}
                            </a>
                          )}
                          {ev.source_url && ev.source_url !== ev.external_url && (
                            <a
                              href={ev.source_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:underline"
                            >
                              출처: {ev.source_url.replace(/^https?:\/\//, '').slice(0, 35)}
                            </a>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs">{countryLabel(ev.country)}</td>
                    <td className="px-4 py-2 text-xs whitespace-nowrap">
                      {ev.start_at || '—'}
                      {ev.end_at && ev.end_at !== ev.start_at ? ` ~ ${ev.end_at}` : ''}
                      {phase !== 'undated' && (
                        <span
                          className={`ml-1.5 text-[10px] px-1 py-0.5 rounded ${
                            phase === 'ongoing'
                              ? 'bg-green-100 text-green-700'
                              : phase === 'upcoming'
                                ? 'bg-blue-100 text-blue-700'
                                : 'bg-gray-100 text-gray-500'
                          }`}
                        >
                          {phase === 'ongoing' ? '진행중' : phase === 'upcoming' ? '예정' : '종료'}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500">
                      {ev.source === 'ai_routine' ? '🤖 루틴' : '✍️ 수동'}
                      {ev.confidence != null && (
                        <span className="ml-1 text-[10px]">
                          ({(ev.confidence * 100).toFixed(0)}%)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap space-x-1">
                      {ev.status === 'suggested' && (
                        <button
                          onClick={() => changeStatus(ev, 'active')}
                          disabled={busyId === ev.id}
                          className="text-xs px-2 py-1 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                        >
                          승인
                        </button>
                      )}
                      {ev.status === 'active' && (
                        <button
                          onClick={() => changeStatus(ev, 'archived')}
                          disabled={busyId === ev.id}
                          className="text-xs px-2 py-1 rounded bg-gray-200 text-gray-700 hover:bg-gray-300 disabled:opacity-50"
                        >
                          보관
                        </button>
                      )}
                      {ev.status === 'archived' && (
                        <button
                          onClick={() => changeStatus(ev, 'active')}
                          disabled={busyId === ev.id}
                          className="text-xs px-2 py-1 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                          title="다시 게시"
                        >
                          재게시
                        </button>
                      )}
                      {ev.status === 'rejected' && (
                        <button
                          onClick={() => changeStatus(ev, 'suggested')}
                          disabled={busyId === ev.id}
                          className="text-xs px-2 py-1 rounded bg-amber-100 text-amber-800 hover:bg-amber-200 disabled:opacity-50"
                          title="제안 상태로 되돌려 재검토"
                        >
                          복구
                        </button>
                      )}
                      <button
                        onClick={() => refreshUrl(ev)}
                        disabled={busyId === ev.id}
                        className="text-xs px-2 py-1 rounded border hover:bg-gray-100 disabled:opacity-50"
                        title="AI 로 현재 열리는 URL 재탐색 (Gemini + Google Search)"
                      >
                        🔗 URL
                      </button>
                      <button
                        onClick={() => setEditing(ev)}
                        className="text-xs px-2 py-1 rounded border hover:bg-gray-100"
                      >
                        편집
                      </button>
                      <button
                        onClick={() => remove(ev)}
                        disabled={busyId === ev.id}
                        className="text-xs px-2 py-1 rounded text-red-600 hover:bg-red-50 disabled:opacity-50"
                      >
                        삭제
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <DealEditorModal
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            setMsg({ type: 'success', text: '저장되었습니다' })
            refresh()
          }}
        />
      )}
    </div>
  )
}

function FilterPill({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs px-3 py-1.5 rounded-full border ${
        active
          ? 'bg-blue-600 border-blue-600 text-white'
          : 'bg-white border-gray-300 text-gray-700 hover:border-blue-300'
      }`}
    >
      {label}
    </button>
  )
}

function DealEditorModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: SaleEvent | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<Partial<SaleEventInput>>(() => {
    if (!initial) {
      return {
        name: '',
        country: 'US',
        status: 'active',
        priority: 0,
        categories: [],
        recommended_forwarders: [],
        related_blog_tags: [],
      }
    }
    return {
      name: initial.name,
      country: initial.country,
      start_at: initial.start_at,
      end_at: initial.end_at,
      categories: initial.categories,
      description: initial.description,
      external_url: initial.external_url,
      recommended_forwarders: initial.recommended_forwarders,
      related_blog_tags: initial.related_blog_tags,
      priority: initial.priority,
      status: initial.status,
    }
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set<K extends keyof SaleEventInput>(k: K, v: SaleEventInput[K] | undefined) {
    setForm((p) => ({ ...p, [k]: v }))
  }

  async function save() {
    if (!form.name?.trim()) {
      setError('이름 필수')
      return
    }
    if (!form.country?.trim()) {
      setError('국가 필수')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const url = initial ? `/api/admin/deals/${initial.id}` : '/api/admin/deals'
      const method = initial ? 'PATCH' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? '저장 실패')
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : '오류')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-lg w-full max-w-2xl p-6 space-y-3 my-8">
        <h2 className="text-lg font-bold text-gray-900">
          {initial ? '세일 이벤트 편집' : '새 세일 이벤트'}
        </h2>

        <Field label="이름 *">
          <Input
            value={form.name ?? ''}
            onChange={(e) => set('name', e.target.value)}
            placeholder="예: Amazon Prime Day 2026"
          />
        </Field>

        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="국가 *">
            <select
              value={form.country}
              onChange={(e) => set('country', e.target.value)}
              className="w-full border rounded-md px-3 py-2 text-sm"
            >
              {COMMON_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.flag} {c.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="상태">
            <select
              value={form.status}
              onChange={(e) => set('status', e.target.value as SaleEventStatus)}
              className="w-full border rounded-md px-3 py-2 text-sm"
            >
              {SALE_EVENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {SALE_EVENT_STATUS_LABEL[s].label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="시작일 (YYYY-MM-DD)">
            <Input
              type="date"
              value={form.start_at ?? ''}
              onChange={(e) => set('start_at', e.target.value || null)}
            />
          </Field>
          <Field label="종료일 (YYYY-MM-DD)">
            <Input
              type="date"
              value={form.end_at ?? ''}
              onChange={(e) => set('end_at', e.target.value || null)}
            />
          </Field>
        </div>

        <Field label="카테고리 (쉼표로 구분)">
          <Input
            value={(form.categories ?? []).join(', ')}
            onChange={(e) =>
              set(
                'categories',
                e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
            placeholder="전자, 패션, 생활"
          />
        </Field>

        <Field label="설명 (할인율·주의사항)">
          <textarea
            value={form.description ?? ''}
            onChange={(e) => set('description', e.target.value)}
            rows={3}
            className="w-full border rounded-md p-2 text-sm"
          />
        </Field>

        <Field label="공식/참고 URL">
          <Input
            value={form.external_url ?? ''}
            onChange={(e) => set('external_url', e.target.value || null)}
            placeholder="https://..."
          />
        </Field>

        <Field label="추천 배대지 slug (쉼표)">
          <Input
            value={(form.recommended_forwarders ?? []).join(', ')}
            onChange={(e) =>
              set(
                'recommended_forwarders',
                e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
            placeholder="jimpass, malltail"
          />
        </Field>

        <Field label="관련 블로그 태그 (쉼표)">
          <Input
            value={(form.related_blog_tags ?? []).join(', ')}
            onChange={(e) =>
              set(
                'related_blog_tags',
                e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
            placeholder="블랙프라이데이, 관세"
          />
        </Field>

        <Field label="우선순위 (숫자)">
          <Input
            type="number"
            value={form.priority ?? 0}
            onChange={(e) => set('priority', Number(e.target.value))}
          />
        </Field>

        {error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-100 rounded px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            취소
          </Button>
          <Button onClick={save} disabled={saving} className="bg-blue-600 hover:bg-blue-700">
            {saving ? '저장 중…' : '저장'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium text-gray-700">{label}</label>
      {children}
    </div>
  )
}
