'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DEFAULT_REVIEW_PERSPECTIVES } from '@/lib/blog'

type Active = {
  id: string
  version: number
  label: string
  system_prompt: string
  char_count: number
}

type IssueFreq = { issue: string; count: number }

type ManualPerspective = {
  perspective: string
  total_reviews: number
  issues: IssueFreq[]
  suggestions: IssueFreq[]
}

type PipelineAxis = {
  axis: string
  avg_score: number | null
  sample_count: number
  issues: IssueFreq[]
  suggestions: IssueFreq[]
}

type Aggregate = {
  filters: Record<string, unknown>
  manual: {
    perspectives: ManualPerspective[]
    used_review_ids: string[]
    total_reviews: number
  }
  pipeline: {
    axes: PipelineAxis[]
    sample_count: number
  }
}

type Finding = {
  source?: string
  perspective_or_axis?: string
  issue?: string
  frequency?: number
  applied_section?: string
  how?: string
  reason?: string
}

type SuggestResult = {
  base: { id: string; version: number; label: string }
  proposed_prompt: string
  change_summary: string
  applied_findings: Finding[]
  skipped_findings: Finding[]
  review_ids_used: string[]
  char_count: { base: number; proposed: number }
}

type Period = '7d' | '30d' | '90d' | 'all'
type Source = 'manual' | 'pipeline' | 'both'

const PERIODS: { value: Period; label: string }[] = [
  { value: '7d', label: '최근 7일' },
  { value: '30d', label: '최근 30일' },
  { value: '90d', label: '최근 90일' },
  { value: 'all', label: '전체' },
]

const SOURCES: { value: Source; label: string }[] = [
  { value: 'both', label: '수동 + 파이프라인' },
  { value: 'manual', label: '수동만' },
  { value: 'pipeline', label: '파이프라인만' },
]

