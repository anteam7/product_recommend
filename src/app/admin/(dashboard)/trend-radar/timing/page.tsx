import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface HeatCell {
  dow: number
  hod: number
  count: number
  sources: string[] | null
  zscore: number
  is_peak: boolean
  top_source: string | null
}

const DOW_LABELS = ['일', '월', '화', '수', '목', '금', '토']

const CATEGORY_OPTIONS = [
  { v: '', label: '전체' },
  { v: 'health', label: '건강식품' },
  { v: 'living', label: '생활/리빙' },
  { v: 'digital', label: '디지털/가전' },
] as const

const DAYS_OPTIONS = [7, 14, 30, 60] as const

async function fetchCategoryHeatmap(category: string, days: number) {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc(
    'jimscanner_trends_demand_heatmap_category' as never,
    {
      p_category_top: category || null,
      days_window: days,
    } as never,
  )
  if (error) return { cells: [] as HeatCell[], error: error.message }
  return { cells: (data ?? []) as HeatCell[], error: null as string | null }
}

async function fetchKeywordHeatmap(keyword: string, days: number) {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc(
    'jimscanner_trends_demand_heatmap' as never,
    { p_keyword: keyword, days_window: days } as never,
  )
  if (error) return { cells: [] as HeatCell[], error: error.message }
  return { cells: (data ?? []) as HeatCell[], error: null as string | null }
}

async function fetchPinnedKeywords() {
  const sb = createAdminClient()
  const { data } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword')
    .eq('pinned', true)
    .order('collected_at', { ascending: false })
    .limit(200)
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of (data ?? []) as { keyword: string }[]) {
    if (!r.keyword || seen.has(r.keyword)) continue
    seen.add(r.keyword)
    out.push(r.keyword)
    if (out.length >= 30) break
  }
  return out
}

function colorFor(z: number, count: number): string {
  if (count === 0) return 'rgb(245,245,245)'
  // z 를 0~1 로 클립 (0 이하는 옅게, 2.5 이상은 진하게)
  const t = Math.max(0, Math.min(1, (z + 1) / 3.5))
  // teal → red gradient (low → high demand)
  const r = Math.round(30 + t * 200)
  const g = Math.round(120 - t * 90)
  const b = Math.round(170 - t * 130)
  return `rgb(${r},${g},${b})`
}

function HeatGrid({
  cells,
  caption,
  highlightNow,
}: {
  cells: HeatCell[]
  caption: string
  highlightNow?: { dow: number; hod: number } | null
}) {
  const map = new Map<string, HeatCell>()
  for (const c of cells) map.set(`${c.dow}:${c.hod}`, c)

  const cellSize = 24
  const labelW = 28
  const labelH = 18
  const width = labelW + cellSize * 24
  const height = labelH + cellSize * 7

  return (
    <div className="overflow-x-auto">
      <div className="text-xs text-gray-600 mb-2">{caption}</div>
      <svg width={width} height={height} className="block">
        {/* hour labels */}
        {Array.from({ length: 24 }).map((_, h) => (
          <text
            key={h}
            x={labelW + h * cellSize + cellSize / 2}
            y={labelH - 5}
            fontSize={9}
            fill="#666"
            textAnchor="middle"
          >
            {h % 3 === 0 ? h : ''}
          </text>
        ))}
        {/* dow rows */}
        {Array.from({ length: 7 }).map((_, d) => (
          <g key={d}>
            <text
              x={labelW - 6}
              y={labelH + d * cellSize + cellSize / 2 + 3}
              fontSize={10}
              fill="#666"
              textAnchor="end"
            >
              {DOW_LABELS[d]}
            </text>
            {Array.from({ length: 24 }).map((_, h) => {
              const c = map.get(`${d}:${h}`)
              const fill = colorFor(c?.zscore ?? 0, c?.count ?? 0)
              const isNow =
                highlightNow && highlightNow.dow === d && highlightNow.hod === h
              const isPeak = c?.is_peak && (c?.count ?? 0) > 0
              const title = c
                ? `${DOW_LABELS[d]}요일 ${String(h).padStart(2, '0')}:00 — ${c.count}건 (z=${c.zscore?.toFixed?.(2) ?? '0.00'})${c.top_source ? `\nTop: ${c.top_source}` : ''}${c.sources?.length ? `\n${c.sources.join(', ')}` : ''}`
                : `${DOW_LABELS[d]}요일 ${String(h).padStart(2, '0')}:00 — 0건`
              return (
                <g key={h}>
                  <rect
                    x={labelW + h * cellSize}
                    y={labelH + d * cellSize}
                    width={cellSize - 2}
                    height={cellSize - 2}
                    fill={fill}
                    stroke={isPeak ? '#dc2626' : isNow ? '#000' : 'transparent'}
                    strokeWidth={isPeak || isNow ? 1.5 : 0}
                  >
                    <title>{title}</title>
                  </rect>
                  {(c?.count ?? 0) >= 3 && (
                    <text
                      x={labelW + h * cellSize + (cellSize - 2) / 2}
                      y={labelH + d * cellSize + (cellSize - 2) / 2 + 3}
                      fontSize={8}
                      fill={c!.zscore > 0.5 ? '#fff' : '#222'}
                      textAnchor="middle"
                      pointerEvents="none"
                    >
                      {c!.count}
                    </text>
                  )}
                </g>
              )
            })}
          </g>
        ))}
      </svg>
    </div>
  )
}

