'use client'

/**
 * 인구통계 페르소나 핏 보드 — 순수 SVG/CSS, 의존성 없음.
 *
 * ① 성별×연령 히트맵: 후보별로 '누가 사는가' 를 한눈에.
 * ② 페르소나 사분면: X=집중도(엔트로피 낮음=타겟 또렷), Y=수요 상승.
 *    우상단(집중도 높고 상승) = 광고·상세·묶음 설계가 쉬운 위탁 우선 큐.
 */

import { useMemo, useState } from 'react'

export const AGE_ORDER = ['10s', '20s', '30s', '40s', '50s+'] as const
export const GENDER_ORDER = ['f', 'm'] as const

export type PersonaCell = { gender: string; age_bucket: string; ratio: number }

export type PersonaProfile = {
  keyword: string
  source: string
  category?: string | null
  cells: PersonaCell[]
  demand: number // 0~100 (세그먼트 평균 ratio 합의 상대치)
  concentration: number // 0~100 (높을수록 단일 페르소나)
  demandRise: number // 0~100 (50=보합, >50 상승)
  topPersona: string // 'f·30s' 등 최강 세그먼트 라벨
}

type Props = {
  profiles: PersonaProfile[]
}

function cellRatio(p: PersonaProfile, gender: string, age: string): number {
  return p.cells.find((c) => c.gender === gender && c.age_bucket === age)?.ratio ?? 0
}

function Heatmap({ p, max }: { p: PersonaProfile; max: number }) {
  return (
    <div className="inline-grid" style={{ gridTemplateColumns: `28px repeat(${AGE_ORDER.length}, 1fr)` }}>
      <div />
      {AGE_ORDER.map((a) => (
        <div key={a} className="px-1 pb-1 text-center text-[10px] text-neutral-500">
          {a}
        </div>
      ))}
      {GENDER_ORDER.map((g) => (
        <FragmentRow key={g} p={p} g={g} max={max} />
      ))}
    </div>
  )
}

function FragmentRow({ p, g, max }: { p: PersonaProfile; g: string; max: number }) {
  return (
    <>
      <div className="flex items-center justify-end pr-1 text-[10px] text-neutral-500">
        {g === 'f' ? '여' : '남'}
      </div>
      {AGE_ORDER.map((a) => {
        const r = cellRatio(p, g, a)
        const op = max > 0 ? Math.max(0.04, r / max) : 0.04
        return (
          <div
            key={a}
            className="m-[1px] flex h-7 items-center justify-center rounded-sm text-[9px]"
            style={{ backgroundColor: `rgba(37, 99, 235, ${op})`, color: op > 0.55 ? '#fff' : '#475569' }}
            title={`${g === 'f' ? '여성' : '남성'} ${a}: ${r.toFixed(1)}`}
          >
            {r >= 1 ? Math.round(r) : ''}
          </div>
        )
      })}
    </>
  )
}

const W = 720
const H = 480
const PAD = 48

