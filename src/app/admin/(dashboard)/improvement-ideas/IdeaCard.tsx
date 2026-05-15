'use client'

import { useState, useTransition } from 'react'
import { updateIdeaStatus, updateIdeaNote } from './actions'

export type IdeaRow = {
  id: string
  project: string
  title: string
  category: string
  priority: string
  description: string
  rationale: string | null
  referenced_files: string[]
  dedup_signature: string | null
  status: string
  generated_at: string
  cost_usd: number | null
  input_tokens: number | null
  output_tokens: number | null
  num_turns: number | null
  note: string | null
  processing_started_at: string | null
  implementation_branch: string | null
  implementation_commit: string | null
  implementation_error: string | null
}

const REPO_BASE = 'https://github.com/anteam7/product_recommend'

const STATUS_OPTIONS = [
  { value: 'proposed', label: '제안됨', color: 'bg-blue-100 text-blue-700' },
  { value: 'in_progress', label: '진행중', color: 'bg-amber-100 text-amber-700' },
  { value: 'done', label: '완료', color: 'bg-green-100 text-green-700' },
  { value: 'rejected', label: '거절', color: 'bg-gray-200 text-gray-600' },
  { value: 'duplicate', label: '중복', color: 'bg-gray-100 text-gray-500' },
] as const

const CATEGORY_LABELS: Record<string, string> = {
  ux: 'UX',
  ops: '운영',
  monetization: '수익화',
  data_analysis: '데이터 분석',
  visualization: '시각화',
  product_discovery: '상품 발굴',
  infra: '인프라',
  other: '기타',
}

const PRIORITY_COLORS: Record<string, string> = {
  high: 'bg-rose-100 text-rose-700',
  medium: 'bg-yellow-100 text-yellow-700',
  low: 'bg-gray-100 text-gray-600',
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function IdeaCard({ idea }: { idea: IdeaRow }) {
  const [expanded, setExpanded] = useState(false)
  const [noteDraft, setNoteDraft] = useState(idea.note ?? '')
  const [isPending, startTransition] = useTransition()

  const statusOption = STATUS_OPTIONS.find((s) => s.value === idea.status)
  const isClosed = idea.status === 'done' || idea.status === 'rejected' || idea.status === 'duplicate'

  function changeStatus(newStatus: string) {
    startTransition(async () => {
      await updateIdeaStatus(idea.id, newStatus as IdeaRow['status'] as 'proposed')
    })
  }

  function saveNote() {
    startTransition(async () => {
      await updateIdeaNote(idea.id, noteDraft)
    })
  }

  return (
    <div
      className={`rounded-lg border bg-white p-4 transition-opacity ${isClosed ? 'opacity-60' : ''} ${isPending ? 'opacity-50' : ''}`}
    >
      <div className="flex items-start gap-3">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 text-left min-w-0"
        >
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span
              className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                idea.project === 'product_recommend'
                  ? 'bg-amber-100 text-amber-700'
                  : 'bg-sky-100 text-sky-700'
              }`}
            >
              {idea.project}
            </span>
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-700">
              {CATEGORY_LABELS[idea.category] ?? idea.category}
            </span>
            <span
              className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${PRIORITY_COLORS[idea.priority] ?? 'bg-gray-100'}`}
            >
              {idea.priority}
            </span>
            {statusOption && (
              <span
                className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${statusOption.color}`}
              >
                {statusOption.label}
              </span>
            )}
            <span className="text-xs text-gray-400 ml-auto">{formatTime(idea.generated_at)}</span>
          </div>
          <div className="font-semibold text-sm text-gray-900 break-keep">{idea.title}</div>
        </button>
      </div>

      {expanded && (
        <div className="mt-3 space-y-3 text-sm">
          <div>
            <div className="text-xs font-semibold text-gray-500 mb-1">구현 방향</div>
            <p className="text-gray-700 whitespace-pre-wrap break-keep">{idea.description}</p>
          </div>

          {idea.rationale && (
            <div>
              <div className="text-xs font-semibold text-gray-500 mb-1">근거</div>
              <p className="text-gray-700 whitespace-pre-wrap break-keep">{idea.rationale}</p>
            </div>
          )}

          {idea.referenced_files.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-gray-500 mb-1">참조 파일</div>
              <ul className="font-mono text-xs text-gray-600 space-y-0.5">
                {idea.referenced_files.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          )}

          {(idea.implementation_branch || idea.implementation_commit || idea.implementation_error) && (
            <div>
              <div className="text-xs font-semibold text-gray-500 mb-1">구현 결과</div>
              <div className="text-xs space-y-1">
                {idea.implementation_branch && (
                  <div>
                    <span className="text-gray-500">브랜치: </span>
                    <a
                      href={`${REPO_BASE}/tree/${idea.implementation_branch}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-blue-600 hover:underline"
                    >
                      {idea.implementation_branch}
                    </a>
                  </div>
                )}
                {idea.implementation_commit && (
                  <div>
                    <span className="text-gray-500">커밋: </span>
                    <a
                      href={`${REPO_BASE}/commit/${idea.implementation_commit}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-blue-600 hover:underline"
                    >
                      {idea.implementation_commit.slice(0, 8)}
                    </a>
                  </div>
                )}
                {idea.implementation_error && (
                  <div>
                    <span className="text-gray-500">실패 사유:</span>
                    <pre className="font-mono text-rose-600 text-[10px] whitespace-pre-wrap break-all mt-0.5 bg-rose-50 p-2 rounded">
                      {idea.implementation_error}
                    </pre>
                  </div>
                )}
                {idea.processing_started_at && !idea.implementation_commit && !idea.implementation_error && (
                  <div className="text-amber-600">
                    처리 중 ({formatTime(idea.processing_started_at)} ~)
                  </div>
                )}
              </div>
            </div>
          )}

          <div>
            <div className="text-xs font-semibold text-gray-500 mb-1">메모</div>
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              onBlur={saveNote}
              placeholder="자유 메모..."
              className="w-full text-xs border border-gray-200 rounded p-2 resize-y min-h-[40px]"
            />
          </div>

          <div className="flex flex-wrap gap-2 pt-1 border-t border-gray-100">
            <div className="text-xs text-gray-500 flex items-center mr-2">상태:</div>
            {STATUS_OPTIONS.map((s) => (
              <button
                key={s.value}
                disabled={isPending || s.value === idea.status}
                onClick={() => changeStatus(s.value)}
                className={`text-[11px] px-2 py-1 rounded transition-colors ${
                  s.value === idea.status
                    ? `${s.color} font-semibold ring-1 ring-current`
                    : 'bg-gray-50 text-gray-500 hover:bg-gray-100'
                } disabled:cursor-default`}
              >
                {s.label}
              </button>
            ))}
            {idea.cost_usd != null && (
              <span className="text-[10px] text-gray-400 ml-auto self-center">
                {idea.num_turns}turn · {idea.input_tokens}/{idea.output_tokens} tok · $
                {Number(idea.cost_usd).toFixed(4)}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
