import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

const CATEGORIES = ['all', 'health', 'living', 'digital'] as const
type Category = (typeof CATEGORIES)[number]
const CATEGORY_LABEL: Record<Category, string> = {
  all: '전체',
  health: '건강식품',
  living: '생활/리빙',
  digital: '디지털/가전',
}

// 6개 시각속성 축 정의 — extract-vision-attrs.mjs 의 라벨링 결과와 동기
const AXES = [
  {
    key: 'primary_color',
    label: '주조색',
    values: [
      { v: 'beige', label: '베이지' },
      { v: 'pastel', label: '파스텔' },
      { v: 'vivid', label: '원색' },
      { v: 'mono', label: '모노톤' },
      { v: 'other', label: '기타' },
    ],
  },
  {
    key: 'package_form',
    label: '패키지 형태',
    values: [
      { v: 'pouch', label: '파우치' },
      { v: 'bottle', label: '병' },
      { v: 'box', label: '박스' },
      { v: 'zipper', label: '지퍼' },
      { v: 'stick', label: '스틱' },
      { v: 'other', label: '기타' },
    ],
  },
  {
    key: 'design_style',
    label: '디자인 스타일',
    values: [
      { v: 'minimal', label: '미니멀' },
      { v: 'retro', label: '레트로' },
      { v: 'natural', label: '내추럴' },
      { v: 'kpop', label: '케이팝' },
      { v: 'other', label: '기타' },
    ],
  },
  {
    key: 'model_in_scene',
    label: '모델/사용씬',
    values: [
      { v: 'true', label: '있음' },
      { v: 'false', label: '없음' },
    ],
  },
  {
    key: 'has_korean',
    label: '한글표기',
    values: [
      { v: 'true', label: '있음' },
      { v: 'false', label: '없음' },
    ],
  },
  {
    key: 'size_label',
    label: '사이즈 명시',
    values: [
      { v: 'true', label: '있음' },
      { v: 'false', label: '없음' },
    ],
  },
] as const

interface VisionRow {
  goods_no: string | null
  product_id: string | null
  category_top: string | null
  attrs: any
  classified_at: string
}

async function fetchVisionRows(category: Category) {
  const sb = createAdminClient()
  const since = new Date(Date.now() - 90 * 86400_000).toISOString()
  // supabase types 에 새 테이블 미포함 → as any 로 untyped 쿼리
  const q = (sb as any)
    .from('jimscanner_trends_vision_attrs')
    .select('goods_no, product_id, category_top, attrs, classified_at')
    .gte('classified_at', since)
    .order('classified_at', { ascending: false })
    .limit(5000)
  if (category !== 'all') q.eq('category_top', category)
  const { data, error } = await q
  if (error) {
    console.warn('[visual-trends] fetch error', error.message)
    return [] as VisionRow[]
  }
  return (data ?? []) as VisionRow[]
}

async function fetchPinnedAttrs(category: Category) {
  // 핀 + 고득점(final_score >= 50) product 의 시각속성만 별도 추출 → 도넛용 modal
  const sb = createAdminClient()
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .gte('final_score', 50)
    .order('computed_at', { ascending: false })
    .limit(500)
  const seen = new Set<string>()
  const ids: string[] = []
  for (const r of (scores ?? []) as any[]) {
    if (seen.has(r.product_id)) continue
    seen.add(r.product_id)
    ids.push(r.product_id)
  }
  if (ids.length === 0) return [] as VisionRow[]

  const q = (sb as any)
    .from('jimscanner_trends_vision_attrs')
    .select('goods_no, product_id, category_top, attrs, classified_at')
    .in('product_id', ids)
    .limit(2000)
  if (category !== 'all') q.eq('category_top', category)
  const { data } = await q
  return (data ?? []) as VisionRow[]
}

type Bucket = '14d' | '30d' | '90d'

function bucketOf(iso: string, now = Date.now()): Bucket | null {
  const t = new Date(iso).getTime()
  const days = (now - t) / 86400_000
  if (days <= 14) return '14d'
  if (days <= 30) return '30d'
  if (days <= 90) return '90d'
  return null
}

// 빈도 매트릭스: axis x value → { 14d, 30d, 90d } 카운트
function buildMatrix(rows: VisionRow[]) {
  const now = Date.now()
  const m: Record<string, Record<string, { '14d': number; '30d': number; '90d': number }>> = {}
  for (const ax of AXES) {
    m[ax.key] = {}
    for (const v of ax.values) m[ax.key][v.v] = { '14d': 0, '30d': 0, '90d': 0 }
  }
  for (const r of rows) {
    const b = bucketOf(r.classified_at, now)
    if (!b) continue
    for (const ax of AXES) {
      const raw = r.attrs?.[ax.key]
      const v = raw == null ? null : String(raw)
      if (v && m[ax.key][v] !== undefined) {
        // 14d 는 30d/90d 에도 누적, 30d 는 90d 에 누적 (누적 윈도우)
        if (b === '14d') {
          m[ax.key][v]['14d']++
          m[ax.key][v]['30d']++
          m[ax.key][v]['90d']++
        } else if (b === '30d') {
          m[ax.key][v]['30d']++
          m[ax.key][v]['90d']++
        } else {
          m[ax.key][v]['90d']++
        }
      }
    }
  }
  return m
}

