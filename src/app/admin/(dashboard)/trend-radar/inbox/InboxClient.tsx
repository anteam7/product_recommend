'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

export interface CategoryOption {
  key: string        // '1'..'9'
  code: string       // 'health' | 'living' | ...
  label: string
}

export interface InboxCard {
  id: string
  canonical_name: string
  category_top: string | null
  category_mid: string | null
  intent_label: string | null
  description: string | null
  brand: string | null
  alias_count: number
  llm_classified_at: string | null
  llm_model: string | null
  last_seen_at: string
  aliases: { alias: string; source: string | null; confidence: number }[]
  top_source: string | null
}

type Status = 'classified' | 'pinned' | 'rejected' | 'snoozed' | 'note'

interface ApplyPayload {
  product_id: string
  status: Status
  category_top?: string | null
  category_mid?: string | null
  intent_label?: string | null
  note?: string | null
  snooze_days?: number | null
}

export default function InboxClient({
  initialCards,
  totalPending,
  todayDone,
  categoryOptions,
}: {
  initialCards: InboxCard[]
  totalPending: number
  todayDone: number
  categoryOptions: CategoryOption[]
}) {
  const router = useRouter()
  const [cards] = useState<InboxCard[]>(initialCards)
  const [idx, setIdx] = useState(0)
  const [processedIds, setProcessedIds] = useState<Set<string>>(new Set())
  const [sessionCount, setSessionCount] = useState(0)
  const [sessionStart] = useState<number>(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [lastAction, setLastAction] = useState<string | null>(null)
  const [noteModal, setNoteModal] = useState<{ open: boolean; value: string }>({ open: false, value: '' })
  const [error, setError] = useState<string | null>(null)
  const swipeStart = useRef<{ x: number; y: number } | null>(null)

  const current = cards[idx]

  const apply = useCallback(
    async (payload: ApplyPayload, label: string, advance = true) => {
      setBusy(true)
      setError(null)
      try {
        const res = await fetch('/api/admin/trend-radar/inbox/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)

        setProcessedIds((s) => {
          const n = new Set(s)
          n.add(payload.product_id)
          return n
        })
        setSessionCount((c) => c + 1)
        setLastAction(label)
        if (advance) {
          setIdx((i) => Math.min(i + 1, cards.length))
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [cards.length]
  )

  const next = useCallback(() => {
    setIdx((i) => Math.min(i + 1, cards.length))
  }, [cards.length])
  const prev = useCallback(() => {
    setIdx((i) => Math.max(i - 1, 0))
  }, [])

  const pickCategory = useCallback(
    (opt: CategoryOption) => {
      if (!current) return
      void apply(
        {
          product_id: current.id,
          status: 'classified',
          category_top: opt.code,
          category_mid: current.category_mid ?? null,
          intent_label: current.intent_label ?? null,
        },
        `분류 → ${opt.label}`
      )
    },
    [apply, current]
  )

  const acceptLlm = useCallback(() => {
    if (!current) return
    if (!current.llm_classified_at) {
      setError('LLM 추정값 없음 — 카테고리 키(1~9)로 직접 분류하세요.')
      return
    }
    void apply(
      {
        product_id: current.id,
        status: 'classified',
        category_top: current.category_top,
        category_mid: current.category_mid,
        intent_label: current.intent_label,
      },
      'LLM 추정 수용'
    )
  }, [apply, current])

  const pin = useCallback(() => {
    if (!current) return
    void apply(
      {
        product_id: current.id,
        status: 'pinned',
        category_top: current.category_top,
        category_mid: current.category_mid,
        intent_label: current.intent_label,
      },
      '핀'
    )
  }, [apply, current])

  const reject = useCallback(() => {
    if (!current) return
    void apply({ product_id: current.id, status: 'rejected' }, '거부')
  }, [apply, current])

  const snooze = useCallback(() => {
    if (!current) return
    void apply(
      { product_id: current.id, status: 'snoozed', snooze_days: 7 },
      '스누즈 7d'
    )
  }, [apply, current])

  const submitNote = useCallback(() => {
    if (!current) return
    const note = noteModal.value.trim()
    if (!note) {
      setNoteModal({ open: false, value: '' })
      return
    }
    void apply(
      { product_id: current.id, status: 'note', note },
      '메모',
      false // 메모만은 advance 안 함
    )
    setNoteModal({ open: false, value: '' })
  }, [apply, current, noteModal.value])

  useEffect(() => {
    if (noteModal.open) return
    function onKey(e: KeyboardEvent) {
      if (busy) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const k = e.key.toLowerCase()
      if (k === 'j' || k === 'arrowright') { e.preventDefault(); next(); return }
      if (k === 'k' || k === 'arrowleft')  { e.preventDefault(); prev(); return }
      if (k === 'p') { e.preventDefault(); pin(); return }
      if (k === 'x') { e.preventDefault(); reject(); return }
      if (k === 's') { e.preventDefault(); snooze(); return }
      if (k === 'a') { e.preventDefault(); acceptLlm(); return }
      if (k === 'n') {
        e.preventDefault()
        setNoteModal({ open: true, value: '' })
        return
      }
      // 카테고리 1~9
      const opt = categoryOptions.find((o) => o.key === e.key)
      if (opt) { e.preventDefault(); pickCategory(opt); return }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, next, prev, pin, reject, snooze, acceptLlm, pickCategory, categoryOptions, noteModal.open])

  // 스와이프: 좌=다음, 우=이전
  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0]
    swipeStart.current = { x: t.clientX, y: t.clientY }
  }
  function onTouchEnd(e: React.TouchEvent) {
    const start = swipeStart.current
    if (!start) return
    const t = e.changedTouches[0]
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    swipeStart.current = null
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy)) return
    if (dx < 0) next()
    else prev()
  }

  const minutesElapsed = Math.max((Date.now() - sessionStart) / 60000, 0.001)
  const cardsPerMin = (sessionCount / minutesElapsed).toFixed(1)
  const remainingInQueue = cards.length - idx
  const liveTotalPending = Math.max(totalPending - processedIds.size, 0)

  if (cards.length === 0) {
    return (
      <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
        <p className="text-base font-medium">미분류 시그널이 비어있습니다 🎉</p>
        <p className="text-sm mt-2">classify_trends_llm cron 이 다음 신호를 채우면 다시 노출됩니다.</p>
      </div>
    )
  }

  if (idx >= cards.length) {
    return (
      <div className="space-y-4">
        <HeaderStats
          remaining={liveTotalPending}
          todayDone={todayDone + sessionCount}
          sessionCount={sessionCount}
          cardsPerMin={cardsPerMin}
        />
        <div className="rounded border border-dashed border-gray-300 p-12 text-center">
          <p className="text-lg font-semibold">이번 배치 완료 — {sessionCount}건 처리</p>
          <p className="text-sm text-gray-500 mt-2">
            남은 미분류 약 {liveTotalPending}건. 새 배치를 받으려면 새로고침.
          </p>
          <button
            onClick={() => router.refresh()}
            className="mt-4 px-4 py-2 text-sm bg-black text-white rounded hover:bg-gray-800"
          >
            새 배치 불러오기
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <HeaderStats
        remaining={liveTotalPending}
        todayDone={todayDone + sessionCount}
        sessionCount={sessionCount}
        cardsPerMin={cardsPerMin}
      />

      <div className="text-xs text-gray-500 flex justify-between">
        <span>이번 배치 {idx + 1} / {cards.length} · 잔여 {remainingInQueue}</span>
        {lastAction && <span className="text-emerald-700">마지막: {lastAction}</span>}
        {error && <span className="text-red-600">{error}</span>}
      </div>

      <Card card={current!} options={categoryOptions} onCategoryClick={pickCategory} />

      <ActionBar
        options={categoryOptions}
        onCategory={pickCategory}
        onAcceptLlm={acceptLlm}
        onPin={pin}
        onReject={reject}
        onSnooze={snooze}
        onNote={() => setNoteModal({ open: true, value: '' })}
        onNext={next}
        onPrev={prev}
        busy={busy}
        hasLlm={!!current?.llm_classified_at}
      />

      {noteModal.open && (
        <NoteModal
          value={noteModal.value}
          onChange={(v) => setNoteModal({ open: true, value: v })}
          onCancel={() => setNoteModal({ open: false, value: '' })}
          onSubmit={submitNote}
        />
      )}
    </div>
  )
}

function HeaderStats({
  remaining,
  todayDone,
  sessionCount,
  cardsPerMin,
}: {
  remaining: number
  todayDone: number
  sessionCount: number
  cardsPerMin: string
}) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Stat label="잔여 미분류" value={remaining} hint="전체" />
      <Stat label="오늘 처리" value={todayDone} hint={`이번 세션 +${sessionCount}`} />
      <Stat label="이번 세션" value={sessionCount} hint="처리 카드" />
      <Stat label="cards/min" value={cardsPerMin} hint="현재 속도" />
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="rounded border border-gray-200 p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
      {hint && <div className="text-xs text-gray-400 mt-1">{hint}</div>}
    </div>
  )
}

function Card({
  card,
  options,
  onCategoryClick,
}: {
  card: InboxCard
  options: CategoryOption[]
  onCategoryClick: (o: CategoryOption) => void
}) {
  return (
    <div className="rounded-lg border border-gray-300 bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <h2 className="text-2xl font-bold break-words">{card.canonical_name}</h2>
          <p className="text-sm text-gray-500 mt-1">
            {card.brand ? <span className="font-medium text-black">{card.brand}</span> : null}
            {card.brand ? ' · ' : ''}
            alias {card.alias_count}건 · 최근 {card.last_seen_at?.slice(0, 10)}
            {card.top_source ? ` · top source: ${card.top_source}` : ''}
          </p>
        </div>
        <span
          className={`text-xs px-2 py-0.5 rounded font-mono ${
            card.llm_classified_at
              ? 'bg-blue-50 text-blue-700 border border-blue-200'
              : 'bg-gray-100 text-gray-500'
          }`}
        >
          {card.llm_classified_at
            ? `LLM 추정 ${card.llm_model ?? ''}`
            : 'LLM 추정 없음'}
        </span>
      </div>

      {/* LLM 미리 채워둔 카테고리·intent */}
      <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
        <PreFill label="category_top" value={card.category_top ?? '—'} />
        <PreFill label="category_mid" value={card.category_mid ?? '—'} />
        <PreFill label="intent_label" value={card.intent_label ?? '—'} />
      </div>

      {card.description && (
        <p className="mt-3 text-sm text-gray-700 border-l-2 border-gray-200 pl-3">
          {card.description}
        </p>
      )}

      {/* 카테고리 픽 (1~9) — 데스크탑 키, 모바일/마우스 클릭 둘 다 */}
      <div className="mt-5">
        <div className="text-xs text-gray-500 mb-2">카테고리 (1~9)</div>
        <div className="flex flex-wrap gap-2">
          {options.map((o) => (
            <button
              key={o.key}
              onClick={() => onCategoryClick(o)}
              className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-black hover:text-white transition-colors"
            >
              <span className="font-mono text-xs text-gray-500 mr-1">{o.key}</span>
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {/* alias 미니 프리뷰 (최근 3개) */}
      <div className="mt-5">
        <div className="text-xs text-gray-500 mb-2">최근 alias 3개</div>
        {card.aliases.length === 0 ? (
          <div className="text-xs text-gray-400">매핑된 alias 없음</div>
        ) : (
          <ul className="space-y-1">
            {card.aliases.map((a, i) => (
              <li key={i} className="text-sm flex justify-between gap-3">
                <span className="truncate">{a.alias}</span>
                <span className="text-xs text-gray-500 font-mono shrink-0">
                  {a.source ?? '—'} · {a.confidence.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function PreFill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-dashed border-gray-300 px-3 py-2">
      <div className="text-[10px] text-gray-400 uppercase font-mono">{label}</div>
      <div className="text-sm mt-0.5">{value}</div>
    </div>
  )
}

function ActionBar({
  options,
  onCategory,
  onAcceptLlm,
  onPin,
  onReject,
  onSnooze,
  onNote,
  onNext,
  onPrev,
  busy,
  hasLlm,
}: {
  options: CategoryOption[]
  onCategory: (o: CategoryOption) => void
  onAcceptLlm: () => void
  onPin: () => void
  onReject: () => void
  onSnooze: () => void
  onNote: () => void
  onNext: () => void
  onPrev: () => void
  busy: boolean
  hasLlm: boolean
}) {
  void options
  void onCategory
  return (
    <div className="flex flex-wrap gap-2 text-sm">
      <ActionBtn label="◀ K" onClick={onPrev} disabled={busy} />
      <ActionBtn label="J ▶" onClick={onNext} disabled={busy} />
      <ActionBtn label="A · LLM수용" onClick={onAcceptLlm} disabled={busy || !hasLlm} variant="primary" />
      <ActionBtn label="P · 핀" onClick={onPin} disabled={busy} variant="warn" />
      <ActionBtn label="X · 거부" onClick={onReject} disabled={busy} variant="danger" />
      <ActionBtn label="S · 스누즈 7d" onClick={onSnooze} disabled={busy} />
      <ActionBtn label="N · 메모" onClick={onNote} disabled={busy} />
    </div>
  )
}

function ActionBtn({
  label,
  onClick,
  disabled,
  variant,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  variant?: 'primary' | 'warn' | 'danger'
}) {
  const cls =
    variant === 'primary'
      ? 'bg-black text-white hover:bg-gray-800'
      : variant === 'warn'
      ? 'bg-amber-100 text-amber-800 hover:bg-amber-200'
      : variant === 'danger'
      ? 'bg-red-100 text-red-800 hover:bg-red-200'
      : 'bg-gray-100 text-gray-800 hover:bg-gray-200'
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-2 rounded font-medium ${cls} disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {label}
    </button>
  )
}

function NoteModal({
  value,
  onChange,
  onCancel,
  onSubmit,
}: {
  value: string
  onChange: (v: string) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg p-5 w-[min(480px,90vw)] shadow-xl">
        <h3 className="text-sm font-semibold mb-2">메모 추가</h3>
        <textarea
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onCancel()
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              onSubmit()
            }
          }}
          placeholder="이 시그널에 대한 운영자 메모 — Ctrl/⌘+Enter 저장"
          className="w-full h-32 border border-gray-300 rounded p-2 text-sm focus:outline-none focus:border-black"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50"
          >
            취소 (Esc)
          </button>
          <button
            onClick={onSubmit}
            className="px-3 py-1.5 text-sm rounded bg-black text-white hover:bg-gray-800"
          >
            저장 (⌘/Ctrl+Enter)
          </button>
        </div>
      </div>
    </div>
  )
}
