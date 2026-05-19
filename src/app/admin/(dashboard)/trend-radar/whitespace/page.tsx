import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface CellRow {
  cate_cd: string
  cate_label: string | null
  category_top: string
  supply_count: number
  demand_score: number | string
  pin_count: number
  median_price: number | null
  opportunity_score: number | string
}

interface CellSku {
  goods_no: string
  title: string
  cate_label: string | null
  price_krw: number | null
  is_imminent: boolean
  image_url: string | null
  detail_url: string | null
  matched_category_top: string
  pinned: boolean
}

const CATEGORY_TOPS_ORDER = ['health', 'living', 'digital', 'community', 'shopping_tv', 'unmatched']

async function fetchMatrix() {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_whitespace_map' as never, {
    min_sim: 0.2,
  } as never)
  if (error) return { cells: [] as CellRow[], error: error.message }
  return { cells: (data ?? []) as CellRow[], error: null as string | null }
}

async function fetchCellSkus(cateCd: string, categoryTop: string) {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_whitespace_cell_skus' as never, {
    in_cate_cd: cateCd,
    in_category_top: categoryTop,
    min_sim: 0.2,
    result_limit: 30,
  } as never)
  if (error) return { skus: [] as CellSku[], error: error.message }
  return { skus: (data ?? []) as CellSku[], error: null as string | null }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/whitespace' + (qs ? `?${qs}` : '')
}

function cellTone(c: CellRow): string {
  const supply = c.supply_count
  const demand = Number(c.demand_score)
  const pins = c.pin_count
  // 화이트스페이스 강조: 공급 ≥ 5, 수요 ≥ 40, 핀 = 0
  if (supply >= 5 && demand >= 40 && pins === 0) {
    return 'border-red-500 ring-1 ring-red-300 bg-red-50'
  }
  if (supply >= 3 && demand >= 30 && pins === 0) {
    return 'border-orange-300 bg-orange-50'
  }
  if (pins > 0 && supply > 0) {
    return 'border-gray-200 bg-emerald-50/40'
  }
  if (supply === 0) {
    return 'border-gray-100 bg-gray-50/50 text-gray-300'
  }
  return 'border-gray-200'
}