export default function PromptImproveClient({
  active,
  perspectiveOptions,
  totalManualReviews,
}: {
  active: Active
  perspectiveOptions: string[]
  totalManualReviews: number
}) {
  const router = useRouter()

  // ── 필터 상태 ──
  const [period, setPeriod] = useState<Period>('30d')
  const [perspectives, setPerspectives] = useState<string[]>([])
  const [appliedOnly, setAppliedOnly] = useState(true)
  const [source, setSource] = useState<Source>('both')
  const [excludeDerived, setExcludeDerived] = useState(true)

  // ── 단계별 데이터 ──
  const [aggregate, setAggregate] = useState<Aggregate | null>(null)
  const [aggLoading, setAggLoading] = useState(false)
  const [aggError, setAggError] = useState<string | null>(null)

  const [guidance, setGuidance] = useState('')
  const [suggest, setSuggest] = useState<SuggestResult | null>(null)
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [suggestError, setSuggestError] = useState<string | null>(null)

  // ── 검수·편집 ──
  const [editing, setEditing] = useState(false)
  const [editedPrompt, setEditedPrompt] = useState('')
  const [savingNew, setSavingNew] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const allPerspectiveOptions = useMemo(() => {
    const set = new Set<string>([
      ...DEFAULT_REVIEW_PERSPECTIVES,
      ...perspectiveOptions,
    ])
    return [...set]
  }, [perspectiveOptions])

  function togglePerspective(p: string) {
    setPerspectives((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
    )
  }

  async function fetchAggregate() {
    setAggLoading(true)
    setAggError(null)
    setSuggest(null)
    setEditing(false)
    try {
      const res = await fetch('/api/admin/blog/prompts/review-aggregate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period,
          perspectives,
          applied_only: appliedOnly,
          sources: source,
          exclude_already_derived: excludeDerived,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '집계 실패')
      setAggregate(data as Aggregate)
    } catch (e) {
      setAggError(e instanceof Error ? e.message : '오류')
    } finally {
      setAggLoading(false)
    }
  }

  async function requestSuggest() {
    if (!aggregate) return
    setSuggestLoading(true)
    setSuggestError(null)
    setEditing(false)
    try {
      const res = await fetch('/api/admin/blog/prompts/suggest-improvement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_prompt_id: active.id,
          aggregate,
          guidance: guidance || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '제안 실패')
      setSuggest(data as SuggestResult)
      setEditedPrompt((data as SuggestResult).proposed_prompt)
    } catch (e) {
      setSuggestError(e instanceof Error ? e.message : '오류')
    } finally {
      setSuggestLoading(false)
    }
  }

  async function saveAsNewVersion() {
    if (!suggest) return
    const finalPrompt = editing ? editedPrompt : suggest.proposed_prompt
    if (!finalPrompt.trim()) return
    const label = window.prompt(
      '새 버전 라벨을 입력하세요',
      `v? — 검토 ${suggest.review_ids_used.length}건 반영`,
    )
    if (!label) return

    setSavingNew(true)
    setSaveError(null)
    try {
      const res = await fetch('/api/admin/blog/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label,
          system_prompt: finalPrompt,
          parent_id: active.id,
          change_summary: suggest.change_summary,
          derived_from_review_ids: suggest.review_ids_used,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '저장 실패')
      router.push(`/admin/blog/prompts/${data.prompt.id}`)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : '오류')
      setSavingNew(false)
    }
  }

  const totalSignal =
    (aggregate?.manual?.total_reviews ?? 0) + (aggregate?.pipeline?.sample_count ?? 0)

  return (
    <div className="space-y-6">
      {/* 베이스 정보 */}
      <div className="bg-white border rounded-lg p-4 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-blue-700 font-semibold">베이스 (active)</div>
          <div className="font-bold text-gray-900">v{active.version} · {active.label}</div>
          <div className="text-xs text-gray-500 mt-0.5">{active.char_count.toLocaleString()}자</div>
        </div>
        <div className="text-xs text-gray-500">
          누적 수동 검토 {totalManualReviews.toLocaleString()}건
        </div>
      </div>

      {/* 필터 */}
      <section className="bg-white border rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-bold text-gray-900">1. 데이터 필터</h2>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-gray-600">기간</label>
            <div className="flex flex-wrap gap-1 mt-1">
              {PERIODS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => setPeriod(p.value)}
                  className={`text-xs px-2.5 py-1 rounded border ${
                    period === p.value
                      ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
                      : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-600">소스</label>
            <div className="flex flex-wrap gap-1 mt-1">
              {SOURCES.map((s) => (
                <button
                  key={s.value}
                  onClick={() => setSource(s.value)}
                  className={`text-xs px-2.5 py-1 rounded border ${
                    source === s.value
                      ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
                      : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div>
          <label className="text-xs font-medium text-gray-600">관점 필터 (수동 검토만 적용 — 비우면 전체)</label>
          <div className="flex flex-wrap gap-1 mt-1">
            {allPerspectiveOptions.map((p) => {
              const on = perspectives.includes(p)
              return (
                <button
                  key={p}
                  onClick={() => togglePerspective(p)}
                  className={`text-xs px-2 py-1 rounded border ${
                    on
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                      : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {p}
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex flex-wrap gap-4 text-xs text-gray-700">
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={appliedOnly}
              onChange={(e) => setAppliedOnly(e.target.checked)}
            />
            applied=true 만 (revert 된 것 제외)
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={excludeDerived}
              onChange={(e) => setExcludeDerived(e.target.checked)}
            />
            이미 다른 버전에 반영된 검토 제외
          </label>
        </div>

        <div className="flex justify-end">
          <Button
            onClick={fetchAggregate}
            disabled={aggLoading}
            className="bg-blue-600 hover:bg-blue-700"
          >
            {aggLoading ? '집계 중…' : '📊 집계 미리보기'}
          </Button>
        </div>

        {aggError && (
          <div className="text-xs text-red-700 bg-red-50 border border-red-100 rounded px-2 py-1.5">
            {aggError}
          </div>
        )}
      </section>

      {/* 집계 결과 */}
      {aggregate && (
        <section className="bg-white border rounded-lg p-4 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-sm font-bold text-gray-900">2. 집계 결과</h2>
            <div className="text-xs text-gray-500">
              수동 {aggregate.manual.total_reviews}건 · 파이프라인 {aggregate.pipeline.sample_count}건
            </div>
          </div>

          {totalSignal === 0 ? (
            <div className="text-xs text-gray-500 bg-gray-50 rounded px-3 py-2">
              조건에 맞는 데이터가 없습니다. 필터를 완화해보세요.
            </div>
          ) : (
            <div className="grid lg:grid-cols-2 gap-4">
              {/* 수동 검토 */}
              <div className="space-y-3">
                <div className="text-xs font-semibold text-gray-700">수동 검토 — 관점별</div>
                {aggregate.manual.perspectives.length === 0 ? (
                  <div className="text-xs text-gray-500">데이터 없음</div>
                ) : (
                  aggregate.manual.perspectives.map((p) => (
                    <div key={p.perspective} className="border rounded p-3 bg-gray-50/30 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-bold text-gray-900">{p.perspective}</div>
                        <div className="text-[10px] text-gray-500">{p.total_reviews}건</div>
                      </div>
                      {p.issues.length > 0 && (
                        <ul className="text-[11px] text-gray-700 space-y-0.5">
                          {p.issues.slice(0, 8).map((i, idx) => (
                            <li key={idx} className="flex gap-1.5">
                              <span className="text-gray-400 shrink-0 font-mono">×{i.count}</span>
                              <span className="line-clamp-2">{i.issue}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))
                )}
              </div>

              {/* 파이프라인 */}
              <div className="space-y-3">
                <div className="text-xs font-semibold text-gray-700">파이프라인 — 5축</div>
                {aggregate.pipeline.axes.length === 0 || aggregate.pipeline.sample_count === 0 ? (
                  <div className="text-xs text-gray-500">데이터 없음</div>
                ) : (
                  aggregate.pipeline.axes.map((ax) => (
                    <div key={ax.axis} className="border rounded p-3 bg-gray-50/30 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-bold text-gray-900">{ax.axis}</div>
                        <div className="text-[10px] text-gray-500">
                          {ax.avg_score == null ? '점수 없음' : `평균 ${ax.avg_score}/10`} · {ax.sample_count}샘플
                        </div>
                      </div>
                      {ax.issues.length > 0 && (
                        <ul className="text-[11px] text-gray-700 space-y-0.5">
                          {ax.issues.slice(0, 8).map((i, idx) => (
                            <li key={idx} className="flex gap-1.5">
                              <span className="text-gray-400 shrink-0 font-mono">×{i.count}</span>
                              <span className="line-clamp-2">{i.issue}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          <div className="space-y-2 pt-2 border-t">
            <label className="text-xs font-medium text-gray-700">추가 지시 (선택)</label>
            <Input
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              placeholder="예: 도입부 패턴은 건드리지 말고 금지 표현만 강화"
              disabled={suggestLoading}
            />
            <div className="flex justify-end">
              <Button
                onClick={requestSuggest}
                disabled={suggestLoading || totalSignal === 0}
                className="bg-indigo-600 hover:bg-indigo-700"
              >
                {suggestLoading ? '제안 생성 중… (30~60초)' : '✨ AI 보강 제안 받기'}
              </Button>
            </div>
            {suggestError && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-100 rounded px-2 py-1.5">
                {suggestError}
              </div>
            )}
          </div>
        </section>
      )}

      {/* AI 제안 결과 + 검수 */}
      {suggest && (
        <section className="bg-white border rounded-lg p-4 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-sm font-bold text-gray-900">3. AI 제안 검수</h2>
            <div className="text-xs text-gray-500 font-mono">
              {suggest.char_count.base.toLocaleString()} → {suggest.char_count.proposed.toLocaleString()}자
              <span
                className={
                  suggest.char_count.proposed > suggest.char_count.base
                    ? 'text-amber-700 ml-1'
                    : 'text-emerald-700 ml-1'
                }
              >
                ({suggest.char_count.proposed > suggest.char_count.base ? '+' : ''}
                {(suggest.char_count.proposed - suggest.char_count.base).toLocaleString()})
              </span>
            </div>
          </div>

          {suggest.change_summary && (
            <div className="bg-blue-50 border border-blue-100 rounded px-3 py-2 text-sm text-blue-900">
              <strong className="text-xs uppercase tracking-wide">변경 요약:</strong>{' '}
              {suggest.change_summary}
            </div>
          )}

          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <div className="text-xs font-semibold text-emerald-800 mb-1">
                반영된 항목 ({suggest.applied_findings.length})
              </div>
              <ul className="space-y-1 text-xs">
                {suggest.applied_findings.map((f, i) => (
                  <li key={i} className="bg-emerald-50/60 border border-emerald-100 rounded px-2 py-1.5">
                    <div className="font-medium text-gray-900 line-clamp-2">{f.issue}</div>
                    <div className="text-[10px] text-gray-600 mt-0.5">
                      {f.perspective_or_axis ? `${f.perspective_or_axis} · ` : ''}
                      {f.applied_section ? `→ ${f.applied_section}` : ''}
                      {typeof f.frequency === 'number' ? ` · ${f.frequency}회` : ''}
                    </div>
                    {f.how && <div className="text-[11px] text-gray-700 mt-0.5">{f.how}</div>}
                  </li>
                ))}
                {suggest.applied_findings.length === 0 && (
                  <li className="text-gray-500 text-[11px]">없음</li>
                )}
              </ul>
            </div>
            <div>
              <div className="text-xs font-semibold text-gray-700 mb-1">
                건너뛴 항목 ({suggest.skipped_findings.length})
              </div>
              <ul className="space-y-1 text-xs">
                {suggest.skipped_findings.map((f, i) => (
                  <li key={i} className="bg-gray-50 border border-gray-100 rounded px-2 py-1.5">
                    <div className="text-gray-700 line-clamp-2">{f.issue}</div>
                    {f.reason && (
                      <div className="text-[10px] text-gray-500 mt-0.5">사유: {f.reason}</div>
                    )}
                  </li>
                ))}
                {suggest.skipped_findings.length === 0 && (
                  <li className="text-gray-500 text-[11px]">없음</li>
                )}
              </ul>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-gray-700">제안된 새 system prompt</label>
              <button
                onClick={() => setEditing((v) => !v)}
                className="text-xs text-blue-600 hover:underline"
              >
                {editing ? '읽기 모드로' : '직접 편집'}
              </button>
            </div>
            {editing ? (
              <textarea
                value={editedPrompt}
                onChange={(e) => setEditedPrompt(e.target.value)}
                spellCheck={false}
                className="w-full min-h-[400px] border rounded-md px-3 py-2 text-xs font-mono leading-relaxed"
              />
            ) : (
              <pre className="bg-gray-50 border rounded-md px-3 py-2 text-xs whitespace-pre-wrap font-mono max-h-[500px] overflow-y-auto">
                {suggest.proposed_prompt}
              </pre>
            )}
          </div>

          {saveError && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-100 rounded px-2 py-1.5">
              {saveError}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t">
            <div className="text-xs text-gray-500">
              검토 {suggest.review_ids_used.length}건이 새 버전의 derived_from_review_ids 로 추적됩니다.
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setSuggest(null)} disabled={savingNew}>
                버림
              </Button>
              <Button
                onClick={saveAsNewVersion}
                disabled={savingNew}
                className="bg-emerald-600 hover:bg-emerald-700"
              >
                {savingNew ? '저장 중…' : '새 버전으로 저장'}
              </Button>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
