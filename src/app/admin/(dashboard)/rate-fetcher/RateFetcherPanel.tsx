'use client'

import { useState } from 'react'

export type SiteEntry = {
  slug: string
  name: string
  isPlaywright: boolean
  sourceCount: number
  lastFetchedAt: string | null
  lastStatus: string | null
}

type RowResult = {
  status: 'idle' | 'running' | 'ok' | 'partial' | 'error' | 'skipped'
  parsed?: number
  inserted?: number
  durationMs?: number
  error?: string
}

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const now = Date.now()
  const diffMs = now - d.getTime()
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return '방금 전'
  if (minutes < 60) return `${minutes}분 전`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}시간 전`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}일 전`
  return d.toLocaleDateString('ko-KR')
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-xs text-gray-400">—</span>
  const cls =
    status === 'ok'
      ? 'bg-green-100 text-green-700'
      : status === 'partial'
        ? 'bg-amber-100 text-amber-700'
        : status === 'error'
          ? 'bg-rose-100 text-rose-700'
          : status === 'running'
            ? 'bg-blue-100 text-blue-700'
            : status === 'skipped'
              ? 'bg-gray-100 text-gray-600'
              : 'bg-gray-100 text-gray-600'
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{status}</span>
  )
}

export default function RateFetcherPanel({ sites }: { sites: SiteEntry[] }) {
  const [rows, setRows] = useState<Record<string, RowResult>>({})
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchSummary, setBatchSummary] = useState<string | null>(null)

  async function runOne(slug: string) {
    setRows((r) => ({ ...r, [slug]: { status: 'running' } }))
    try {
      const res = await fetch('/api/admin/rate-fetcher', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      })
      const data = await res.json()
      if (!res.ok) {
        setRows((r) => ({ ...r, [slug]: { status: 'error', error: data.error ?? `HTTP ${res.status}` } }))
        return
      }
      const result = data.result as {
        status: RowResult['status']
        parsed: number
        inserted: number
        durationMs: number
        error?: string
      }
      setRows((r) => ({
        ...r,
        [slug]: {
          status: result.status,
          parsed: result.parsed,
          inserted: result.inserted,
          durationMs: result.durationMs,
          error: result.error,
        },
      }))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setRows((r) => ({ ...r, [slug]: { status: 'error', error: msg } }))
    }
  }

  async function runAll() {
    if (!confirm('비-Playwright 21개 사이트를 일괄 갱신합니다 (약 1~2분 소요). 계속하시겠습니까?')) return
    setBatchRunning(true)
    setBatchSummary(null)
    // 모두 running 표시
    const init: Record<string, RowResult> = {}
    for (const s of sites) {
      if (!s.isPlaywright) init[s.slug] = { status: 'running' }
    }
    setRows((r) => ({ ...r, ...init }))

    try {
      const res = await fetch('/api/admin/rate-fetcher', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      })
      const data = await res.json()
      if (!res.ok) {
        setBatchSummary(`실패: ${data.error ?? `HTTP ${res.status}`}`)
        return
      }
      const update: Record<string, RowResult> = {}
      for (const r of data.results as Array<{
        slug: string
        status: RowResult['status']
        parsed: number
        inserted: number
        durationMs: number
        error?: string
      }>) {
        update[r.slug] = {
          status: r.status,
          parsed: r.parsed,
          inserted: r.inserted,
          durationMs: r.durationMs,
          error: r.error,
        }
      }
      setRows((prev) => ({ ...prev, ...update }))
      const s = data.summary as { ok: number; partial: number; error: number; skipped: number; total_inserted: number }
      setBatchSummary(
        `완료: ok=${s.ok} / partial=${s.partial} / error=${s.error} / skipped=${s.skipped} — 총 ${s.total_inserted}행 적재`,
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setBatchSummary(`실패: ${msg}`)
    } finally {
      setBatchRunning(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-white border rounded-lg p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-gray-900">전체 갱신</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              비-Playwright {sites.filter((s) => !s.isPlaywright).length}개 사이트를 직렬로 갱신합니다.
            </p>
          </div>
          <button
            onClick={runAll}
            disabled={batchRunning}
            className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {batchRunning ? '갱신 중…' : '전체 갱신'}
          </button>
        </div>
        {batchSummary && (
          <div className="mt-3 px-3 py-2 rounded bg-gray-50 text-sm text-gray-700">{batchSummary}</div>
        )}
      </div>

      <div className="bg-white border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="text-left px-4 py-2 font-medium">사이트</th>
              <th className="text-left px-4 py-2 font-medium">소스</th>
              <th className="text-left px-4 py-2 font-medium">마지막 갱신</th>
              <th className="text-left px-4 py-2 font-medium">상태</th>
              <th className="text-left px-4 py-2 font-medium">결과</th>
              <th className="text-right px-4 py-2 font-medium">작업</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {sites.map((s) => {
              const row = rows[s.slug]
              const displayStatus = row?.status ?? s.lastStatus
              const summary = row
                ? row.status === 'running'
                  ? '실행 중…'
                  : row.status === 'error' || row.status === 'skipped'
                    ? row.error ?? ''
                    : `${row.parsed ?? 0} → ${row.inserted ?? 0}행${row.durationMs != null ? ` · ${(row.durationMs / 1000).toFixed(1)}s` : ''}${row.error ? ` · ${row.error}` : ''}`
                : ''
              return (
                <tr key={s.slug}>
                  <td className="px-4 py-2">
                    <div className="font-medium text-gray-900">{s.name}</div>
                    <div className="text-xs text-gray-500 font-mono">{s.slug}</div>
                  </td>
                  <td className="px-4 py-2 text-gray-700">{s.sourceCount}</td>
                  <td className="px-4 py-2 text-gray-700">{formatTime(s.lastFetchedAt)}</td>
                  <td className="px-4 py-2"><StatusBadge status={displayStatus} /></td>
                  <td className="px-4 py-2 text-xs text-gray-600">{summary}</td>
                  <td className="px-4 py-2 text-right">
                    {s.isPlaywright ? (
                      <span
                        className="text-xs text-gray-400"
                        title={`Playwright 의존 — Vercel 서버리스에서 동작 불가. CLI 에서 실행:\nnpx tsx scripts/run-rate-fetcher.ts --slug ${s.slug}`}
                      >
                        CLI 전용
                      </span>
                    ) : (
                      <button
                        onClick={() => runOne(s.slug)}
                        disabled={row?.status === 'running' || batchRunning}
                        className="px-3 py-1 rounded border text-xs font-medium hover:bg-gray-50 disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed"
                      >
                        {row?.status === 'running' ? '...' : '갱신'}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