function Quadrant({ profiles, onPick }: { profiles: PersonaProfile[]; onPick: (k: string) => void }) {
  const [hover, setHover] = useState<PersonaProfile | null>(null)
  const sx = (x: number) => PAD + (x / 100) * (W - 2 * PAD)
  const sy = (y: number) => H - PAD - (y / 100) * (H - 2 * PAD)
  const midX = sx(50)
  const midY = sy(50)

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
        <rect x={PAD} y={PAD} width={W - 2 * PAD} height={(H - 2 * PAD) / 2} fill="#f8fafc" />
        <rect x={midX} y={PAD} width={(W - 2 * PAD) / 2} height={(H - 2 * PAD) / 2} fill="#eff6ff" />
        <line x1={midX} y1={PAD} x2={midX} y2={H - PAD} stroke="#e5e7eb" />
        <line x1={PAD} y1={midY} x2={W - PAD} y2={midY} stroke="#e5e7eb" />
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#94a3b8" strokeWidth={1.5} />
        <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="#94a3b8" strokeWidth={1.5} />

        <text x={midX + (W - 2 * PAD) / 4} y={PAD + 16} textAnchor="middle" className="fill-blue-400 text-[11px]">
          ★ 우선 큐 (타겟 또렷 · 상승)
        </text>

        {profiles.map((p, i) => {
          const cx = sx(p.concentration)
          const cy = sy(p.demandRise)
          const active = hover?.keyword === p.keyword
          const r = 4 + Math.min(8, p.demand / 12)
          return (
            <circle
              key={`${p.keyword}-${i}`}
              cx={cx}
              cy={cy}
              r={active ? r + 2 : r}
              fill={active ? '#1d4ed8' : '#3b82f6'}
              opacity={active ? 1 : 0.7}
              onMouseEnter={() => setHover(p)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onPick(p.keyword)}
              style={{ cursor: 'pointer' }}
            />
          )
        })}

        <text x={W / 2} y={H - 12} textAnchor="middle" className="fill-neutral-500 text-xs">
          페르소나 집중도 (타겟 또렷함) →
        </text>
        <text
          x={16}
          y={H / 2}
          textAnchor="middle"
          className="fill-neutral-500 text-xs"
          transform={`rotate(-90 16 ${H / 2})`}
        >
          ← 페르소나 수요 상승
        </text>
      </svg>

      {hover && (
        <div className="absolute right-2 top-2 rounded-md border bg-white px-3 py-2 text-xs shadow">
          <div className="font-medium">{hover.keyword}</div>
          <div className="text-neutral-500">
            최강 {hover.topPersona} · 집중도 {Math.round(hover.concentration)} · 수요 {Math.round(hover.demand)}
          </div>
        </div>
      )}
    </div>
  )
}

export default function PersonaBoard({ profiles }: Props) {
  const [picked, setPicked] = useState<string | null>(null)

  const ranked = useMemo(
    () =>
      [...profiles].sort(
        (a, b) =>
          b.concentration + b.demandRise + b.demand - (a.concentration + a.demandRise + a.demand),
      ),
    [profiles],
  )

  const selected = picked ? profiles.find((p) => p.keyword === picked) ?? ranked[0] : ranked[0]
  const globalMax = useMemo(
    () => Math.max(1, ...profiles.flatMap((p) => p.cells.map((c) => c.ratio))),
    [profiles],
  )

  if (profiles.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-neutral-50 p-8 text-center text-sm text-neutral-500">
        아직 인구통계 데이터가 없습니다. <code>collectNaverDemographics</code> 크론이 1회 이상 돌면
        성별×연령 프로파일이 채워집니다.
        <div className="mt-1 text-xs text-neutral-400">
          (수집 라우트: <code>/api/cron/collect-naver-demographics</code>)
        </div>
      </div>
    )
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="rounded-lg border bg-white p-4">
        <h2 className="mb-1 text-sm font-medium">페르소나 사분면</h2>
        <p className="mb-2 text-xs text-neutral-500">
          버블 클릭 → 우측 히트맵 갱신. 크기 = 절대 수요.
        </p>
        <Quadrant profiles={profiles} onPick={setPicked} />
      </div>

      <div className="space-y-4">
        {selected && (
          <div className="rounded-lg border bg-white p-4">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-sm font-medium">{selected.keyword}</h2>
              <span className="text-xs text-neutral-500">{selected.source}</span>
            </div>
            <Heatmap p={selected} max={globalMax} />
            <div className="mt-2 text-xs text-neutral-600">
              최강 페르소나 <b>{selected.topPersona}</b> · 집중도 {Math.round(selected.concentration)} ·
              수요상승 {Math.round(selected.demandRise)}
            </div>
          </div>
        )}

        <div className="rounded-lg border bg-white">
          <div className="border-b px-3 py-2 text-xs font-medium text-neutral-500">우선 큐</div>
          <ul className="divide-y">
            {ranked.slice(0, 12).map((p) => (
              <li key={p.keyword}>
                <button
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-neutral-50"
                  onClick={() => setPicked(p.keyword)}
                >
                  <span className="truncate">{p.keyword}</span>
                  <span className="ml-2 shrink-0 text-xs text-neutral-500">
                    {p.topPersona} · 집중 {Math.round(p.concentration)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
