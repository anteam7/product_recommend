'use client'

import { useMemo, useState, useEffect, Fragment } from 'react'
import Link from 'next/link'

export interface LabRow {
  id: string
  name: string
  category: string
  trend: number
  commerce: number
  supplier: number
  competition: number
  baselineFinal: number
  components: Record<string, Record<string, number>>
  computedAt: string
}

export interface Profile {
  id: string
  name: string
  weights: Partial<Record<ComponentKey, number>>
}

type ComponentKey = 'trend' | 'commerce' | 'supplier' | 'competition'

const COMPONENTS: { key: ComponentKey; label: string; color: string }[] = [
  { key: 'trend', label: '트렌드', color: '#6366f1' },
  { key: 'commerce', label: '커머스', color: '#10b981' },
  { key: 'supplier', label: '공급', color: '#f59e0b' },
  { key: 'competition', label: '경쟁', color: '#ec4899' },
]

const DEFAULT_WEIGHTS: Record<ComponentKey, number> = {
  trend: 0.25,
  commerce: 0.25,
  supplier: 0.25,
  competition: 0.25,
}

const LS_KEY = 'trend-radar:scoring-lab:profiles'

function normalize(w: Record<ComponentKey, number>): Record<ComponentKey, number> {
  const sum = COMPONENTS.reduce((acc, c) => acc + (w[c.key] || 0), 0)
  if (sum <= 0) return { ...DEFAULT_WEIGHTS }
  return {
    trend: w.trend / sum,
    commerce: w.commerce / sum,
    supplier: w.supplier / sum,
    competition: w.competition / sum,
  }
}

function computeFinal(row: LabRow, nw: Record<ComponentKey, number>): number {
  return (
    nw.trend * row.trend +
    nw.commerce * row.commerce +
    nw.supplier * row.supplier +
    nw.competition * row.competition
  )
}

