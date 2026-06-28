'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

type Instruction = {
  id: string
  title: string | null
  status: string
  priority: number | null
  created_by: string | null
  created_at: string
  started_at: string | null
  ended_at: string | null
  result: string | null
  error: string | null
  instruction?: string
}
type Evt = { id: string; role: string; type: string; content: string | null; created_at: string }

const STATUS: Record<string, { label: string; cls: string }> = {
  queued: { label: '대기', cls: 'bg-gray-100 text-gray-600' },
  running: { label: '실행중', cls: 'bg-blue-100 text-blue-700 animate-pulse' },
  escalated: { label: '⚠ 확인 필요', cls: 'bg-amber-100 text-amber-800' },
  resuming: { label: '재개중', cls: 'bg-blue-100 text-blue-700 animate-pulse' },
  done: { label: '✓ 완료', cls: 'bg-green-100 text-green-700' },
  failed: { label: '✗ 실패', cls: 'bg-red-100 text-red-700' },
  cancelled: { label: '취소', cls: 'bg-gray-100 text-gray-400' },
}
const ACTIVE = new Set(['queued', 'running', 'escalated', 'resuming'])
const Badge = ({ s }: { s: string }) => { const m = STATUS[s] ?? { label: s, cls: 'bg-gray-100 text-gray-600' }; return <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${m.cls}`}>{m.label}</span> }
const fmt = (t?: string | null) => (t ? new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')

export default function WorkConsole() {
  const [items, setItems] = useState<Instruction[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ instruction: Instruction; events: Evt[] } | null>(null)
  const [text, setText] = useState('')
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const threadRef = useRef<HTMLDivElement>(null)

  const loadList = useCallback(async () => {
    try { const r = await fetch('/api/admin/work-instructions', { cache: 'no-store' }); const j = await r.json(); if (Array.isArray(j.items)) setItems(j.items) } catch { /* noop */ }
  }, [])
  const loadDetail = useCallback(async (id: string) => {
    try { const r = await fetch(`/api/admin/work-instructions/${id}`, { cache: 'no-store' }); const j = await r.json(); if (j.instruction) setDetail({ instruction: j.instruction, events: j.events ?? [] }) } catch { /* noop */ }
  }, [])

  useEffect(() => { loadList() }, [loadList])
  useEffect(() => { // 3초 폴링
    const t = setInterval(() => { loadList(); if (sel) loadDetail(sel) }, 3000)
    return () => clearInterval(t)
  }, [sel, loadList, loadDetail])
  useEffect(() => { if (sel) loadDetail(sel) }, [sel, loadDetail])
  useEffect(() => { if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight }, [detail])

  async function submit() {
    const instruction = text.trim(); if (!instruction || busy) return
    setBusy(true)
    try {
      const r = await fetch('/api/admin/work-instructions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction }) })
      const j = await r.json()
      if (j.ok) { setText(''); await loadList(); setSel(j.id) } else alert(j.error || '등록 실패')
    } finally { setBusy(false) }
  }
  async function sendReply() {
    if (!sel) return; const body = reply.trim(); if (!body || busy) return
    setBusy(true)
    try { const r = await fetch(`/api/admin/work-instructions/${sel}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reply: body }) }); const j = await r.json(); if (j.ok) { setReply(''); await loadDetail(sel) } else alert(j.error || '답변 실패') } finally { setBusy(false) }
  }
  async function cancel(id: string) {
    if (!confirm('이 작업을 취소할까요?')) return
    await fetch(`/api/admin/work-instructions/${id}/cancel`, { method: 'POST' }); await loadList(); if (sel) loadDetail(sel)
  }

  const escCount = items.filter((i) => i.status === 'escalated').length

  // 상세 보기
  if (sel && detail) {
    const ins = detail.instruction
    return (
      <div className="space-y-3">
        <button onClick={() => setSel(null)} className="text-sm text-gray-600 hover:text-black">← 목록</button>
        <div className="rounded border border-gray-200 p-3 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold break-words">{ins.title || ins.instruction?.slice(0, 60)}</div>
            <div className="text-xs text-gray-400 mt-0.5">{fmt(ins.created_at)} · {ins.created_by}</div>
          </div>
          <Badge s={ins.status} />
        </div>
        <div ref={threadRef} className="space-y-2 max-h-[55vh] overflow-y-auto rounded border border-gray-100 bg-gray-50 p-3">
          {detail.events.map((e) => <EventBubble key={e.id} e={e} />)}
          {detail.events.length === 0 && <div className="text-xs text-gray-400 text-center py-6">아직 진행 내역이 없습니다…</div>}
        </div>
        {ins.status === 'escalated' && (
          <div className="rounded border border-amber-300 bg-amber-50 p-3 space-y-2">
            <div className="text-xs font-semibold text-amber-800">⚠ 에이전트가 확인을 기다립니다 — 답변하면 재개됩니다</div>
            <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={2} placeholder="답변/지시 입력…" className="w-full text-sm rounded border border-amber-200 p-2 resize-none" />
            <button onClick={sendReply} disabled={busy || !reply.trim()} className="w-full bg-amber-600 text-white text-sm font-semibold py-2 rounded disabled:opacity-50">답변 보내고 재개</button>
          </div>
        )}
        {ACTIVE.has(ins.status) && ins.status !== 'escalated' && (
          <button onClick={() => cancel(ins.id)} className="text-xs text-red-500 hover:text-red-700">작업 취소</button>
        )}
      </div>
    )
  }

  // 목록 + 입력
  return (
    <div className="space-y-4">
      <div className="rounded border border-gray-200 p-3 space-y-2">
        <div className="text-sm font-semibold">새 작업 지시</div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="예: 도매매 인기상품 중 쿠팡 마진 20% 넘는 후보 10개 추려서 보고해줘" className="w-full text-sm rounded border border-gray-200 p-2 resize-none" />
        <button onClick={submit} disabled={busy || !text.trim()} className="w-full bg-blue-600 text-white text-sm font-semibold py-2 rounded disabled:opacity-50">{busy ? '등록 중…' : '지시 보내기'}</button>
      </div>

      {escCount > 0 && <div className="rounded bg-amber-50 border border-amber-200 text-amber-800 text-xs px-3 py-2">⚠ 확인 필요한 작업 {escCount}건 — 아래 목록에서 답변하세요</div>}

      <div className="space-y-2">
        {items.length === 0 && <div className="text-sm text-gray-400 text-center py-8">아직 작업이 없습니다. 위에 지시를 입력하세요.</div>}
        {items.map((i) => (
          <button key={i.id} onClick={() => setSel(i.id)} className={`w-full text-left rounded border p-3 hover:bg-gray-50 transition-colors ${i.status === 'escalated' ? 'border-amber-300 bg-amber-50/40' : 'border-gray-200'}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-medium truncate">{i.title || '(제목 없음)'}</div>
              <Badge s={i.status} />
            </div>
            <div className="text-[11px] text-gray-400 mt-1">{fmt(i.created_at)}{i.result ? ` · ${i.result.slice(0, 50)}` : ''}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

function EventBubble({ e }: { e: Evt }) {
  const isUser = e.role === 'user'
  const isEsc = e.type === 'escalation'
  const isResult = e.type === 'result'
  const cls = isUser
    ? 'bg-blue-600 text-white ml-8'
    : isEsc
      ? 'bg-amber-100 text-amber-900 border border-amber-300'
      : isResult
        ? 'bg-green-50 text-green-900 border border-green-200'
        : e.role === 'system'
          ? 'bg-transparent text-gray-400 text-[11px] text-center'
          : 'bg-white text-gray-700 border border-gray-200'
  if (e.role === 'system') return <div className="text-[11px] text-gray-400 text-center py-0.5">{e.content}</div>
  return (
    <div className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words ${cls}`}>
      {isEsc && <div className="text-[10px] font-bold mb-0.5">⚠ 확인 요청</div>}
      {e.content}
    </div>
  )
}