export default async function WhitespacePage({
  searchParams,
}: {
  searchParams: Promise<{ cell?: string }>
}) {
  const sp = await searchParams
  const cellParam = sp.cell ?? ''
  const [selectedCate, selectedTop] = cellParam.includes(':')
    ? cellParam.split(':')
    : ['', '']

  const { cells, error } = await fetchMatrix()

  // 행 = cate_cd, 열 = category_top
  const cateMap = new Map<string, { label: string | null }>()
  const topSet = new Set<string>()
  for (const c of cells) {
    if (!cateMap.has(c.cate_cd)) cateMap.set(c.cate_cd, { label: c.cate_label })
    topSet.add(c.category_top)
  }
  const cateRows = Array.from(cateMap.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  const topCols = CATEGORY_TOPS_ORDER.filter((t) => topSet.has(t)).concat(
    Array.from(topSet).filter((t) => !CATEGORY_TOPS_ORDER.includes(t))
  )

  const byKey = new Map<string, CellRow>()
  for (const c of cells) byKey.set(`${c.cate_cd}::${c.category_top}`, c)

  // 상위 화이트스페이스 (KPI)
  const ranked = [...cells].sort(
    (a, b) => Number(b.opportunity_score) - Number(a.opportunity_score)
  )
  const topWhitespace = ranked.filter(
    (c) => c.pin_count === 0 && c.supply_count >= 3 && Number(c.demand_score) >= 30
  )

  let drilldown: { skus: CellSku[]; error: string | null } = { skus: [], error: null }
  if (selectedCate && selectedTop) {
    drilldown = await fetchCellSkus(selectedCate, selectedTop)
  }
  const selectedCell = selectedCate && selectedTop ? byKey.get(`${selectedCate}::${selectedTop}`) : null

  const current: Record<string, string> = { cell: cellParam }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🗺 Whitespace Map</h1>
          <p className="text-sm text-gray-500 mt-1">
            ggsan cate_cd × canonical category_top — 빨간 셀 = 공급↑ × 수요↑ × 우리 핀 0 (진입 화이트스페이스)
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_whitespace_map</code> 미적용. supabase/whitespace_map_rpc.sql 적용 필요.
          </p>
        </div>
      )}

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="전체 셀" value={cells.length} />
        <Kpi label="화이트스페이스 셀" value={topWhitespace.length} highlight={topWhitespace.length > 0} />
        <Kpi label="공급 합계 (SKU)" value={cells.reduce((s, c) => s + c.supply_count, 0)} />
        <Kpi label="우리 핀 합계 (cell-mapped)" value={cells.reduce((s, c) => s + c.pin_count, 0)} />
      </section>

      <div className={`grid gap-6 ${selectedCell ? 'lg:grid-cols-[1fr_360px]' : ''}`}>
        {/* 매트릭스 */}
        <section className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th className="sticky left-0 bg-white border border-gray-200 px-2 py-2 text-left z-10">
                  cate_cd / top
                </th>
                {topCols.map((t) => (
                  <th key={t} className="border border-gray-200 px-2 py-2 font-semibold text-gray-700">
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cateRows.map(([cateCd, meta]) => (
                <tr key={cateCd}>
                  <th className="sticky left-0 bg-white border border-gray-200 px-2 py-2 text-left text-gray-700 font-medium z-10">
                    <div>{meta.label ?? cateCd}</div>
                    <div className="text-[10px] text-gray-400 font-mono">{cateCd}</div>
                  </th>
                  {topCols.map((t) => {
                    const c = byKey.get(`${cateCd}::${t}`)
                    if (!c) {
                      return (
                        <td key={t} className="border border-gray-100 bg-gray-50/30 px-2 py-2 text-gray-300 text-center">
                          —
                        </td>
                      )
                    }
                    const isSelected = c.cate_cd === selectedCate && c.category_top === selectedTop
                    const tone = cellTone(c)
                    return (
                      <td
                        key={t}
                        className={`border ${tone} ${isSelected ? 'ring-2 ring-black' : ''} p-0`}
                      >
                        <Link
                          href={buildHref(current, { cell: `${c.cate_cd}:${c.category_top}` })}
                          className="block px-2 py-2 text-[11px] leading-tight space-y-0.5"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-mono font-bold text-gray-800">SKU {c.supply_count}</span>
                            {c.pin_count === 0 && c.supply_count > 0 ? (
                              <span className="text-red-600 font-bold">★0</span>
                            ) : (
                              <span className="text-emerald-700">📌{c.pin_count}</span>
                            )}
                          </div>
                          <div className="text-gray-600">
                            demand {Number(c.demand_score).toFixed(1)}
                          </div>
                          <div className="text-gray-500">
                            {c.median_price ? `~${(c.median_price / 1000).toFixed(1)}k` : '—'}
                          </div>
                          <div className="text-amber-700 font-mono">
                            opp {Number(c.opportunity_score).toFixed(3)}
                          </div>
                        </Link>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* 우측 드릴다운 */}
        {selectedCell && (
          <aside className="border border-gray-200 rounded p-3 space-y-3 h-fit sticky top-4">
            <div>
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-semibold">
                  {selectedCell.cate_label ?? selectedCell.cate_cd} × {selectedCell.category_top}
                </h2>
                <Link
                  href={buildHref(current, { cell: null })}
                  className="text-xs text-gray-500 hover:text-black"
                >
                  ✕ 닫기
                </Link>
              </div>
              <p className="text-[11px] text-gray-500 mt-1">
                공급 {selectedCell.supply_count} · 수요 {Number(selectedCell.demand_score).toFixed(1)} ·
                핀 {selectedCell.pin_count} · opp {Number(selectedCell.opportunity_score).toFixed(3)}
              </p>
            </div>
            {drilldown.error && (
              <div className="text-xs text-red-700 bg-red-50 px-2 py-1 rounded">
                {drilldown.error}
              </div>
            )}
            {drilldown.skus.length === 0 ? (
              <div className="text-xs text-gray-400 italic">셀 내 SKU 없음</div>
            ) : (
              <div className="space-y-2 max-h-[70vh] overflow-y-auto">
                {drilldown.skus.map((s) => (
                  <a
                    key={s.goods_no}
                    href={s.detail_url ?? '#'}
                    target="_blank"
                    rel="noopener"
                    className={`block rounded border ${
                      s.pinned ? 'border-emerald-200 bg-emerald-50/40' : 'border-gray-200 hover:bg-gray-50'
                    } p-2`}
                  >
                    <div className="flex gap-2">
                      <div className="w-12 h-12 bg-gray-100 rounded overflow-hidden flex-shrink-0">
                        {s.image_url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={s.image_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0 space-y-0.5">
                        <div className="text-xs leading-tight line-clamp-2" title={s.title}>
                          {s.title}
                        </div>
                        <div className="text-[10px] text-gray-500 flex gap-2">
                          {s.price_krw && <span>{s.price_krw.toLocaleString()}원</span>}
                          {s.is_imminent && <span className="text-red-600">🔥임박</span>}
                          {s.pinned ? (
                            <span className="text-emerald-700">📌 pinned</span>
                          ) : (
                            <span className="text-amber-700">신규후보</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </aside>
        )}
      </div>

      {/* 화이트스페이스 톱 */}
      {topWhitespace.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-2">🚩 진입 가능성 톱 (pin=0 × 공급≥3 × 수요≥30)</h2>
          <div className="rounded border border-gray-200 divide-y divide-gray-100">
            {topWhitespace.slice(0, 15).map((c) => (
              <Link
                key={`${c.cate_cd}::${c.category_top}`}
                href={buildHref(current, { cell: `${c.cate_cd}:${c.category_top}` })}
                className="grid grid-cols-12 px-3 py-2 text-xs items-center hover:bg-gray-50"
              >
                <div className="col-span-4">
                  <span className="font-medium text-gray-800">{c.cate_label ?? c.cate_cd}</span>
                  <span className="text-gray-400 ml-2 font-mono">{c.cate_cd}</span>
                </div>
                <div className="col-span-2 text-gray-600">{c.category_top}</div>
                <div className="col-span-2 text-right font-mono">SKU {c.supply_count}</div>
                <div className="col-span-2 text-right font-mono text-gray-600">
                  demand {Number(c.demand_score).toFixed(1)}
                </div>
                <div className="col-span-2 text-right font-mono font-bold text-amber-700">
                  opp {Number(c.opportunity_score).toFixed(3)}
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 opportunity_score 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          opp = min(supply/50, 1) × (demand_avg/100) × (1 - min(pin_count/supply, 1))
        </code>
        <div className="pt-2">
          핀 매칭은 ggsan title × pins.keyword trigram (similarity ≥ 0.2). canonical 매칭은 aliases trigram.
          매칭 안 된 ggsan 은 <code>unmatched</code> 컬럼으로 분류 — 별도 alias LLM 분류로 점차 흡수.
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-red-700' : ''}`}>
        {value.toLocaleString()}
      </div>
    </div>
  )
}