// z-score 기반 급등 속성 Top5 — 최근 14일 비율이 30~90일 baseline 대비 얼마나 튄 값인지
function buildRisingTop(matrix: ReturnType<typeof buildMatrix>) {
  type Item = { axis: string; axisLabel: string; value: string; valueLabel: string; z: number; recentShare: number; baseShare: number }
  const out: Item[] = []
  for (const ax of AXES) {
    const totals14 = Object.values(matrix[ax.key]).reduce((a, b) => a + b['14d'], 0)
    const totals90 = Object.values(matrix[ax.key]).reduce((a, b) => a + b['90d'], 0)
    if (totals14 < 3 || totals90 < 10) continue // 표본 부족
    for (const v of ax.values) {
      const c14 = matrix[ax.key][v.v]['14d']
      const c90 = matrix[ax.key][v.v]['90d']
      const p14 = c14 / totals14
      const p90 = c90 / Math.max(1, totals90)
      // baseline 표준오차 근사 (Bernoulli)
      const se = Math.sqrt(Math.max(1e-6, p90 * (1 - p90)) / Math.max(1, totals14))
      const z = (p14 - p90) / Math.max(1e-6, se)
      if (!Number.isFinite(z)) continue
      out.push({
        axis: ax.key,
        axisLabel: ax.label,
        value: v.v,
        valueLabel: v.label,
        z,
        recentShare: p14,
        baseShare: p90,
      })
    }
  }
  return out.sort((a, b) => b.z - a.z).slice(0, 5)
}

// pinned/고득점 modal 속성 도넛: 각 axis 의 최빈값 + 점유율
function buildPinnedModal(rows: VisionRow[]) {
  const counts: Record<string, Record<string, number>> = {}
  for (const ax of AXES) counts[ax.key] = {}
  for (const r of rows) {
    for (const ax of AXES) {
      const raw = r.attrs?.[ax.key]
      const v = raw == null ? null : String(raw)
      if (!v) continue
      counts[ax.key][v] = (counts[ax.key][v] ?? 0) + 1
    }
  }
  return AXES.map((ax) => {
    const entries = Object.entries(counts[ax.key]).sort((a, b) => b[1] - a[1])
    const total = entries.reduce((s, [, n]) => s + n, 0)
    const top = entries[0]
    return {
      axis: ax.key,
      label: ax.label,
      modal: top
        ? { value: top[0], label: ax.values.find((x) => x.v === top[0])?.label ?? top[0], share: total > 0 ? top[1] / total : 0, count: top[1] }
        : null,
      total,
      breakdown: entries.slice(0, 4).map(([v, n]) => ({
        v,
        label: ax.values.find((x) => x.v === v)?.label ?? v,
        share: total > 0 ? n / total : 0,
        n,
      })),
    }
  })
}

