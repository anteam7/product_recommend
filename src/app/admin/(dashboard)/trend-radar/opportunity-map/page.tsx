import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface MatrixRow {
  cate_cd: string
  cate_label: string | null
  channel: string
  demand_index: number
  keyword_count: number
  supply_count: number
  price_stddev: number
  supply_depth: number
  ratio: number
}

interface DetailRow {
  kind: 'keyword' | 'product'
  ident: string
  label: string
  metric: number
  occurrences: number
  source: string | null
  detail_url: string | null
  image_url: string | null
  is_imminent: boolean
}

const CHANNELS: { id: string; label: string; emoji: string }[] = [
  { id: 'tv', label: 'TV편성', emoji: '📺' },
  { id: 'naver_search', label: '네이버검색', emoji: '🔎' },
  { id: 'naver_shopping', label: '네이버쇼핑hot', emoji: '🛒' },
  { id: 'community', label: '커뮤니티', emoji: '💬' },
]

const DAYS_OPTIONS = [7, 14, 30, 60] as const
const SIM_OPTIONS = [0.15, 0.2, 0.3] as const

async function fetchMatrix(days: number, sim: number): Promise<MatrixRow[]> {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_category_demand_supply' as never, {
    days_window: days,
    min_sim: sim,
  } as never)
  if (error) {
    console.error('matrix rpc error', error)
    return []
  }
  return (data ?? []) as MatrixRow[]
}

async function fetchDetail(
  cate: string,
  channel: string,
  days: number,
  sim: number,
): Promise<DetailRow[]> {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_category_demand_supply_detail' as never, {
    p_cate_cd: cate,
    p_channel: channel,
    days_window: days,
    min_sim: sim,
    result_limit: 10,
  } as never)
  if (error) {
    console.error('detail rpc error', error)
    return []
  }
  return (data ?? []) as DetailRow[]
}

function buildHref(
  current: Record<string, string>,
  override: Record<string, string | null>,
): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/opportunity-map' + (qs ? `?${qs}` : '')
}

function cellColor(ratio: number, maxRatio: number, supplyCount: number): string {
  if (supplyCount === 0) return 'bg-gray-100 text-gray-400'
  if (ratio === 0) return 'bg-gray-50 text-gray-400'
  const norm = maxRatio > 0 ? ratio / maxRatio : 0
  // 빨강 강도. norm 0~1.
  if (norm >= 0.66) return 'bg-red-500 text-white'
  if (norm >= 0.4) return 'bg-red-400 text-white'
  if (norm >= 0.2) return 'bg-red-300 text-red-950'
  if (norm >= 0.08) return 'bg-amber-200 text-amber-900'
  if (norm >= 0.02) return 'bg-amber-100 text-amber-800'
  // 공급은 있는데 수요 약함
  if (supplyCount >= 50) return 'bg-blue-100 text-blue-800'
  return 'bg-gray-100 text-gray-600'
}

