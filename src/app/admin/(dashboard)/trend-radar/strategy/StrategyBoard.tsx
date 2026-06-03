'use client'
import { useMemo, useState, useEffect } from 'react'
import Link from 'next/link'

interface Row {
  id: string
  name: string
  category: string
  trend: number
  commerce: number
  supplier: number
  competition: number
  baseFinal: number
  components: any
}

type Axis = 'trend' | 'commerce' | 'supplier' | 'competition'

const AXES: { key: Axis; label: string; color: string }[] = [
  { key: 'trend', label: 'trend', color: '#10b981' },
  { key: 'commerce', label: 'commerce', color: '#f59e0b' },
  { key: 'supplier', label: 'supplier', color: '#3b82f6' },
  { key: 'competition', label: 'competition', color: '#a78bfa' },
]

// 기본(균형) 가중치 — 각 축 동일. "공정 baseline" 으로, churn 비교의 출발점.
const DEFAULT_WEIGHTS: Record<Axis, number> = {
  trend: 0.25,
  commerce: 0.25,
  supplier: 0.25,
  competition: 0.25,
}

const PRESET_BUILTINS: { name: string; w: Record<Axis, number> }[] = [
  { name: '균형 (기본)', w: { trend: 0.25, commerce: 0.25, supplier: 0.25, competition: 0.25 } },
  { name: '공격적 트렌드추종', w: { trend: 0.55, commerce: 0.25, supplier: 0.1, competition: 0.1 } },
  { name: '안전 공급우선', w: { trend: 0.15, commerce: 0.2, supplier: 0.45, competition: 0.2 } },
  { name: '경쟁회피 블루오션', w: { trend: 0.2, commerce: 0.2, supplier: 0.15, competition: 0.45 } },
  { name: '수익성 커머스', w: { trend: 0.2, commerce: 0.5, supplier: 0.2, competition: 0.1 } },
]

const LS_KEY = 'jimscanner_trends_weight_presets'

interface SavedPreset {
  name: string
  w: Record<Axis, number>
}

function normalize(w: Record<Axis, number>): Record<Axis, number> {
  const sum = AXES.reduce((s, a) => s + (w[a.key] || 0), 0)
  if (sum <= 0) return { ...DEFAULT_WEIGHTS }
  return {
    trend: w.trend / sum,
    commerce: w.commerce / sum,
    supplier: w.supplier / sum,
    competition: w.competition / sum,
  }
}

function blend(row: Row, w: Record<Axis, number>): number {
  return (
    row.trend * w.trend +
    row.commerce * w.commerce +
    row.supplier * w.supplier +
    row.competition * w.competition
  )
}

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  all: '#6b7280',
}

