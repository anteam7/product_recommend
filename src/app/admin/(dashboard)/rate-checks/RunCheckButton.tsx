'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

const CHUNK_SIZE = 3

type Phase = 'idle' | 'starting' | 'running' | 'finishing' | 'done' | 'error'

export default function RunCheckButton() {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [message, setMessage] = useState<string>('')

  async function api<T>(body: Record<string, unknown>): Promise<T> {
    const res = await fetch('/api/admin/rate-check/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    let data: { ok?: boolean; error?: string } & T
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`응답 파싱 실패 (${res.status}): ${text.slice(0, 120)}`)
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `HTTP ${res.status}`)
    }
    return data
  }

  async function handleClick() {
    if (phase === 'starting' || phase === 'running' || phase === 'finishing') return
    if (!confirm('25곳 배대지 요금 페이지를 AI로 스캔합니다. 3~5분 소요됩니다.')) return

    setPhase('starting')
    setMessage('')
    setProgress(null)

    try {
      const { run_id, forwarder_ids } = await api<{
        run_id: string
        forwarder_ids: string[]
      }>({ action: 'start' })

      setProgress({ done: 0, total: forwarder_ids.length })
      setPhase('running')

      for (let i = 0; i < forwarder_ids.length; i += CHUNK_SIZE) {
        const chunk = forwarder_ids.slice(i, i + CHUNK_SIZE)
        try {
          await api({ action: 'chunk', run_id, forwarder_ids: chunk })
        } catch (err) {
          // 청크 실패해도 다음 청크는 시도 (결과 행 insert 실패한 경우만. fetch/AI 실패는 내부에서 status=error로 저장됨)
          console.warn(`청크 실패 (index ${i}):`, err)
        }
        setProgress({ done: Math.min(i + chunk.length, forwarder_ids.length), total: forwarder_ids.length })
      }

      setPhase('finishing')
      const summary = await api<{
        total: number
        extracted: number
        no_rates_found: number
        error: number
        skipped: number
        total_rates_extracted: number
      }>({ action: 'finish', run_id })

      setPhase('done')
      setMessage(
        `완료 — 추출 ${summary.extracted}곳 / 요금없음 ${summary.no_rates_found} / 오류 ${summary.error} / 생략 ${summary.skipped} · 총 ${summary.total_rates_extracted.toLocaleString()}건`,
      )
      router.refresh()
    } catch (err) {
      setPhase('error')
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const busy = phase === 'starting' || phase === 'running' || phase === 'finishing'
  const label =
    phase === 'starting'
      ? '시작 중…'
      : phase === 'running' && progress
      ? `스캔 중 ${progress.done}/${progress.total}`
      : phase === 'finishing'
      ? '집계 중…'
      : '지금 스캔'

  return (
    <div className="flex flex-col items-end gap-2">
      <Button onClick={handleClick} disabled={busy} className="bg-blue-600 hover:bg-blue-700">
        {label}
      </Button>
      {progress && busy && (
        <div className="w-64 bg-gray-200 rounded-full h-1.5 overflow-hidden">
          <div
            className="bg-blue-600 h-full transition-all"
            style={{
              width: `${Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%`,
            }}
          />
        </div>
      )}
      {message && (
        <p
          className={`text-xs px-3 py-1.5 rounded border max-w-lg text-right ${
            phase === 'error'
              ? 'text-red-700 bg-red-50 border-red-100'
              : 'text-green-700 bg-green-50 border-green-100'
          }`}
        >
          {message}
        </p>
      )}
    </div>
  )
}