export default function ScoringLab({ rows, profiles }: { rows: LabRow[]; profiles: Profile[] }) {
  const [weights, setWeights] = useState<Record<ComponentKey, number>>({ ...DEFAULT_WEIGHTS })
  const [category, setCategory] = useState<string>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [localProfiles, setLocalProfiles] = useState<Profile[]>([])
  const [newName, setNewName] = useState('')

  // localStorage 프로파일 로드
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) setLocalProfiles(JSON.parse(raw))
    } catch {
      /* ignore */
    }
  }, [])

  const allProfiles = useMemo(() => [...profiles, ...localProfiles], [profiles, localProfiles])

  const categories = useMemo(() => {
    const s = new Set<string>()
    rows.forEach((r) => s.add(r.category))
    return ['all', ...Array.from(s).sort()]
  }, [rows])

  const nw = useMemo(() => normalize(weights), [weights])

  // 기본 가중치(균형) 기준 랭크 — Δrank 비교용
  const baselineRankById = useMemo(() => {
    const sorted = [...rows].sort(
      (a, b) => computeFinal(b, DEFAULT_WEIGHTS) - computeFinal(a, DEFAULT_WEIGHTS),
    )
    const m = new Map<string, number>()
    sorted.forEach((r, i) => m.set(r.id, i + 1))
    return m
  }, [rows])

  const ranked = useMemo(() => {
    const filtered = category === 'all' ? rows : rows.filter((r) => r.category === category)
    const withFinal = filtered.map((r) => ({ row: r, final: computeFinal(r, nw) }))
    withFinal.sort((a, b) => b.final - a.final)
    return withFinal.map((x, i) => {
      const baseRank = baselineRankById.get(x.row.id) ?? i + 1
      return {
        ...x,
        rank: i + 1,
        deltaRank: baseRank - (i + 1), // 양수 = 순위 상승
      }
    })
  }, [rows, category, nw, baselineRankById])

  function applyProfile(p: Profile) {
    setWeights({
      trend: p.weights.trend ?? 0,
      commerce: p.weights.commerce ?? 0,
      supplier: p.weights.supplier ?? 0,
      competition: p.weights.competition ?? 0,
    })
  }

  function saveLocalProfile() {
    const name = newName.trim()
    if (!name) return
    const next = [
      ...localProfiles.filter((p) => p.name !== name),
      { id: `local:${name}`, name, weights: { ...weights } },
    ]
    setLocalProfiles(next)
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
    setNewName('')
  }

  function deleteLocalProfile(id: string) {
    const next = localProfiles.filter((p) => p.id !== id)
    setLocalProfiles(next)
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="space-y-6">
      {/* 가중치 컨트롤 */}
      <div className="grid grid-cols-1 gap-6 rounded-lg border border-gray-200 bg-white p-5 lg:grid-cols-2">
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-gray-700">컴포넌트 가중치</h2>
          {COMPONENTS.map((c) => (
            <div key={c.key} className="flex items-center gap-3">
              <span className="w-14 text-sm" style={{ color: c.color }}>
                {c.label}
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round((weights[c.key] || 0) * 100)}
                onChange={(e) =>
                  setWeights((w) => ({ ...w, [c.key]: Number(e.target.value) / 100 }))
                }
                className="flex-1"
                style={{ accentColor: c.color }}
              />
              <span className="w-12 text-right text-sm tabular-nums text-gray-600">
                {Math.round(nw[c.key] * 100)}%
              </span>
            </div>
          ))}
          <p className="text-xs text-gray-400">
            슬라이더는 상대 비율 — 합이 100%가 되도록 자동 정규화됩니다.
          </p>
        </div>

        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-gray-700">위험성향 프리셋</h2>
          <div className="flex flex-wrap gap-2">
            {allProfiles.length === 0 && (
              <span className="text-xs text-gray-400">저장된 프리셋 없음</span>
            )}
            {allProfiles.map((p) => (
              <span key={p.id} className="inline-flex items-center">
                <button
                  onClick={() => applyProfile(p)}
                  className="rounded-l border border-gray-300 bg-gray-50 px-3 py-1 text-xs hover:bg-gray-100"
                >
                  {p.name}
                </button>
                {p.id.startsWith('local:') && (
                  <button
                    onClick={() => deleteLocalProfile(p.id)}
                    title="삭제 (로컬)"
                    className="rounded-r border border-l-0 border-gray-300 bg-gray-50 px-1.5 py-1 text-xs text-gray-400 hover:bg-red-50 hover:text-red-500"
                  >
                    ✕
                  </button>
                )}
              </span>
            ))}
          </div>
          <div className="flex gap-2 pt-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="현재 가중치를 프리셋으로 저장 (로컬)"
              className="flex-1 rounded border border-gray-300 px-2 py-1 text-xs"
            />
            <button
              onClick={saveLocalProfile}
              className="rounded bg-gray-900 px-3 py-1 text-xs text-white hover:bg-black"
            >
              저장
            </button>
          </div>
          <button
            onClick={() => setWeights({ ...DEFAULT_WEIGHTS })}
            className="text-xs text-gray-500 underline hover:text-black"
          >
            기본(균형 25/25/25/25)으로 리셋
          </button>
        </div>
      </div>

      {/* 카테고리 필터 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500">카테고리:</span>
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setCategory(cat)}
            className={`rounded-full px-3 py-1 text-xs ${
              category === cat
                ? 'bg-gray-900 text-white'
                : 'border border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            {cat}
          </button>
        ))}
        <span className="ml-auto text-xs text-gray-400">{ranked.length}개 후보</span>
      </div>

      {/* 재랭킹 테이블 */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs text-gray-500">
            <tr>
              <th className="w-12 px-3 py-2">순위</th>
              <th className="w-16 px-3 py-2">Δ</th>
              <th className="px-3 py-2">상품</th>
              <th className="w-20 px-3 py-2 text-right">내 점수</th>
              <th className="w-20 px-3 py-2 text-right">기존</th>
              <th className="w-8 px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((x) => {
              const isOpen = expanded === x.row.id
              return (
                <Fragment key={x.row.id}>
                  <tr
                    className="cursor-pointer border-t border-gray-100 hover:bg-gray-50"
                    onClick={() => setExpanded(isOpen ? null : x.row.id)}
                  >
                    <td className="px-3 py-2 font-semibold tabular-nums">{x.rank}</td>
                    <td className="px-3 py-2">
                      <DeltaArrow delta={x.deltaRank} />
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/admin/trend-radar/products/${x.row.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="hover:underline"
                      >
                        {x.row.name}
                      </Link>
                      <span className="ml-2 text-xs text-gray-400">{x.row.category}</span>
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">
                      {x.final.toFixed(1)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-400">
                      {x.row.baselineFinal.toFixed(1)}
                    </td>
                    <td className="px-3 py-2 text-gray-400">{isOpen ? '▾' : '▸'}</td>
                  </tr>
                  {isOpen && (
                    <tr className="border-t border-gray-100 bg-gray-50/50">
                      <td colSpan={6} className="px-6 py-4">
                        <Waterfall row={x.row} nw={nw} final={x.final} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function DeltaArrow({ delta }: { delta: number }) {
  if (delta === 0) return <span className="text-xs text-gray-300">—</span>
  if (delta > 0)
    return (
      <span className="text-xs font-semibold text-emerald-600" title="순위 상승">
        ▲{delta}
      </span>
    )
  return (
    <span className="text-xs font-semibold text-red-500" title="순위 하락">
      ▼{Math.abs(delta)}
    </span>
  )
}

// 가중 기여도를 누적해 final 까지 쌓는 순수 SVG 워터폴 (외부 차트 의존성 없음)
function Waterfall({
  row,
  nw,
  final,
}: {
  row: LabRow
  nw: Record<ComponentKey, number>
  final: number
}) {
  const W = 360
  const H = 180
  const PAD_L = 28
  const PAD_B = 22
  const PAD_T = 8
  const plotW = W - PAD_L - 8
  const plotH = H - PAD_B - PAD_T
  const yMax = 100
  const yScale = (v: number) => PAD_T + plotH - (v / yMax) * plotH

  let cum = 0
  const bars = COMPONENTS.map((c, i) => {
    const contribution = nw[c.key] * row[c.key]
    const base = cum
    cum += contribution
    const slot = plotW / COMPONENTS.length
    const bw = slot * 0.6
    const cx = PAD_L + slot * i + (slot - bw) / 2
    return {
      key: c.key,
      label: c.label,
      color: c.color,
      raw: row[c.key],
      weight: nw[c.key],
      contribution,
      x: cx,
      width: bw,
      yTop: yScale(base + contribution),
      yBottom: yScale(base),
    }
  })

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
      <div>
        <p className="mb-2 text-xs font-semibold text-gray-600">
          이 후보가 <span className="text-gray-900">{final.toFixed(1)}점</span>인 이유 (가중 기여
          분해)
        </p>
        <svg width={W} height={H} className="max-w-full">
          {/* y 그리드 */}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={v}>
              <line
                x1={PAD_L}
                y1={yScale(v)}
                x2={W - 8}
                y2={yScale(v)}
                stroke="#eee"
                strokeDasharray={v === 0 ? '' : '2,3'}
              />
              <text x={PAD_L - 4} y={yScale(v) + 3} fontSize="9" fill="#9ca3af" textAnchor="end">
                {v}
              </text>
            </g>
          ))}
          {/* 워터폴 막대 + 연결선 */}
          {bars.map((b, i) => (
            <g key={b.key}>
              {i > 0 && (
                <line
                  x1={bars[i - 1].x + bars[i - 1].width}
                  y1={bars[i - 1].yTop}
                  x2={b.x}
                  y2={b.yBottom}
                  stroke="#d1d5db"
                  strokeDasharray="2,2"
                />
              )}
              <rect
                x={b.x}
                y={b.yTop}
                width={b.width}
                height={Math.max(1, b.yBottom - b.yTop)}
                fill={b.color}
                fillOpacity={0.75}
                rx={2}
              >
                <title>
                  {b.label}: 원시 {b.raw.toFixed(0)} × {Math.round(b.weight * 100)}% = +
                  {b.contribution.toFixed(1)}
                </title>
              </rect>
              <text
                x={b.x + b.width / 2}
                y={b.yTop - 3}
                fontSize="9"
                fill="#374151"
                textAnchor="middle"
              >
                +{b.contribution.toFixed(1)}
              </text>
              <text
                x={b.x + b.width / 2}
                y={H - PAD_B + 12}
                fontSize="9"
                fill="#6b7280"
                textAnchor="middle"
              >
                {b.label}
              </text>
            </g>
          ))}
        </svg>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold text-gray-600">원시 하위신호 (score_components)</p>
        {COMPONENTS.map((c) => {
          const sub = row.components?.[c.key]
          const subEntries =
            sub && typeof sub === 'object' ? Object.entries(sub as Record<string, number>) : []
          return (
            <div key={c.key} className="text-xs">
              <div className="flex items-center justify-between">
                <span className="font-medium" style={{ color: c.color }}>
                  {c.label} · {row[c.key].toFixed(0)}
                </span>
                <span className="text-gray-400">기여 +{(nw[c.key] * row[c.key]).toFixed(1)}</span>
              </div>
              {subEntries.length > 0 && (
                <div className="ml-2 flex flex-wrap gap-x-3 gap-y-0.5 text-gray-500">
                  {subEntries.map(([k, v]) => (
                    <span key={k}>
                      {k}: {typeof v === 'number' ? v.toFixed(0) : String(v)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
