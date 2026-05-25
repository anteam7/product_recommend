import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  summarizePersona,
  PERSONA_AGES,
  PERSONA_AGE_LABEL,
  PERSONA_GENDER_LABEL,
  PERSONA_DEVICE_LABEL,
  type DemographicCell,
  type PersonaSummary,
} from '@/lib/trends/demographics'

export const dynamic = 'force-dynamic'

const AGES = PERSONA_AGES as readonly string[]
const GENDERS = ['m', 'f'] as const
const DEVICES = ['pc', 'mo'] as const

type DemoRow = DemographicCell & { collected_at: string }

async function fetchData() {
  const sb = createAdminClient()

  // 1) 최신 demographics: 각 키워드별로 가장 최근 collected_at 만.
  // 뷰 적용 전 단계도 안전하게 동작하도록 raw 테이블에서 직접 가져온 뒤 후처리.
  const { data: rawCells } = await (sb as unknown as {
    from: (table: string) => {
      select: (cols: string) => Promise<{
        data: Array<DemoRow> | null
      }>
    }
  })
    .from('jimscanner_trends_demographics')
    .select('keyword, age, gender, device, ratio_normalized, collected_at')

  // 키워드별 최신 collected_at 의 24 cell 만 유지
  const latestByKw = new Map<string, string>()
  for (const r of (rawCells ?? [])) {
    const prev = latestByKw.get(r.keyword)
    if (!prev || r.collected_at > prev) latestByKw.set(r.keyword, r.collected_at)
  }
  const cellsByKw = new Map<string, DemographicCell[]>()
  for (const r of (rawCells ?? [])) {
    if (latestByKw.get(r.keyword) !== r.collected_at) continue
    const arr = cellsByKw.get(r.keyword) ?? []
    arr.push({
      keyword: r.keyword,
      age: r.age,
      gender: r.gender,
      device: r.device,
      ratio_normalized: r.ratio_normalized,
    })
    cellsByKw.set(r.keyword, arr)
  }

  const personas: Array<PersonaSummary & { cellMap: Record<string, number> }> = []
  for (const [, cells] of cellsByKw) {
    const s = summarizePersona(cells)
    if (s) {
      const cellMap: Record<string, number> = {}
      for (const c of cells) {
        cellMap[`${c.age}|${c.gender}|${c.device}`] = c.ratio_normalized ?? 0
      }
      personas.push({ ...s, cellMap })
    }
  }
  personas.sort((a, b) => a.entropy - b.entropy) // 편중 강한 순

  // 2) ggsan 카탈로그 cate_label 매핑 (있을 때만)
  const { data: ggsan } = await sb
    .from('jimscanner_ggsan_products')
    .select('title, cate_label')
    .limit(2000)
  type GgsanRow = { title: string | null; cate_label: string | null }
  const ggsanRows = (ggsan ?? []) as GgsanRow[]

  // 카테고리 라벨별 페르소나 평균 분포 — 키워드를 title 안에 포함하는 ggsan 행을 매핑.
  const cateAgeAcc = new Map<string, { count: number; ageDist: Record<string, number> }>()
  for (const p of personas) {
    for (const g of ggsanRows) {
      if (!g.cate_label || !g.title) continue
      if (!g.title.includes(p.keyword)) continue
      const acc = cateAgeAcc.get(g.cate_label) ?? { count: 0, ageDist: {} }
      acc.count += 1
      for (const [age, ratio] of Object.entries(p.ageDist)) {
        acc.ageDist[age] = (acc.ageDist[age] ?? 0) + ratio
      }
      cateAgeAcc.set(g.cate_label, acc)
    }
  }
  const cateRows = Array.from(cateAgeAcc.entries())
    .map(([cate, v]) => ({
      cate,
      count: v.count,
      ageDist: Object.fromEntries(
        Object.entries(v.ageDist).map(([k, val]) => [k, val / Math.max(v.count, 1)]),
      ) as Record<string, number>,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30)

  return { personas, cateRows }
}

function heatColor(r: number): string {
  // r 0~1, soft green→amber→red
  if (r <= 0) return '#f8fafc'
  const clamped = Math.min(1, Math.max(0, r * 3)) // boost (each cell 보통 <0.1)
  const hue = 160 - 160 * clamped // 160(green) → 0(red)
  return `hsl(${hue}, 75%, ${88 - clamped * 35}%)`
}

export default async function PersonasPage() {
  const { personas, cateRows } = await fetchData()

  return (
    <div className="space-y-8 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">인구·디바이스 페르소나 매핑</h1>
          <p className="text-sm text-gray-500 mt-1">
            Naver DataLab age/gender/device 매트릭스 — 키워드별 1등 페르소나·엔트로피·광고 매체 추천.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {personas.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 수집된 페르소나 데이터가 없습니다.</p>
          <p className="text-sm mt-2 font-mono">
            node --env-file=.env.local scripts/collect-trends-demographics.mjs
          </p>
          <p className="text-xs mt-2">또는 cron <code>/api/cron/collect-naver-trend-demographics</code> 실행.</p>
        </div>
      ) : (
        <>
          {/* 키워드별 페르소나 카드 + 히트맵 */}
          <section className="space-y-4">
            <h2 className="text-lg font-semibold">키워드별 페르소나 히트맵</h2>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {personas.map((p) => (
                <div key={p.keyword} className="rounded border border-gray-200 p-4 bg-white">
                  <div className="flex items-baseline justify-between mb-3">
                    <div>
                      <div className="font-semibold text-base">{p.keyword}</div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        엔트로피 <span className="font-mono">{p.entropy.toFixed(2)}</span>
                      </div>
                    </div>
                    <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
                      {p.primaryLabel}
                    </span>
                  </div>

                  {/* 6 (age) × 4 (M/F × PC/MO) heatmap */}
                  <table className="w-full text-[10px] border-collapse">
                    <thead>
                      <tr>
                        <th className="text-left text-gray-500 font-normal">age</th>
                        {GENDERS.flatMap((g) =>
                          DEVICES.map((d) => (
                            <th key={`${g}${d}`} className="text-center text-gray-500 font-normal">
                              {PERSONA_GENDER_LABEL[g]}·{PERSONA_DEVICE_LABEL[d]}
                            </th>
                          )),
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {AGES.map((age) => (
                        <tr key={age}>
                          <td className="py-0.5 pr-2 text-gray-600">{PERSONA_AGE_LABEL[age] ?? age}</td>
                          {GENDERS.flatMap((g) =>
                            DEVICES.map((d) => {
                              const r = p.cellMap[`${age}|${g}|${d}`] ?? 0
                              return (
                                <td
                                  key={`${age}${g}${d}`}
                                  className="text-center text-gray-700 font-mono py-0.5"
                                  style={{ backgroundColor: heatColor(r) }}
                                >
                                  {r > 0 ? Math.round(r * 100) : ''}
                                </td>
                              )
                            }),
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {/* age summary bar */}
                  <div className="mt-3">
                    <div className="text-[10px] text-gray-500 mb-1">연령 분포</div>
                    <div className="flex gap-0.5">
                      {AGES.map((age) => {
                        const r = p.ageDist[age] ?? 0
                        return (
                          <div
                            key={age}
                            title={`${PERSONA_AGE_LABEL[age] ?? age}: ${Math.round(r * 100)}%`}
                            className="flex-1 text-[9px] text-center text-gray-700 py-1"
                            style={{ backgroundColor: heatColor(r) }}
                          >
                            {Math.round(r * 100)}
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  <div className="mt-3 rounded bg-blue-50 px-3 py-2 text-xs">
                    <div className="font-medium text-blue-900">광고 매체 추천: {p.adChannel}</div>
                    <div className="text-blue-700 mt-0.5">{p.adReason}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* 카테고리 vs 인구 페르소나 정합도 */}
          {cateRows.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">ggsan 카테고리 × 연령 페르소나 정합도</h2>
              <p className="text-xs text-gray-500">
                ggsan 카탈로그 title 안에 키워드를 포함하는 상품들의 평균 연령 분포.
                — 카테고리 단위 광고 타겟 페르소나 진단용.
              </p>
              <div className="overflow-x-auto rounded border border-gray-200">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-50 text-gray-600">
                    <tr>
                      <th className="px-3 py-2 text-left">cate_label</th>
                      <th className="px-3 py-2 text-right">매칭수</th>
                      {AGES.map((age) => (
                        <th key={age} className="px-3 py-2 text-center">
                          {PERSONA_AGE_LABEL[age] ?? age}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {cateRows.map((row) => (
                      <tr key={row.cate} className="border-t border-gray-100">
                        <td className="px-3 py-2 font-medium">{row.cate}</td>
                        <td className="px-3 py-2 text-right font-mono text-gray-500">{row.count}</td>
                        {AGES.map((age) => {
                          const r = row.ageDist[age] ?? 0
                          return (
                            <td
                              key={age}
                              className="px-3 py-2 text-center font-mono"
                              style={{ backgroundColor: heatColor(r) }}
                            >
                              {r > 0 ? Math.round(r * 100) : ''}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