export default function StrategyBoard({ rows }: { rows: Row[] }) {
  const [weights, setWeights] = useState<Record<Axis, number>>({ ...DEFAULT_WEIGHTS })
  const [saved, setSaved] = useState<SavedPreset[]>([])
  const [presetName, setPresetName] = useState('')

  // localStorage 프리셋 로드
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) setSaved(JSON.parse(raw) as SavedPreset[])
    } catch {
      /* ignore */
    }
  }, [])

  const persist = (next: SavedPreset[]) => {
    setSaved(next)
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }

  const norm = useMemo(() => normalize(weights), [weights])

  // 기본(DB final_score) 랭킹 위치 맵 — "묻혀있던" 비교 기준
  const baseRankMap = useMemo(() => {
    const m = new Map<string, number>()
    ;[...rows]
      .sort((a, b) => b.baseFinal - a.baseFinal)
      .forEach((r, i) => m.set(r.id, i + 1))
    return m
  }, [rows])

  // 사용자 가중치 재랭킹 + churn 계산
  const ranked = useMemo(() => {
    const scored = rows.map((r) => ({
      row: r,
      userScore: blend(r, norm),
    }))
    scored.sort((a, b) => b.userScore - a.userScore)
    return scored.map((s, i) => {
      const userRank = i + 1
      const baseRank = baseRankMap.get(s.row.id) ?? userRank
      return {
        ...s,
        userRank,
        baseRank,
        churn: baseRank - userRank, // 양수 = 순위 상승 ▲
      }
    })
  }, [rows, norm, baseRankMap])

  // 숨은 후보: 가장 크게 상승한 상위 N (churn 큰 순), 상위권 진입한 것만
  const hidden = useMemo(
    () =>
      [...ranked]
        .filter((r) => r.churn > 0 && r.userRank <= 30)
        .sort((a, b) => b.churn - a.churn)
        .slice(0, 8),
    [ranked],
  )

  const setAxis = (axis: Axis, v: number) =>
    setWeights((w) => ({ ...w, [axis]: v }))

  const applyPreset = (w: Record<Axis, number>) => setWeights({ ...w })

  const savePreset = () => {
    const name = presetName.trim()
    if (!name) return
    const next = [
      ...saved.filter((p) => p.name !== name),
      { name, w: { ...norm } },
    ]
    persist(next)
    setPresetName('')
  }

  const deletePreset = (name: string) =>
    persist(saved.filter((p) => p.name !== name))

  const isDefault = AXES.every(
    (a) => Math.abs(norm[a.key] - DEFAULT_WEIGHTS[a.key]) < 0.001,
  )

  return (
    <div className="space-y-6">
      {/* 가중치 슬라이더 */}
      <section className="rounded border border-gray-200 p-4 space-y-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-gray-700">
            4축 가중치 <span className="text-xs font-normal text-gray-400 ml-1">(합 = 100% 자동 정규화)</span>
          </h2>
          <button
            onClick={() => applyPreset(DEFAULT_WEIGHTS)}
            className="text-xs text-gray-500 hover:text-black underline disabled:opacity-40"
            disabled={isDefault}
          >
            기본값으로 리셋
          </button>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {AXES.map((a) => (
            <div key={a.key} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium" style={{ color: a.color }}>
                  {a.label}
                </span>
                <span className="font-mono text-gray-600">
                  {(norm[a.key] * 100).toFixed(0)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(weights[a.key] * 100)}
                onChange={(e) => setAxis(a.key, Number(e.target.value) / 100)}
                className="w-full"
                style={{ accentColor: a.color }}
              />
            </div>
          ))}
        </div>

        {/* 프리셋 */}
        <div className="border-t border-gray-100 pt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-500">프리셋</span>
            {PRESET_BUILTINS.map((p) => (
              <button
                key={p.name}
                onClick={() => applyPreset(p.w)}
                className="px-2 py-1 text-xs rounded bg-gray-100 text-gray-700 hover:bg-gray-200"
              >
                {p.name}
              </button>
            ))}
          </div>
          {saved.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-gray-500">내 프리셋</span>
              {saved.map((p) => (
                <span
                  key={p.name}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-amber-50 border border-amber-200 text-amber-800"
                >
                  <button onClick={() => applyPreset(p.w)} className="hover:underline">
                    {p.name}
                  </button>
                  <button
                    onClick={() => deletePreset(p.name)}
                    className="text-amber-400 hover:text-red-600"
                    title="삭제"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && savePreset()}
              placeholder="현재 가중치 이름 저장…"
              className="text-xs border border-gray-200 rounded px-2 py-1 w-48 focus:outline-none focus:border-gray-400"
            />
            <button
              onClick={savePreset}
              disabled={!presetName.trim()}
              className="text-xs px-3 py-1 rounded bg-black text-white disabled:opacity-30"
            >
              저장
            </button>
            <span className="text-[10px] text-gray-400">브라우저 localStorage 보관</span>
          </div>
        </div>
      </section>

      {/* 숨은 후보 하이라이트 */}
      <section className="rounded border border-emerald-200 bg-emerald-50/50 p-4">
        <h2 className="text-sm font-semibold text-emerald-800 mb-1">
          💎 숨은 후보 <span className="text-xs font-normal text-emerald-600 ml-1">— 내 전략에서 가장 크게 떠오른 상품 (기본 랭킹 대비 ▲)</span>
        </h2>
        {hidden.length === 0 ? (
          <p className="text-xs text-emerald-700/70 py-2">
            현재 가중치는 기본 랭킹과 큰 차이가 없습니다. 슬라이더를 더 과감하게 움직여보세요.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2 mt-2">
            {hidden.map((h) => (
              <Link
                key={h.row.id}
                href={`/admin/trend-radar/products/${h.row.id}`}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded bg-white border border-emerald-200 hover:border-emerald-400 transition-colors"
              >
                <span className="text-xs font-mono text-emerald-700 font-bold">▲{h.churn}</span>
                <span className="text-sm truncate max-w-[200px]">{h.row.name}</span>
                <span className="text-[10px] text-gray-400 font-mono">
                  #{h.baseRank}→#{h.userRank}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* 재랭킹 테이블 */}
      <section>
        <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
          <div className="col-span-1">#</div>
          <div className="col-span-4">상품명</div>
          <div className="col-span-1 text-right">churn</div>
          <div className="col-span-1 text-right">내 점수</div>
          <div className="col-span-1 text-right">trend</div>
          <div className="col-span-1 text-right">comm</div>
          <div className="col-span-1 text-right">supp</div>
          <div className="col-span-1 text-right">comp</div>
          <div className="col-span-1 text-right">기본</div>
        </div>
        <div className="grid gap-1">
          {ranked.slice(0, 60).map((r) => (
            <Link
              key={r.row.id}
              href={`/admin/trend-radar/products/${r.row.id}`}
              className="grid grid-cols-12 items-center px-3 py-2 rounded border border-gray-200 hover:bg-gray-50 transition-colors"
            >
              <div className="col-span-1 text-gray-400 font-mono">{r.userRank}</div>
              <div className="col-span-4 min-w-0">
                <div className="font-medium truncate">{r.row.name}</div>
                <div className="text-xs" style={{ color: CATEGORY_COLORS[r.row.category] ?? '#6b7280' }}>
                  {r.row.category}
                </div>
              </div>
              <div className="col-span-1 text-right font-mono text-xs">
                {r.churn > 0 ? (
                  <span className="text-emerald-600 font-bold">▲{r.churn}</span>
                ) : r.churn < 0 ? (
                  <span className="text-red-500">▼{-r.churn}</span>
                ) : (
                  <span className="text-gray-300">–</span>
                )}
              </div>
              <div className="col-span-1 text-right font-mono font-bold">{r.userScore.toFixed(1)}</div>
              <div className="col-span-1 text-right font-mono text-gray-500">{r.row.trend.toFixed(0)}</div>
              <div className="col-span-1 text-right font-mono text-gray-500">{r.row.commerce.toFixed(0)}</div>
              <div className="col-span-1 text-right font-mono text-gray-500">{r.row.supplier.toFixed(0)}</div>
              <div className="col-span-1 text-right font-mono text-gray-500">{r.row.competition.toFixed(0)}</div>
              <div className="col-span-1 text-right font-mono text-gray-400">#{r.baseRank}</div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  )
}
