'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { personaById } from '@/lib/personas'
import { CADENCES, type Cadence, type Scenario } from '@/lib/scenarios'

const CADENCE_FALLBACK = { label: '–', sub: '', color: '#64748b' }

function cadenceOf(c: Cadence) {
  return CADENCES[c] ?? CADENCE_FALLBACK
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-5 py-4">
      <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-gray-400">{title}</h4>
      {children}
    </div>
  )
}

export default function ScenarioDetailPanel({
  scenario,
  onClose,
}: {
  scenario: Scenario | null
  onClose: () => void
}) {
  const [shown, setShown] = useState<Scenario | null>(scenario)
  const [runState, setRunState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [runMsg, setRunMsg] = useState<string | null>(null)
  const open = scenario !== null

  useEffect(() => {
    if (scenario) setShown(scenario)
    setRunState('idle')
    setRunMsg(null)
  }, [scenario])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const s = shown
  const cad = s ? cadenceOf(s.cadence) : null

  const requestRun = async () => {
    if (!s) return
    setRunState('loading')
    setRunMsg(null)
    try {
      const r = await fetch(`/api/admin/scenarios/${encodeURIComponent(s.id)}/run`, {
        method: 'POST',
      })
      if (r.ok) {
        setRunState('done')
      } else {
        const body = (await r.json().catch(() => null)) as { error?: string } | null
        setRunState('error')
        setRunMsg(body?.error ?? `HTTP ${r.status}`)
      }
    } catch (err) {
      setRunState('error')
      setRunMsg(err instanceof Error ? err.message : '네트워크 오류')
    }
  }

  return (
    <>
      <div
        onClick={onClose}
        aria-hidden
        className={`fixed inset-0 z-40 bg-slate-900/30 transition-opacity duration-300 ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-hidden={!open}
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-[460px] flex-col overflow-y-auto bg-white shadow-2xl transition-transform duration-300 ease-out ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {s && cad && (
          <>
            <div className="relative px-5 pb-4 pt-5" style={{ background: `${s.accent}10` }}>
              <button
                type="button"
                onClick={onClose}
                aria-label="닫기"
                className="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-full bg-white/80 text-gray-500 shadow-sm hover:bg-white hover:text-gray-800"
              >
                <X size={16} />
              </button>
              <div className="flex items-center gap-2">
                <span
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-xl"
                  style={{ background: `${s.accent}1f` }}
                >
                  {s.emoji}
                </span>
                <div className="min-w-0">
                  <h3 className="text-base font-extrabold text-gray-900">{s.name}</h3>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
                      style={{ background: cad.color }}
                    >
                      {cad.label} · {cad.sub}
                    </span>
                    <span className="rounded-full border border-gray-300 bg-white px-2 py-0.5 text-[10px] font-semibold text-gray-600">
                      {s.area}
                    </span>
                    {s.status === 'planned' && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                        예정
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <p className="mt-3 text-sm font-medium leading-relaxed text-gray-700">{s.objective}</p>

              <button
                type="button"
                onClick={requestRun}
                disabled={runState === 'loading' || runState === 'done'}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-bold text-white shadow-sm transition-colors disabled:opacity-80"
                style={{ background: runState === 'done' ? '#16a34a' : s.accent }}
              >
                {runState === 'idle' && '▶ 지금 실행'}
                {runState === 'loading' && '등록 중…'}
                {runState === 'done' && '✓ 대기열에 등록됨'}
                {runState === 'error' && '실패 — 다시 시도'}
              </button>
              {runState === 'done' && (
                <p className="mt-1.5 text-xs text-gray-500">
                  로컬 러너가 단계별로 실행하고 운영 일지에 기록합니다. 게이트(🚦) 단계에서 승인 대기로 멈춥니다.
                </p>
              )}
              {runState === 'error' && runMsg && (
                <p className="mt-1.5 text-xs text-rose-600">{runMsg}</p>
              )}
            </div>

            <div className="divide-y divide-gray-100">
              <Section title="프레임워크 근거">
                <div className="flex flex-wrap gap-1.5">
                  {s.frameworks.map((f) => (
                    <span
                      key={f}
                      className="rounded-md bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-700"
                    >
                      {f}
                    </span>
                  ))}
                </div>
              </Section>

              <Section title="주기 · 트리거">
                <div className="flex items-start gap-2 text-sm">
                  <span
                    className="shrink-0 rounded-md px-2 py-1 text-xs font-bold text-white"
                    style={{ background: cad.color }}
                  >
                    {cad.label}
                  </span>
                  <p className="text-gray-600">{s.trigger}</p>
                </div>
              </Section>

              {s.harness && (
                <Section title="연결된 하네스 (.claude/skills)">
                  <span className="rounded-md bg-slate-100 px-2 py-1 text-[11px] font-mono text-slate-600">
                    {s.harness}
                  </span>
                </Section>
              )}

              <Section title="협업 흐름 (누가 → 무엇을)">
                <ol className="relative space-y-3">
                  {s.steps.map((step, i) => {
                    const p = personaById(step.personaId)
                    return (
                      <li key={`${i}-${step.personaId}`} className="flex gap-3">
                        <div className="flex flex-col items-center">
                          <div
                            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-lg"
                            style={{ background: `${p?.accent ?? '#64748b'}1a` }}
                          >
                            {p?.emoji ?? '👤'}
                          </div>
                          {i < s.steps.length - 1 && <span className="mt-1 h-4 w-px bg-gray-200" />}
                        </div>
                        <div className="min-w-0 pt-0.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[10px] font-bold text-gray-400">{i + 1}</span>
                            <span className="text-sm font-bold text-gray-800">
                              {p?.nameKr ?? step.personaId}
                            </span>
                            {step.gate && (
                              <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-700 ring-1 ring-amber-300">
                                🚦 게이트
                              </span>
                            )}
                          </div>
                          <p className="text-xs leading-relaxed text-gray-600">{step.action}</p>
                        </div>
                      </li>
                    )
                  })}
                </ol>
              </Section>

              <Section title="산출물">
                <p className="text-sm text-gray-700">{s.output}</p>
              </Section>

              <Section title="성과 지표 (KPI)">
                <div className="flex flex-wrap gap-1.5">
                  {s.kpis.map((k) => (
                    <span
                      key={k}
                      className="rounded-lg border px-2.5 py-1.5 text-xs font-semibold"
                      style={{ borderColor: `${s.accent}40`, color: s.accent, background: `${s.accent}0d` }}
                    >
                      {k}
                    </span>
                  ))}
                </div>
              </Section>
            </div>
          </>
        )}
      </aside>
    </>
  )
}
