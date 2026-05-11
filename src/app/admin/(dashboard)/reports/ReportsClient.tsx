'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  type Report,
  type ReportStatus,
  reasonLabel,
} from '@/lib/reports'

type Props = {
  reports: Report[]
  ipRepeatCount: Record<string, number>
}

export default function ReportsClient({ reports, ipRepeatCount }: Props) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [busy, setBusy] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function act(
    id: string,
    action:
      | 'mark_in_review'
      | 'resolve'
      | 'reject'
      | 'mark_spam'
      | 'block_ip'
      | 'delete',
    payload?: { admin_action_label?: string; diff_summary?: string; admin_note?: string },
  ) {
    setErr(null)
    setBusy(id)
    try {
      const res = await fetch(`/api/admin/reports/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? '처리 실패')
      startTransition(() => router.refresh())
    } catch (e) {
      setErr(e instanceof Error ? e.message : '오류')
    } finally {
      setBusy(null)
    }
  }

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  if (reports.length === 0) {
    return (
      <div className="bg-white border rounded-lg p-10 text-center text-sm text-gray-500">
        해당 상태의 신고가 없습니다.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {err && (
        <div className="text-sm bg-red-50 border border-red-100 text-red-700 rounded px-3 py-2">
          {err}
        </div>
      )}
      {copied && (
        <div className="text-xs bg-green-50 border border-green-100 text-green-700 rounded px-3 py-2">
          복사됨: {copied}
        </div>
      )}

      {reports.map((r) => {
        const isExpanded = expanded.has(r.id)
        const repeatedIp = (ipRepeatCount[r.reporter_ip] ?? 0) >= 3
        return (
          <div key={r.id} className="bg-white border rounded-lg overflow-hidden">
            <div
              role="button"
              tabIndex={0}
              onClick={() => toggle(r.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  toggle(r.id)
                }
              }}
              className="cursor-pointer px-4 py-3 hover:bg-gray-50 flex items-start justify-between gap-3"
            >
              <div className="min-w-0 space-y-1 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-medium">
                    {r.target_type}
                  </span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-700">
                    {reasonLabel(r.reason_category)}
                  </span>
                  <span className="text-xs text-gray-500 font-mono truncate">
                    {r.target_slug ?? '—'}
                    {r.target_id && `/${r.target_id}`}
                  </span>
                  {repeatedIp && (
                    <span
                      className="text-xs px-1.5 py-0.5 rounded bg-orange-100 text-orange-700"
                      title="이 IP가 최근 7일 내 3건 이상 신고"
                    >
                      반복 IP
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-900 line-clamp-2">{r.description}</p>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-[11px] text-gray-500">
                  {new Date(r.created_at).toLocaleString('ko-KR', {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}
                </div>
                <div className="text-[11px] text-gray-400 font-mono mt-0.5">
                  {r.reporter_ip}
                </div>
              </div>
            </div>

            {isExpanded && (
              <div className="border-t px-4 py-4 bg-gray-50 space-y-3">
                {/* URL */}
                <div>
                  <div className="text-[11px] font-semibold text-gray-600 mb-0.5">
                    대상 URL
                  </div>
                  <a
                    href={r.target_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-600 hover:underline break-all"
                  >
                    {r.target_url} ↗
                  </a>
                </div>

                {/* 상세 */}
                <div>
                  <div className="text-[11px] font-semibold text-gray-600 mb-0.5">
                    신고 내용
                  </div>
                  <p className="text-sm text-gray-900 whitespace-pre-wrap">{r.description}</p>
                </div>

                {r.correct_info && (
                  <div>
                    <div className="text-[11px] font-semibold text-gray-600 mb-0.5">
                      제보자가 알려준 올바른 정보
                    </div>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">{r.correct_info}</p>
                  </div>
                )}

                {r.source_url && (
                  <div>
                    <div className="text-[11px] font-semibold text-gray-600 mb-0.5">
                      근거 출처
                    </div>
                    <a
                      href={r.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-600 hover:underline break-all"
                    >
                      {r.source_url} ↗
                    </a>
                  </div>
                )}

                {r.reporter_email && (
                  <div>
                    <div className="text-[11px] font-semibold text-gray-600 mb-0.5">
                      제보자 이메일
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-900">{r.reporter_email}</span>
                      <button
                        type="button"
                        onClick={() => copy(r.reporter_email!, '이메일')}
                        className="text-[11px] text-blue-600 hover:underline"
                      >
                        복사
                      </button>
                    </div>
                  </div>
                )}

                {r.admin_note && (
                  <div>
                    <div className="text-[11px] font-semibold text-gray-600 mb-0.5">
                      관리자 메모
                    </div>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">{r.admin_note}</p>
                  </div>
                )}

                {r.status === 'resolved' && (
                  <div className="bg-emerald-50 border border-emerald-100 rounded p-2 text-xs">
                    <span className="font-semibold text-emerald-700">정정 배지: </span>
                    <span className="text-emerald-800">
                      {r.admin_action_label ?? '정정됨'}
                      {r.diff_summary && ` — ${r.diff_summary}`}
                    </span>
                  </div>
                )}

                {/* 액션 */}
                <div className="pt-2 border-t flex flex-wrap gap-2">
                  {r.status === 'pending' && (
                    <button
                      type="button"
                      onClick={() => act(r.id, 'mark_in_review')}
                      disabled={busy === r.id}
                      className="text-xs px-3 py-1.5 rounded bg-white border hover:bg-gray-50"
                    >
                      검토중으로 변경
                    </button>
                  )}
                  {(r.status === 'pending' || r.status === 'in_review') && (
                    <>
                      <ResolveButton
                        disabled={busy === r.id}
                        onConfirm={(label, diff, note) =>
                          act(r.id, 'resolve', {
                            admin_action_label: label,
                            diff_summary: diff,
                            admin_note: note,
                          })
                        }
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const note = window.prompt('기각 사유 (선택):') ?? ''
                          act(r.id, 'reject', { admin_note: note || undefined })
                        }}
                        disabled={busy === r.id}
                        className="text-xs px-3 py-1.5 rounded bg-white border hover:bg-gray-50 text-gray-700"
                      >
                        기각
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (!confirm('스팸으로 처리합니다.')) return
                          act(r.id, 'mark_spam')
                        }}
                        disabled={busy === r.id}
                        className="text-xs px-3 py-1.5 rounded bg-white border hover:bg-gray-50 text-gray-700"
                      >
                        스팸 처리
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      const reason = window.prompt('IP 차단 사유:')
                      if (reason === null) return
                      act(r.id, 'block_ip', { admin_note: reason })
                    }}
                    disabled={busy === r.id}
                    className="text-xs px-3 py-1.5 rounded bg-white border hover:bg-red-50 text-red-600"
                  >
                    이 IP 차단
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ResolveButton({
  disabled,
  onConfirm,
}: {
  disabled: boolean
  onConfirm: (label: string, diff: string, note?: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [diff, setDiff] = useState('')
  const [note, setNote] = useState('')

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="text-xs px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-medium"
      >
        정정 완료
      </button>
    )
  }

  return (
    <div className="w-full bg-white border rounded p-3 space-y-2">
      <div className="text-xs font-semibold text-gray-700">정정 완료 처리</div>
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value.slice(0, 30))}
        placeholder="공개 배지 라벨 (예: 요금 정정)"
        className="w-full text-xs border rounded px-2 py-1.5"
        maxLength={30}
      />
      <input
        value={diff}
        onChange={(e) => setDiff(e.target.value.slice(0, 100))}
        placeholder="변경 요약 한 줄 (예: 1,500원 → 1,300원)"
        className="w-full text-xs border rounded px-2 py-1.5"
        maxLength={100}
      />
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="비공개 관리자 메모 (선택)"
        rows={2}
        className="w-full text-xs border rounded px-2 py-1.5 resize-none"
      />
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs px-2 py-1 text-gray-600 hover:text-gray-900"
        >
          취소
        </button>
        <button
          type="button"
          onClick={() => onConfirm(label.trim(), diff.trim(), note.trim() || undefined)}
          className="text-xs px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-medium"
        >
          확정
        </button>
      </div>
    </div>
  )
}
