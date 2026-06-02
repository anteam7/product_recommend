'use client'

import { useState, useTransition } from 'react'
import { fetchAstroturfEvidence, type EvidenceRow } from './actions'

export interface Candidate {
  keyword_norm: string
  first_source: string | null
  community_sources: number
  earliest_at: string
  spread_hours: number
  organic_volume: number
  pre_ramp_hits: number
  f_concurrency: number
  f_phrase_similarity: number
  f_organic_unconfirmed: number
  f_no_ramp: number
  astroturf_score: number
}

function riskBand(score: number): { label: string; cls: string } {
  if (score >= 70) return { label: '높음', cls: 'bg-red-100 text-red-700 border-red-200' }
  if (score >= 50) return { label: '중간', cls: 'bg-orange-100 text-orange-700 border-orange-200' }
  return { label: '관찰', cls: 'bg-yellow-100 text-yellow-700 border-yellow-200' }
}

function Bar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-24 shrink-0 text-gray-500">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded bg-gray-100">
        <div className="h-full bg-gray-700" style={{ width: `${Math.min(100, value)}%` }} />
      </div>
      <span className="w-8 shrink-0 text-right tabular-nums text-gray-600">{Math.round(value)}</span>
    </div>
  )
}

function fmt(ts: string): string {
  try {
    return new Date(ts).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ts
  }
}

export default function AuthenticityBoard({ candidates }: { candidates: Candidate[] }) {
  const [selected, setSelected] = useState<Candidate | null>(null)
  const [evidence, setEvidence] = useState<EvidenceRow[]>([])
  const [pending, startTransition] = useTransition()

  function openEvidence(c: Candidate) {
    setSelected(c)
    setEvidence([])
    startTransition(async () => {
      const rows = await fetchAstroturfEvidence(c.keyword_norm)
      setEvidence(rows)
    })
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_460px]">
      {/* 후보 보드 */}
      <div className="space-y-3">
        {candidates.map((c) => {
          const band = riskBand(c.astroturf_score)
          const active = selected?.keyword_norm === c.keyword_norm
          return (
            <button
              key={c.keyword_norm}
              onClick={() => openEvidence(c)}
              className={`w-full rounded-lg border p-4 text-left transition ${
                active ? 'border-black ring-1 ring-black' : 'border-gray-200 hover:border-gray-400'
              }`}
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{c.keyword_norm}</span>
                  <span className={`rounded border px-2 py-0.5 text-xs ${band.cls}`}>
                    의심 {band.label}
                  </span>
                </div>
                <span className="text-2xl font-bold tabular-nums">{Math.round(c.astroturf_score)}</span>
              </div>
              <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                <span>커뮤니티 {c.community_sources}곳 동시</span>
                <span>확산폭 {Math.round(c.spread_hours)}h</span>
                <span>유기볼륨 {Math.round(c.organic_volume)}</span>
                <span>사전램프 {c.pre_ramp_hits}</span>
                {c.first_source && <span>최초 {c.first_source}</span>}
              </div>
              <div className="space-y-1">
                <Bar label="① 동시성" value={c.f_concurrency} />
                <Bar label="② 문구유사" value={c.f_phrase_similarity} />
                <Bar label="③ 유기미확증" value={c.f_organic_unconfirmed} />
                <Bar label="④ 무램프" value={c.f_no_ramp} />
              </div>
            </button>
          )
        })}
      </div>

      {/* 증거 타임라인 패널 */}
      <aside className="lg:sticky lg:top-4 lg:self-start">
        <div className="rounded-lg border border-gray-200 p-4">
          {!selected ? (
            <p className="py-12 text-center text-sm text-gray-400">
              후보를 클릭하면 동시발화 멘션 원문 타임라인이 여기에 표시됩니다.
            </p>
          ) : (
            <>
              <div className="mb-3 border-b border-gray-100 pb-3">
                <h2 className="font-semibold">“{selected.keyword_norm}” 동시발화 증거</h2>
                <p className="mt-1 text-xs text-gray-500">
                  커뮤니티 출처별 등장 원문(최근 14일, 시각순). 같은 시각·동일 문구가 반복되면 코디네이션 의심.
                </p>
              </div>
              {pending ? (
                <p className="py-8 text-center text-sm text-gray-400">불러오는 중…</p>
              ) : evidence.length === 0 ? (
                <p className="py-8 text-center text-sm text-gray-400">원문 발췌 없음.</p>
              ) : (
                <ol className="space-y-3">
                  {evidence.map((e, i) => (
                    <li key={i} className="relative border-l-2 border-gray-200 pl-3">
                      <div className="mb-1 flex items-center gap-2 text-xs">
                        <span className="font-medium text-gray-700">{e.source}</span>
                        <span className="text-gray-400">{fmt(e.collected_at)}</span>
                      </div>
                      <p className="line-clamp-4 text-xs leading-relaxed text-gray-600">{e.snippet}</p>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  )
}
