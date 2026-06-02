'use client'

import { useMemo, useState } from 'react'
import {
  AGE_BUCKET_KEYS,
  GENDER_KEYS,
  GENDER_LABEL,
  type AgeBucketKey,
} from '@/lib/trends/demographics'

export type DemoRow = {
  keyword: string
  source: string
  collectedAt: string
  concentration: number
  dominantAge: AgeBucketKey | null
  dominantGender: 'm' | 'f' | null
  dominantLabel: string
  ageShares: Record<AgeBucketKey, number>
  genderShares: { m: number; f: number }
}

type Filter = 'all' | 'niche' | 'broad'

const NICHE_THRESHOLD = 0.25

function heatColor(share: number): string {
  // 0 → 옅음, 0.5+ → 진한 인디고
  const t = Math.min(1, share / 0.5)
  const light = Math.round(96 - t * 56) // 96% → 40%
  return `hsl(245 60% ${light}%)`
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`
}

export default function DemographicsBoard({ rows }: { rows: DemoRow[] }) {
  const [filter, setFilter] = useState<Filter>('all')

  const filtered = useMemo(() => {
    const base =
      filter === 'niche'
        ? rows.filter((r) => r.concentration >= NICHE_THRESHOLD)
        : filter === 'broad'
          ? rows.filter((r) => r.concentration < NICHE_THRESHOLD)
          : rows
    return [...base].sort((a, b) => b.concentration - a.concentration)
  }, [rows, filter])

  return (
    <div className="space-y-8">
      {/* 토글 */}
      <div className="flex items-center gap-2">
        {(
          [
            ['all', '전체'],
            ['niche', `협소 니치 (집중도 ≥ ${pct(NICHE_THRESHOLD)})`],
            ['broad', '범용'],
          ] as [Filter, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`rounded-full border px-3 py-1 text-sm transition ${
              filter === key
                ? 'border-indigo-600 bg-indigo-600 text-white'
                : 'border-gray-300 bg-white text-gray-600 hover:border-gray-400'
            }`}
          >
            {label}
          </button>
        ))}
        <span className="ml-auto text-sm text-gray-400">{filtered.length}개</span>
      </div>

      {/* 집중 니치 리스트 */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">집중 니치 — 주력 세그먼트별</h2>
        <p className="text-sm text-gray-500">
          집중도가 높을수록 특정 연령·성별에 편중 → 대형셀러가 비우는 틈새. 예: 40~50대 여성 편중은
          청년 셀러 경쟁을 피할 단서.
        </p>
        <div className="overflow-hidden rounded-lg border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">키워드 / 카테고리</th>
                <th className="px-4 py-2 font-medium">주력 세그먼트</th>
                <th className="px-4 py-2 font-medium">타겟 집중도</th>
                <th className="px-4 py-2 font-medium">소스</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={`${r.keyword}-${r.source}`} className="border-t border-gray-100">
                  <td className="px-4 py-2 font-medium text-gray-900">{r.keyword}</td>
                  <td className="px-4 py-2">
                    <span className="rounded bg-indigo-50 px-2 py-0.5 text-indigo-700">
                      {r.dominantLabel}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-24 overflow-hidden rounded bg-gray-100">
                        <div
                          className="h-full bg-indigo-500"
                          style={{ width: pct(r.concentration) }}
                        />
                      </div>
                      <span className="tabular-nums text-gray-600">{pct(r.concentration)}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2 text-gray-400">
                    {r.source === 'naver_shopping_insight' ? '쇼핑' : '검색'}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-gray-400">
                    조건에 맞는 항목 없음
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 연령 × 성별 히트맵 */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">연령 × 성별 히트맵</h2>
        <p className="text-sm text-gray-500">각 행 = 연령 분포(합 100%). 진할수록 비중 높음.</p>
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">키워드</th>
                {AGE_BUCKET_KEYS.map((a) => (
                  <th key={a} className="px-3 py-2 text-center font-medium">
                    {a}
                  </th>
                ))}
                {GENDER_KEYS.map((g) => (
                  <th key={g} className="px-3 py-2 text-center font-medium">
                    {GENDER_LABEL[g]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={`hm-${r.keyword}-${r.source}`} className="border-t border-gray-100">
                  <td className="px-3 py-2 font-medium text-gray-900">{r.keyword}</td>
                  {AGE_BUCKET_KEYS.map((a) => {
                    const s = r.ageShares[a] ?? 0
                    return (
                      <td
                        key={a}
                        className="px-3 py-2 text-center tabular-nums"
                        style={{ background: heatColor(s), color: s > 0.3 ? '#fff' : '#374151' }}
                      >
                        {s > 0 ? pct(s) : '·'}
                      </td>
                    )
                  })}
                  {GENDER_KEYS.map((g) => {
                    const s = r.genderShares[g] ?? 0
                    return (
                      <td
                        key={g}
                        className="px-3 py-2 text-center tabular-nums"
                        style={{ background: heatColor(s), color: s > 0.3 ? '#fff' : '#374151' }}
                      >
                        {s > 0 ? pct(s) : '·'}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
