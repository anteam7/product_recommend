'use client'

import { useEffect } from 'react'
import { X } from 'lucide-react'
import { DEPTS, personaById, type Persona } from '@/lib/personas'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-5 py-4">
      <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-gray-400">{title}</h4>
      {children}
    </div>
  )
}

function Chips({ items, accent }: { items: string[]; accent?: string }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {/* items 는 personas.ts 의 정적 리스트(KPI·산출물 등)로 persona 내 고유·불변 → string 자체가 안정적 key */}
      {items.map((it) => (
        <span
          key={it}
          className="rounded-md px-2 py-1 text-[11px] font-semibold"
          style={
            accent
              ? { background: `${accent}0d`, color: accent, border: `1px solid ${accent}33` }
              : { background: '#f1f5f9', color: '#334155' }
          }
        >
          {it}
        </span>
      ))}
    </div>
  )
}

export default function PersonaDetailPanel({
  persona,
  onClose,
}: {
  persona: Persona | null
  onClose: () => void
}) {
  const open = persona !== null

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const p = persona
  // p.dept 는 타입상 Dept 이지만 잘못된 config 방어용 폴백.
  const dept = p ? DEPTS[p.dept] ?? { label: String(p.dept), color: '#64748b', icon: '•' } : null
  const manager = p?.reportsTo ? personaById(p.reportsTo) : null

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
        {p && dept && (
          <>
            <div className="relative px-5 pb-4 pt-5" style={{ background: `${p.accent}10` }}>
              <button
                type="button"
                onClick={onClose}
                aria-label="닫기"
                className="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-full bg-white/80 text-gray-500 shadow-sm hover:bg-white hover:text-gray-800"
              >
                <X size={16} />
              </button>
              <div className="flex items-center gap-3">
                <span
                  className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl text-2xl"
                  style={{ background: `${p.accent}1f` }}
                >
                  {p.emoji}
                </span>
                <div className="min-w-0">
                  <h3 className="text-base font-extrabold text-gray-900">{p.nameKr}</h3>
                  <p className="text-xs text-gray-500">{p.nameEn}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
                      style={{ background: dept.color }}
                    >
                      {dept.icon} {dept.label}
                    </span>
                    <span className="rounded-full border border-gray-300 bg-white px-2 py-0.5 text-[10px] font-semibold text-gray-600">
                      P{p.priority}
                    </span>
                    {p.status === 'planned' && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                        도입 예정
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <p className="mt-3 text-sm font-medium leading-relaxed text-gray-700">{p.tagline}</p>
            </div>

            <div className="divide-y divide-gray-100">
              <Section title="프레임워크 근거">
                <div className="space-y-1.5 text-sm text-gray-700">
                  <p>
                    <span className="font-semibold text-gray-500">가치사슬 · </span>
                    {p.framework.chain}
                  </p>
                  {p.framework.aarrr && (
                    <p>
                      <span className="font-semibold text-gray-500">AARRR · </span>
                      {p.framework.aarrr}
                    </p>
                  )}
                  <p className="text-xs leading-relaxed text-gray-500">{p.framework.why}</p>
                </div>
              </Section>

              <Section title="미션">
                <p className="text-sm leading-relaxed text-gray-700">{p.mission}</p>
              </Section>

              <Section title="핵심 책임">
                <ul className="space-y-1.5">
                  {p.responsibilities.map((r) => (
                    <li key={r} className="flex gap-2 text-sm text-gray-700">
                      <span className="mt-0.5 text-gray-300">•</span>
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </Section>

              <Section title="산출물">
                <Chips items={p.deliverables} accent={p.accent} />
              </Section>

              <Section title="성과 지표 (KPI)">
                <Chips items={p.kpis} accent={p.accent} />
              </Section>

              {p.tools.length > 0 && (
                <Section title="도구 · 화면">
                  <div className="flex flex-wrap gap-1.5">
                    {p.tools.map((t) =>
                      // href 는 개발자 작성 정적 config 의 내부 경로만 허용(외부 URL 차단).
                      t.href && t.href.startsWith('/') ? (
                        <a
                          key={t.label}
                          href={t.href}
                          className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-blue-600 hover:bg-blue-50"
                        >
                          {t.label} ↗
                        </a>
                      ) : (
                        <span
                          key={t.label}
                          className="rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs font-semibold text-gray-600"
                        >
                          {t.label}
                        </span>
                      ),
                    )}
                  </div>
                </Section>
              )}

              {p.harness && p.harness.length > 0 && (
                <Section title="연결된 하네스 (.claude)">
                  <Chips items={p.harness} />
                </Section>
              )}

              <Section title="조직 관계 (RACI)">
                <p className="mb-2 text-sm text-gray-700">{p.raci}</p>
                <div className="space-y-1 text-xs text-gray-500">
                  <p>
                    <span className="font-semibold">보고:</span>{' '}
                    {manager ? `${manager.emoji} ${manager.nameKr}` : '오너(최상위)'}
                  </p>
                  {p.collaborators.length > 0 && (
                    <p className="flex flex-wrap items-center gap-1">
                      <span className="font-semibold">협업:</span>
                      {p.collaborators.map((cid) => {
                        const c = personaById(cid)
                        return c ? (
                          <span key={cid} className="rounded bg-slate-100 px-1.5 py-0.5">
                            {c.emoji} {c.short}
                          </span>
                        ) : null
                      })}
                    </p>
                  )}
                </div>
              </Section>

              <Section title="위임 시드 (AI 위임 프롬프트)">
                <p className="rounded-lg bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-600">
                  {p.delegationSeed}
                </p>
              </Section>
            </div>
          </>
        )}
      </aside>
    </>
  )
}