export default async function VisualTrendsPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string }>
}) {
  const sp = await searchParams
  const category = (CATEGORIES.includes(sp.cat as Category) ? sp.cat : 'all') as Category

  const [rows, pinnedRows] = await Promise.all([
    fetchVisionRows(category),
    fetchPinnedAttrs(category),
  ])

  const matrix = buildMatrix(rows)
  const rising = buildRisingTop(matrix)
  const pinnedModal = buildPinnedModal(pinnedRows)

  const totalRows = rows.length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">🎨 비주얼 트렌드 매트릭스</h1>
          <p className="text-sm text-gray-500 mt-1">
            Vision LLM 6속성 라벨링 · 카테고리×속성 빈도 14/30/90일 누적 + 급등 z-score
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <nav className="flex gap-2 border-b border-gray-200">
        {CATEGORIES.map((c) => (
          <Link
            key={c}
            href={`/admin/trend-radar/visual-trends?cat=${c}`}
            className={`px-3 py-2 text-sm ${
              category === c
                ? 'border-b-2 border-black font-semibold text-black'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {CATEGORY_LABEL[c]}
          </Link>
        ))}
      </nav>

      {totalRows === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 vision 분류 데이터 없음</p>
          <p className="text-sm mt-2">
            로컬 cron 으로 일 50건 배치 실행:
            <br />
            <code className="inline-block mt-2 px-2 py-1 bg-gray-100 rounded text-xs">
              node --env-file=.env.local scripts/extract-vision-attrs.mjs
            </code>
          </p>
        </div>
      ) : (
        <>
          {/* 급등 Top5 */}
          <section className="rounded border border-amber-300 bg-amber-50/40 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">
              📈 최근 급등 속성 Top5{' '}
              <span className="text-xs font-normal text-gray-500 ml-2">
                (14일 비중 vs 90일 baseline · z-score 기준)
              </span>
            </h2>
            {rising.length === 0 ? (
              <div className="text-xs text-gray-500">표본 부족 — 14일 ≥3건 / 90일 ≥10건 필요</div>
            ) : (
              <ol className="space-y-1">
                {rising.map((r, i) => (
                  <li
                    key={`${r.axis}::${r.value}`}
                    className="grid grid-cols-12 items-center text-sm px-2 py-1"
                  >
                    <div className="col-span-1 font-mono text-gray-400">{i + 1}</div>
                    <div className="col-span-3 text-xs text-gray-500">{r.axisLabel}</div>
                    <div className="col-span-3 font-medium">{r.valueLabel}</div>
                    <div className="col-span-2 text-right font-mono">
                      {Math.round(r.recentShare * 100)}%
                      <span className="text-xs text-gray-400 ml-1">
                        ({Math.round(r.baseShare * 100)}%)
                      </span>
                    </div>
                    <div className="col-span-3 text-right font-mono font-bold text-amber-700">
                      z={r.z.toFixed(2)}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* 핀/고득점 modal 도넛 (간이 텍스트 도넛) */}
          {pinnedRows.length > 0 && (
            <section className="rounded border border-gray-200 p-4">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">
                🎯 핀/고득점군 속성 분포{' '}
                <span className="text-xs font-normal text-gray-500 ml-2">
                  (final_score ≥ 50 product 의 시각속성 modal)
                </span>
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {pinnedModal.map((m) => (
                  <div key={m.axis} className="rounded border border-gray-100 p-3 bg-gray-50/50">
                    <div className="text-xs text-gray-500">{m.label}</div>
                    {m.modal ? (
                      <>
                        <div className="text-xl font-bold mt-1">
                          {m.modal.label}
                          <span className="text-xs text-gray-400 ml-2 font-mono">
                            {Math.round(m.modal.share * 100)}%
                          </span>
                        </div>
                        <div className="text-[10px] text-gray-400 mt-1">
                          {m.modal.count} / {m.total}건
                        </div>
                        <div className="mt-2 flex gap-1">
                          {m.breakdown.map((b) => (
                            <div
                              key={b.v}
                              className="h-2 rounded bg-amber-500"
                              style={{ width: `${Math.max(2, b.share * 100)}%`, opacity: 0.85 }}
                              title={`${b.label} ${Math.round(b.share * 100)}% (${b.n})`}
                            />
                          ))}
                        </div>
                      </>
                    ) : (
                      <div className="text-xs text-gray-400 mt-1">데이터 없음</div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 매트릭스 히트맵 */}
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-3">
              속성 빈도 매트릭스{' '}
              <span className="text-xs font-normal text-gray-500 ml-2">
                ({totalRows.toLocaleString()}건 분류 · 누적 윈도우)
              </span>
            </h2>
            <div className="space-y-4">
              {AXES.map((ax) => {
                const totals = {
                  '14d': Object.values(matrix[ax.key]).reduce((a, b) => a + b['14d'], 0),
                  '30d': Object.values(matrix[ax.key]).reduce((a, b) => a + b['30d'], 0),
                  '90d': Object.values(matrix[ax.key]).reduce((a, b) => a + b['90d'], 0),
                }
                return (
                  <div key={ax.key} className="rounded border border-gray-200">
                    <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-700">
                      {ax.label}{' '}
                      <span className="font-normal text-gray-400 ml-2">
                        ({ax.values.length} 값)
                      </span>
                    </div>
                    <table className="w-full text-xs">
                      <thead className="text-gray-500">
                        <tr>
                          <th className="px-3 py-2 text-left w-1/3">값</th>
                          <th className="px-3 py-2 text-right">14일</th>
                          <th className="px-3 py-2 text-right">30일</th>
                          <th className="px-3 py-2 text-right">90일</th>
                          <th className="px-3 py-2 text-left pl-4">14일 점유율</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {ax.values.map((v) => {
                          const c = matrix[ax.key][v.v]
                          const share = totals['14d'] > 0 ? c['14d'] / totals['14d'] : 0
                          // 히트맵 색상 — 점유율에 비례
                          const bg = `rgba(217, 119, 6, ${0.08 + share * 0.65})`
                          return (
                            <tr key={v.v}>
                              <td className="px-3 py-1.5 font-medium">{v.label}</td>
                              <td className="px-3 py-1.5 text-right font-mono">{c['14d']}</td>
                              <td className="px-3 py-1.5 text-right font-mono text-gray-600">{c['30d']}</td>
                              <td className="px-3 py-1.5 text-right font-mono text-gray-400">{c['90d']}</td>
                              <td className="px-3 py-1.5 pl-4">
                                <div className="flex items-center gap-2">
                                  <div
                                    className="h-3 rounded"
                                    style={{
                                      width: `${Math.max(2, share * 200)}px`,
                                      background: bg,
                                    }}
                                  />
                                  <span className="font-mono text-gray-500">
                                    {Math.round(share * 100)}%
                                  </span>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              })}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
