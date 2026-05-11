'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

interface QueueRow {
  id: string
  status: string
  requested_at: string
  started_at: string | null
  finished_at: string | null
  fetched_count: number | null
  inserted_count: number | null
  error_message: string | null
}

export default function RefreshButton({ initialActive }: { initialActive: QueueRow | null }) {
  const router = useRouter()
  const [active, setActive] = useState<QueueRow | null>(initialActive)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!active || (active.status !== 'pending' && active.status !== 'running')) return
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/admin/trend-radar/ggsan/queue-status?id=${active.id}`)
        const json = await res.json()
        if (json.row) {
          setActive(json.row)
          if (json.row.status === 'done' || json.row.status === 'error') {
            // 완료 — 페이지 새로고침해서 새 데이터 반영
            setTimeout(() => router.refresh(), 1500)
          }
        }
      } catch {}
    }, 5000)
    return () => clearInterval(timer)
  }, [active?.id, active?.status, router])

  const trigger = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/trend-radar/ggsan/refresh', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)

      // 즉시 상태 갱신 (queue row 만들어졌으니 polling 시작)
      const statusRes = await fetch(`/api/admin/trend-radar/ggsan/queue-status?id=${json.queueId}`)
      const statusJson = await statusRes.json()
      if (statusJson.row) setActive(statusJson.row)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const isActive = active && (active.status === 'pending' || active.status === 'running')
  let label = '카탈로그 갱신'
  if (submitting) label = '요청 중…'
  else if (active?.status === 'pending') label = '대기 중 (다음 분에 시작)'
  else if (active?.status === 'running') label = '갱신 중… (~3분)'

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={trigger}
        disabled={submitting || !!isActive}
        className={`px-4 py-2 text-sm rounded font-medium ${
          isActive
            ? 'bg-amber-100 text-amber-700 cursor-not-allowed'
            : 'bg-black text-white hover:bg-gray-800'
        }`}
      >
        {label}
      </button>

      {active && (
        <div className="text-xs text-gray-500">
          {active.status === 'done' && (
            <>
              ✅ 완료 · fetched={active.fetched_count} inserted={active.inserted_count}
              {active.finished_at && ` · ${active.finished_at.slice(11, 16)}`}
            </>
          )}
          {active.status === 'error' && (
            <span className="text-red-600">
              ❌ {active.error_message?.slice(0, 80) ?? 'error'}
            </span>
          )}
          {(active.status === 'pending' || active.status === 'running') && (
            <>
              요청 {active.requested_at.slice(11, 16)} ·{' '}
              {active.status === 'running' && active.started_at
                ? `시작 ${active.started_at.slice(11, 16)}, 진행 중...`
                : 'WSL polling 대기 (매분)'}
            </>
          )}
        </div>
      )}

      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  )
}
