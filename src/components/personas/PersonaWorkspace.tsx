'use client'

import { useState } from 'react'
import {
  DEPTS,
  DEPT_ORDER,
  personaById,
  type Dept,
  type Persona,
} from '@/lib/personas'
import PersonaDetailPanel from './PersonaDetailPanel'

function PersonaChip({
  persona,
  active,
  onSelect,
}: {
  persona: Persona
  active: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(persona.id)}
      className="flex w-full items-center gap-3 rounded-xl border bg-white p-3 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
      style={
        active
          ? { borderColor: persona.accent, boxShadow: `0 0 0 2px ${persona.accent}` }
          : { borderColor: '#e5e7eb' }
      }
    >
      <span
        className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-xl"
        style={{ background: `${persona.accent}1a` }}
      >
        {persona.emoji}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-bold text-gray-900">{persona.nameKr}</span>
          {persona.status === 'planned' && (
            <span className="rounded bg-amber-100 px-1 text-[9px] font-bold text-amber-700">예정</span>
          )}
        </span>
        <span className="line-clamp-1 text-xs text-gray-500">{persona.tagline}</span>
      </span>
    </button>
  )
}

function OrgChart({
  personas,
  onSelect,
  selectedId,
}: {
  personas: Persona[]
  onSelect: (id: string) => void
  selectedId: string | null
}) {
  const childrenOf = (id: string | null) =>
    personas.filter((p) => p.reportsTo === id).sort((a, b) => a.priority - b.priority)

  function Node({ p, depth }: { p: Persona; depth: number }) {
    const kids = childrenOf(p.id)
    // p.dept 는 타입상 Dept 이지만, 잘못된 config 입력 방어용 폴백.
    const dept = DEPTS[p.dept] ?? { label: String(p.dept), color: '#64748b', icon: '•' }
    return (
      <div className="relative">
        <button
          type="button"
          onClick={() => onSelect(p.id)}
          className="mb-2 flex items-center gap-2 rounded-lg border bg-white px-3 py-2 text-left shadow-sm transition-all hover:shadow-md"
          style={{
            marginLeft: depth * 22,
            borderColor: selectedId === p.id ? p.accent : '#e5e7eb',
            boxShadow: selectedId === p.id ? `0 0 0 2px ${p.accent}` : undefined,
          }}
        >
          <span className="text-lg">{p.emoji}</span>
          <span>
            <span className="block text-sm font-bold text-gray-900">{p.nameKr}</span>
            <span className="text-[10px] font-semibold" style={{ color: dept.color }}>
              {dept.icon} {dept.label}
            </span>
          </span>
        </button>
        {kids.map((k) => (
          <Node key={k.id} p={k} depth={depth + 1} />
        ))}
      </div>
    )
  }

  const roots = childrenOf(null)
  return (
    <div>
      {roots.map((r) => (
        <Node key={r.id} p={r} depth={0} />
      ))}
    </div>
  )
}

export default function PersonaWorkspace({ personas }: { personas: Persona[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<'dept' | 'org'>('dept')
  const selected = selectedId ? personaById(selectedId) ?? null : null

  const activeCount = personas.filter((p) => p.status === 'active').length

  return (
    <div className="relative">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-gray-900">팀 페르소나</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            {personas.length}개 직무 · {activeCount}개 가동 · 리테일 가치사슬 + AARRR 기반. 발굴→소싱→등록→운영
            파이프라인을 누가 맡는지 보여줍니다. 카드를 클릭하면 미션·KPI·위임 시드를 볼 수 있어요.
          </p>
        </div>
        <div className="flex shrink-0 rounded-lg border border-gray-200 bg-white p-0.5 text-xs font-semibold">
          {(['dept', 'org'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`rounded-md px-3 py-1.5 transition-colors ${
                view === v ? 'bg-slate-900 text-white' : 'text-gray-500 hover:text-gray-800'
              }`}
            >
              {v === 'dept' ? '부서별' : '조직도'}
            </button>
          ))}
        </div>
      </div>

      {view === 'dept' ? (
        <div className="space-y-6">
          {DEPT_ORDER.map((dept: Dept) => {
            const items = personas
              .filter((p) => p.dept === dept)
              .sort((a, b) => a.priority - b.priority)
            if (items.length === 0) return null
            const d = DEPTS[dept]
            return (
              <section key={dept}>
                <header className="mb-2 flex items-center gap-2">
                  <span
                    className="rounded-md px-2 py-0.5 text-xs font-bold text-white"
                    style={{ background: d.color }}
                  >
                    {d.icon} {d.label}
                  </span>
                  <span className="text-xs text-gray-400">{items.length}명</span>
                </header>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {items.map((p) => (
                    <PersonaChip
                      key={p.id}
                      persona={p}
                      active={selectedId === p.id}
                      onSelect={setSelectedId}
                    />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      ) : (
        <div className="rounded-2xl border border-gray-200 bg-gray-50/50 p-4">
          <OrgChart personas={personas} onSelect={setSelectedId} selectedId={selectedId} />
        </div>
      )}

      <PersonaDetailPanel persona={selected} onClose={() => setSelectedId(null)} />
    </div>
  )
}