export default async function OpportunityMapPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; sim?: string; cate?: string; ch?: string }>
}) {
  const sp = await searchParams
  const daysIn = parseInt(sp.days ?? '30', 10)
  const validDays = (DAYS_OPTIONS as readonly number[]).includes(daysIn) ? daysIn : 30
  const simIn = parseFloat(sp.sim ?? '0.2')
  const validSim = (SIM_OPTIONS as readonly number[]).some((s) => Math.abs(s - simIn) < 0.001)
    ? simIn
    : 0.2
  const selectedCate = sp.cate ?? null
  const selectedChannel = sp.ch ?? null

  const current: Record<string, string> = {
    days: String(validDays),
    sim: String(validSim),
    cate: selectedCate ?? '',
    ch: selectedChannel ?? '',
  }

  const matrix = await fetchMatrix(validDays, validSim)

  // Pivot — cate_cd 기준으로 그룹
  const byCate = new Map<string, { label: string; rows: Map<string, MatrixRow> }>()
  for (const r of matrix) {
    let g = byCate.get(r.cate_cd)
    if (!g) {
      g = { label: r.cate_label ?? r.cate_cd, rows: new Map() }
      byCate.set(r.cate_cd, g)
    }
    if (r.cate_label && !g.label) g.label = r.cate_label
    g.rows.set(r.channel, r)
  }

  const sortedCates = [...byCate.entries()].sort(([a], [b]) => a.localeCompare(b))
  const maxRatio = matrix.reduce((m, r) => (r.ratio > m ? r.ratio : m), 0)

  let detailRows: DetailRow[] = []
  let detailCateLabel = ''
  let detailChannelLabel = ''
  if (selectedCate && selectedChannel) {
    detailRows = await fetchDetail(selectedCate, selectedChannel, validDays, validSim)
    const cateInfo = byCate.get(selectedCate)
    detailCateLabel = cateInfo?.label ?? selectedCate
    detailChannelLabel = CHANNELS.find((c) => c.id === selectedChannel)?.label ?? selectedChannel
  }
  const detailKeywords = detailRows.filter((r) => r.kind === 'keyword')
  const detailProducts = detailRows.filter((r) => r.kind === 'product')

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Opportunity Map</h1>
          <p className="text-sm text-gray-500 mt-1">
            카테고리 × 채널 수요/공급 갭 히트맵 · 빨강 = 수요 강한데 공급 얕음(진입 기회) · 회색 = 둘 다 낮음 · 파랑 = 공급 과잉
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-4 rounded border border-gray-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">기간</span>
          {DAYS_OPTIONS.map((d) => (
            <Link
              key={d}
              href={buildHref(current, { days: String(d), cate: null, ch: null })}
              className={`px-2 py-1 text-xs rounded ${
                validDays === d
                  ? 'bg-amber-100 text-amber-700 font-semibold'
                  : 'text-gray-500 hover:text-black'
              }`}
            >
              {d}일
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">유사도 ≥</span>
          {SIM_OPTIONS.map((s) => (
            <Link
              key={s}
              href={buildHref(current, { sim: String(s), cate: null, ch: null })}
              className={`px-2 py-1 text-xs rounded ${
                Math.abs(validSim - s) < 0.001
                  ? 'bg-amber-100 text-amber-700 font-semibold'
                  : 'text-gray-500 hover:text-black'
              }`}
            >
              {s.toFixed(2)}
            </Link>
          ))}
        </div>
        <div className="text-xs text-gray-500 ml-auto">
          매트릭스 row {matrix.length} · max ratio {maxRatio.toFixed(2)}
        </div>
      </div>

      {/* 히트맵 */}
      {sortedCates.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div>아직 데이터 없음</div>
          <div className="text-xs text-gray-400">
            ggsan 카탈로그 수집 + 키워드 누적 30일 후 의미 있는 신호가 잡힙니다.
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-gray-200">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-3 py-2 text-xs font-semibold text-gray-600 sticky left-0 bg-gray-50">
                  카테고리
                </th>
                <th className="text-right px-2 py-2 text-xs font-semibold text-gray-600">공급</th>
                {CHANNELS.map((ch) => (
                  <th key={ch.id} className="text-center px-2 py-2 text-xs font-semibold text-gray-600">
                    {ch.emoji} {ch.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedCates.map(([cateCd, info]) => {
                const supplyRow = [...info.rows.values()][0]
                const supplyCount = supplyRow?.supply_count ?? 0
                const priceStddev = supplyRow?.price_stddev ?? 0
                return (
                  <tr key={cateCd} className="border-b border-gray-100 hover:bg-gray-50/50">
                    <td className="px-3 py-2 sticky left-0 bg-white">
                      <div className="font-medium text-sm">{info.label}</div>
                      <div className="text-xs text-gray-400 font-mono">{cateCd}</div>
                    </td>
                    <td className="px-2 py-2 text-right text-xs font-mono">
                      <div>{supplyCount}</div>
                      <div className="text-gray-400">σ{Math.round(priceStddev).toLocaleString()}</div>
                    </td>
                    {CHANNELS.map((ch) => {
                      const cell = info.rows.get(ch.id)
                      const ratio = cell?.ratio ?? 0
                      const demand = cell?.demand_index ?? 0
                      const kwCount = cell?.keyword_count ?? 0
                      const colorCls = cellColor(ratio, maxRatio, supplyCount)
                      const isSelected = selectedCate === cateCd && selectedChannel === ch.id
                      return (
                        <td key={ch.id} className="p-1">
                          <Link
                            href={buildHref(current, {
                              cate: isSelected ? null : cateCd,
                              ch: isSelected ? null : ch.id,
                            })}
                            className={`block rounded text-center px-2 py-2 transition-all ${colorCls} ${
                              isSelected ? 'ring-2 ring-black ring-offset-1' : 'hover:opacity-80'
                            }`}
                            title={`demand=${demand.toFixed(2)} · supply=${supplyCount} · ratio=${ratio.toFixed(2)} · ${kwCount} keywords`}
                          >
                            <div className="font-bold font-mono text-sm leading-tight">
                              {ratio > 0 ? ratio.toFixed(2) : '·'}
                            </div>
                            <div className="text-[10px] opacity-80 leading-tight">
                              d{demand >= 10 ? Math.round(demand) : demand.toFixed(1)} · kw{kwCount}
                            </div>
                          </Link>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 드릴다운 */}
      {selectedCate && selectedChannel && (
        <section className="rounded border border-gray-300 bg-gray-50/50 p-4 space-y-4">
          <div className="flex items-baseline justify-between flex-wrap gap-2">
            <h2 className="text-base font-semibold">
              🔍 {detailCateLabel} × {detailChannelLabel}
              <span className="ml-2 text-xs font-normal text-gray-500">
                cate_cd {selectedCate} · channel {selectedChannel}
              </span>
            </h2>
            <Link
              href={buildHref(current, { cate: null, ch: null })}
              className="text-xs text-gray-500 hover:text-black underline"
            >
              닫기 ✕
            </Link>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* 키워드 Top10 */}
            <div className="rounded border border-gray-200 bg-white overflow-hidden">
              <div className="px-3 py-2 bg-amber-50 border-b border-gray-200 text-xs font-semibold text-amber-900">
                📈 토픽 키워드 Top10 (수요 신호)
              </div>
              {detailKeywords.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-gray-400">
                  매칭 키워드 없음 (유사도 ≥{validSim.toFixed(2)} 기준)
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {detailKeywords.map((k, i) => (
                    <div key={k.ident} className="flex items-baseline gap-2 px-3 py-2 text-sm">
                      <span className="font-mono text-xs text-gray-400 w-5">{i + 1}</span>
                      <span className="flex-1 truncate" title={k.label}>
                        {k.label}
                      </span>
                      <span className="text-xs text-gray-500 font-mono">{k.occurrences}회</span>
                      <span className="text-xs font-mono font-bold text-amber-700 w-12 text-right">
                        {Number(k.metric).toFixed(1)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ggsan 상품 Top10 */}
            <div className="rounded border border-gray-200 bg-white overflow-hidden">
              <div className="px-3 py-2 bg-emerald-50 border-b border-gray-200 text-xs font-semibold text-emerald-900">
                📦 ggsan 등록상품 Top10 (공급)
              </div>
              {detailProducts.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-gray-400">
                  해당 카테고리에 ggsan 매물 없음
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {detailProducts.map((p, i) => (
                    <a
                      key={p.ident}
                      href={p.detail_url ?? '#'}
                      target="_blank"
                      rel="noopener"
                      className="flex items-start gap-2 px-3 py-2 hover:bg-amber-50 transition-colors"
                    >
                      <span className="font-mono text-xs text-gray-400 w-5 pt-0.5">{i + 1}</span>
                      <div className="w-10 h-10 bg-gray-100 rounded overflow-hidden flex-shrink-0">
                        {p.image_url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={p.image_url}
                            alt=""
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs leading-snug line-clamp-2" title={p.label}>
                          {p.label}
                        </div>
                        <div className="text-[10px] text-gray-400 mt-0.5">{p.ident}</div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="text-xs font-mono font-bold">
                          {p.metric > 0
                            ? `${Math.round(Number(p.metric)).toLocaleString()}원`
                            : '—'}
                        </div>
                        {p.is_imminent && (
                          <div className="text-[9px] bg-red-600 text-white px-1 rounded mt-0.5">
                            임박
                          </div>
                        )}
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="text-xs text-gray-500">
            💡 키워드는 강한데 ggsan 매물이 적거나 가격대가 단일하면 → 진입 기회. 반대로 매물이 많은데 키워드가 약하면 → 공급 과잉(레드오션).
          </div>
        </section>
      )}

      {/* 범례 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-semibold text-gray-700">범례:</span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-4 h-4 bg-red-500 rounded" /> 진입 기회 (수요 ≫ 공급)
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-4 h-4 bg-amber-200 rounded" /> 중간
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-4 h-4 bg-blue-100 rounded" /> 공급 과잉
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-4 h-4 bg-gray-100 rounded" /> 둘 다 약함
          </span>
        </div>
        <div>
          <strong>ratio</strong> = demand_index ÷ (supply_count + price_stddev/10000) · 셀 클릭 → 키워드/상품 Top10 펼침
        </div>
      </section>
    </div>
  )
}
