'use client'

import { useState } from 'react'
import { personaById } from '@/lib/personas'
import {
  CADENCES,
  CADENCE_ORDER,
  scenarioById,
  type Cadence,
  type Scenario,
} from '@/lib/scenarios'
import ScenarioDetailPanel from './ScenarioDetailPanel'

const CADENCE_FALLBACK = { label: '–', sub: '', color: '#64748b' }
const cadenceOf = (c: Cadence) => CADENCES[c] ?? CADENCE_FALLBACK

function FlowStrip({ scenario }: { scenario: Scenario }) {
  return (
    <div className="flex items-center gap-0.5 overflow-hidden">
      {scenario.steps.map((step, i) => {
        const p = personaById(step.personaId)
        return (
          <span key={`${i}-${step.personaId}`} className="flex items-center">
            <span
              title={`${p?.nameKr ?? step.personaId}: ${step.action}`}
              className="grid h-7 w-7 place-items-center rounded-lg text-sm"
              style={{ background: `${p?.accent ?? '#64748b'}1a` }}
            >
              {p?.emoji ?? '👤'}
            </span>
            {step.gate && <span className="px-0.5 text-[10px]">🚦</span>}
            {i < scenario.steps.length - 1 && (
              <span className="px-0.5 text-gray-300">→</span>
            )}
          </span>
        )
      })}
    </div>
  )
}

function ScenarioCard({
  scenario,
  active,
  onSelect,
}: {
  scenario: Scenario
  active: boolean
  onSelect: (id: string) => void
}) {
  const cad = cadenceOf(scenario.cadence)
  return (
    <button
      type="button"
      onClick={() => onSelect(scenario.id)}
      className="flex w-full flex-col gap-2 rounded-2xl border bg-white p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
      style={
        active
          ? { borderColor: scenario.accent, boxShadow: `0 0 0 2px ${scenario.accent}` }
          : { borderColor: '#e5e7eb' }
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-base"
            style={{ background: `${scenario.accent}1a` }}
          >
            {scenario.emoji}
          </span>
          <h3 className="text-sm font-bold leading-tight text-gray-900">{scenario.name}</h3>
        </div>
        <span
          className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
          style={{ background: cad.color }}
        >
          {cad.label}
        </span>
      </div>

      <p className="line-clamp-2 text-xs leading-relaxed text-gray-500">{scenario.objective}</p>

      <div className="flex flex-wrap gap-1">
        {scenario.frameworks.slice(0, 2).map((f) => (
          <span key={f} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
            {f}
          </span>
        ))}
        {scenario.frameworks.length > 2 && (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
            +{scenario.frameworks.length - 2}
          </span>
        )}
      </div>

      <div className="mt-1 border-t border-gray-100 pt-2">
        <FlowStrip scenario={scenario} />
      </div>
    </button>
  )
}

export default function ScenarioWorkspace({ scenarios }: { scenarios: Scenario[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = selectedId ? scenarioById(selectedId) ?? null : null

  return (
    <div className="relative">
      <div className="mb-4">
        <h1 className="text-xl font-extrabold text-gray-900">팀 작업 시나리오</h1>
        <p className="mt-0.5 text-sm text-gray-500">
          {scenarios.length}개 시나리오 · 이커머스 프레임워크 기반. 어떤 페르소나가 어떻게 연결되어 일하고 어떤
          주기로 도는지 보여줍니다. 카드를 클릭하면 전체 흐름과 ▶ 실행을 볼 수 있어요.
        </p>
        <p className="mt-1 text-xs text-gray-400">
          🚦 = 게이트(승인·차단 권한) 단계 · maker-checker(4-eyes) 통제 지점
        </p>
      </div>

      <div className="space-y-6">
        {CADENCE_ORDER.map((cadence: Cadence) => {
          const items = scenarios.filter((s) => s.cadence === cadence)
          if (items.length === 0) return null
          const cad = cadenceOf(cadence)
          return (
            <section key={cadence}>
              <header className="mb-2 flex items-center gap-2">
                <span
                  className="rounded-md px-2 py-0.5 text-xs font-bold text-white"
                  style={{ background: cad.color }}
                >
                  {cad.label}
                </span>
                <h2 className="text-sm font-bold text-gray-700">{cad.sub}</h2>
                <span className="text-xs text-gray-400">{items.length}개</span>
              </header>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {items.map((s) => (
                  <ScenarioCard
                    key={s.id}
                    scenario={s}
                    active={selectedId === s.id}
                    onSelect={setSelectedId}
                  />
                ))}
              </div>
            </section>
          )
        })}
      </div>

      <ScenarioDetailPanel scenario={selected} onClose={() => setSelectedId(null)} />
    </div>
  )
}