function findPeak(cells: HeatCell[]): HeatCell | null {
  let best: HeatCell | null = null
  for (const c of cells) {
    if (c.count === 0) continue
    if (!best || c.count > best.count) best = c
  }
  return best
}

function todaySlot(): { dow: number; hod: number } {
  const now = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }),
  )
  return { dow: now.getDay(), hod: now.getHours() }
}

export default async function TimingPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string; kw?: string; days?: string; pin?: string }>
}) {
  const sp = await searchParams
  const cat = sp.cat ?? ''
  const days = (DAYS_OPTIONS as readonly number[]).includes(Number(sp.days))
    ? Number(sp.days)
    : 30
  const kw = (sp.kw ?? '').trim()
  const pinned = sp.pin ? sp.pin.split(',').filter(Boolean).slice(0, 4) : []

  const [{ cells: catCells, error: catErr }, pinList, ...pinResults] =
    await Promise.all([
      fetchCategoryHeatmap(cat, days),
      fetchPinnedKeywords(),
      ...(kw ? [fetchKeywordHeatmap(kw, days)] : []),
      ...pinned.map((p) => fetchKeywordHeatmap(p, days)),
    ])

  const kwResult = kw ? pinResults.shift() : null
  const pinResultsArr = pinResults

  const now = todaySlot()
  const peak = findPeak(catCells)
  const peakCell =
    kwResult && kwResult.cells.length ? findPeak(kwResult.cells) : null

  function slotLabel(c: HeatCell | null): string {
    if (!c) return '—'
    return `${DOW_LABELS[c.dow]}요일 ${String(c.hod).padStart(2, '0')}:00`
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">⏱ 마이크로 수요 히트맵</h1>
          <p className="text-sm text-gray-500 mt-1">
            24h × 7d KST · 광고/콘텐츠 출시 슬롯 추천 · 데이터: tvtime + 커뮤니티 4종 + market_raw 3종
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 컨트롤 */}
      <form method="GET" className="flex flex-wrap items-end gap-3 rounded border border-gray-200 p-3 bg-gray-50">
        <label className="text-sm">
          <div className="text-xs text-gray-500 mb-1">카테고리</div>
          <select name="cat" defaultValue={cat} className="border border-gray-300 rounded px-2 py-1 text-sm">
            {CATEGORY_OPTIONS.map((o) => (
              <option key={o.v} value={o.v}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <div className="text-xs text-gray-500 mb-1">기간 (일)</div>
          <select name="days" defaultValue={days} className="border border-gray-300 rounded px-2 py-1 text-sm">
            {DAYS_OPTIONS.map((d) => (
              <option key={d} value={d}>{d}일</option>
            ))}
          </select>
        </label>
        <label className="text-sm flex-1 min-w-[200px]">
          <div className="text-xs text-gray-500 mb-1">키워드 (단일)</div>
          <input
            type="text"
            name="kw"
            defaultValue={kw}
            placeholder="예: 멜라토닌"
            className="border border-gray-300 rounded px-2 py-1 text-sm w-full"
          />
        </label>
        <label className="text-sm flex-1 min-w-[240px]">
          <div className="text-xs text-gray-500 mb-1">핀 키워드 비교 (콤마, 최대 4)</div>
          <input
            type="text"
            name="pin"
            defaultValue={pinned.join(',')}
            placeholder="kw1,kw2,kw3"
            className="border border-gray-300 rounded px-2 py-1 text-sm w-full"
          />
        </label>
        <button type="submit" className="px-3 py-1.5 text-sm bg-black text-white rounded hover:bg-gray-800">
          적용
        </button>
      </form>

      {/* 추천 슬롯 액션 카드 */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <ActionCard
          label="현재 KST"
          slot={`${DOW_LABELS[now.dow]}요일 ${String(now.hod).padStart(2, '0')}:00`}
          hint="지금 푸시 시각"
        />
        <ActionCard
          label="카테고리 피크"
          slot={slotLabel(peak)}
          hint={peak ? `${peak.count}건 / z=${peak.zscore.toFixed(2)}` : '데이터 없음'}
          tone="amber"
        />
        <ActionCard
          label={kw ? `'${kw}' 피크` : '키워드 피크'}
          slot={slotLabel(peakCell)}
          hint={
            peakCell
              ? `${peakCell.count}건 / z=${peakCell.zscore.toFixed(2)} · 광고 슬롯 추천`
              : kw
                ? '데이터 없음 — 기간 늘려보기'
                : '키워드 입력 시 표시'
          }
          tone="red"
        />
      </section>

      {/* 카테고리 히트맵 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          카테고리 히트맵{' '}
          <span className="text-xs font-normal text-gray-500 ml-1">
            ({CATEGORY_OPTIONS.find((c) => c.v === cat)?.label ?? '전체'} · {days}일)
          </span>
        </h2>
        {catErr ? (
          <div className="text-xs text-red-600">RPC error: {catErr}</div>
        ) : (
          <div className="rounded border border-gray-200 p-3 bg-white">
            <HeatGrid
              cells={catCells}
              caption="KST 0~23시 × 일~토 · z-score 기반 색상 · 빨간 테두리 = 주간 최대 · 검정 테두리 = 현재 시각"
              highlightNow={now}
            />
            <Legend />
          </div>
        )}
      </section>

      {/* 단일 키워드 히트맵 */}
      {kw && kwResult && (
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">
            키워드 히트맵 — <span className="font-mono">{kw}</span>
          </h2>
          {kwResult.error ? (
            <div className="text-xs text-red-600">RPC error: {kwResult.error}</div>
          ) : (
            <div className="rounded border border-gray-200 p-3 bg-white">
              <HeatGrid
                cells={kwResult.cells}
                caption={`'${kw}' 의 ${days}일 누적 출현 분포`}
                highlightNow={now}
              />
            </div>
          )}
        </section>
      )}

      {/* 핀 키워드 비교 (겹쳐보기) */}
      {pinned.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">
            핀 키워드 비교 ({pinned.length})
          </h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {pinned.map((p, i) => {
              const r = pinResultsArr[i]
              if (!r) return null
              return (
                <div key={p} className="rounded border border-gray-200 p-3 bg-white">
                  <div className="flex items-baseline justify-between mb-1">
                    <div className="font-mono text-sm">{p}</div>
                    <div className="text-xs text-gray-500">
                      피크: {slotLabel(findPeak(r.cells))}
                    </div>
                  </div>
                  {r.error ? (
                    <div className="text-xs text-red-600">RPC error: {r.error}</div>
                  ) : (
                    <HeatGrid cells={r.cells} caption="" highlightNow={now} />
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* 핀 후보 (쉽게 비교에 추가) */}
      {pinList.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">핀된 키워드 추가</h2>
          <div className="flex flex-wrap gap-1.5">
            {pinList.map((p) => {
              const next = [...new Set([...pinned, p])].slice(0, 4)
              const href = `/admin/trend-radar/timing?cat=${encodeURIComponent(cat)}&days=${days}&kw=${encodeURIComponent(kw)}&pin=${encodeURIComponent(next.join(','))}`
              const isOn = pinned.includes(p)
              return (
                <Link
                  key={p}
                  href={href}
                  className={`text-xs px-2 py-1 rounded border ${isOn ? 'bg-black text-white border-black' : 'border-gray-300 hover:bg-gray-50'}`}
                >
                  {p}
                </Link>
              )
            })}
          </div>
        </section>
      )}

      <section className="rounded border border-dashed border-gray-300 p-3 text-xs text-gray-500">
        <strong className="text-gray-700">timing_window_match (가중치 0.05):</strong>{' '}
        trend_score 계산 시, 현재 KST 셀이 키워드 피크 셀과 일치하면 정규화된 z-score 보너스를
        추가한다 (구현 — recompute SQL 의 score_components.trend 에{' '}
        <code className="bg-gray-100 px-1 rounded">timing_window_match</code> 키 추가).
        이 페이지는 보너스 계산의 시각화 + 운영자 액션 큐 (광고 슬롯 잡기) 입구.
      </section>
    </div>
  )
}

function ActionCard({
  label,
  slot,
  hint,
  tone,
}: {
  label: string
  slot: string
  hint: string
  tone?: 'amber' | 'red'
}) {
  const bg = tone === 'red' ? 'bg-red-50 border-red-200' : tone === 'amber' ? 'bg-amber-50 border-amber-200' : 'bg-white border-gray-200'
  return (
    <div className={`rounded border ${bg} p-3`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-lg font-bold mt-1">{slot}</div>
      <div className="text-xs text-gray-500 mt-0.5">{hint}</div>
    </div>
  )
}

function Legend() {
  const stops = [-1, -0.5, 0, 0.5, 1, 1.5, 2.5]
  return (
    <div className="flex items-center gap-2 mt-3 text-xs text-gray-500">
      <span>낮음</span>
      {stops.map((z) => (
        <span
          key={z}
          className="inline-block w-5 h-3 rounded"
          style={{ background: colorFor(z, 1) }}
          title={`z=${z}`}
        />
      ))}
      <span>높음</span>
      <span className="ml-3">· 빨간 테두리 = 주간 최대 셀</span>
    </div>
  )
}
