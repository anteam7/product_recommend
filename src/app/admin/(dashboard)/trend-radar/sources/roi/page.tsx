import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────
// 시그널 소스 ROI Sankey — 핀 전환 깔때기 보드
// ─────────────────────────────────────────────────────────────
// 좌→우 3단:
//   col1: source (jimscanner_trends_runs.source 와 동일 분류)
//   col2: classified_category (LLM 분류 top)
//   col3: terminal_status (pinned / recommended / rejected / orphan_unclassified)
//
// RPC: supabase/trends_v4_signal_roi_rpc.sql  →  get_signal_roi_flow(days_window)
// generated 타입 미반영 — `as never` 캐스팅 (npm run gen:types 시 해제 가능).
// 동일 캐스팅 패턴: src/app/admin/(dashboard)/trend-radar/recommend/page.tsx

interface RoiRow {
  source: string
  classified_category: string
  terminal_status: string
  flow_count: number
  avg_confidence: number | null
  avg_domain_score: number | null
}

interface SearchParams {
  days?: string
}

const DAYS_OPTIONS = [7, 30] as const

const TERMINAL_ORDER = ['pinned', 'recommended', 'rejected', 'orphan_unclassified'] as const

const TERMINAL_COLOR: Record<string, string> = {
  pinned: '#16a34a',              // green-600
  recommended: '#0ea5e9',         // sky-500
  rejected: '#f59e0b',            // amber-500
  orphan_unclassified: '#dc2626', // red-600
}

const TERMINAL_LABEL: Record<string, string> = {
  pinned: '핀 (검토중)',
  recommended: '추천',
  rejected: '거절',
  orphan_unclassified: '분류 안됨',
}

async function fetchRoi(daysWindow: number): Promise<{ rows: RoiRow[]; error: string | null }> {
  const sb = createAdminClient()
  // RPC 는 supabase/trends_v4_signal_roi_rpc.sql 에 정의 — generated 타입 미반영.
  const { data, error } = await sb.rpc('get_signal_roi_flow' as never, {
    days_window: daysWindow,
  } as never)
  if (error) {
    return { rows: [], error: error.message }
  }
  return { rows: (data ?? []) as RoiRow[], error: null }
}

interface Node {
  id: string
  label: string
  col: 0 | 1 | 2
  total: number
  // 평균 신뢰도 가중치 (0~1)
  avgConfidence: number
}

interface Link {
  from: string
  to: string
  value: number
  // 색은 to 노드 기준(터미널은 단계3) — 단계1→2는 단계3 가중 평균 색
  color: string
}

// 평균 confidence 를 0~1 로 정규화 (domain_score 가 -1~1 이므로 (x+1)/2)
function normConfidence(raw: number | null): number {
  if (raw == null) return 0
  const x = Math.max(-1, Math.min(1, raw))
  return (x + 1) / 2
}

// 노드 + 링크 생성
function buildSankey(rows: RoiRow[]) {
  const sourceTotals = new Map<string, number>()
  const sourceConfSum = new Map<string, number>()
  const catTotals = new Map<string, number>()
  const catConfSum = new Map<string, number>()
  const termTotals = new Map<string, number>()
  const termConfSum = new Map<string, number>()

  // source → category, category → terminal 링크
  const srcCatLinks = new Map<string, { value: number; conf: number }>()
  const catTermLinks = new Map<string, { value: number; conf: number }>()

  for (const r of rows) {
    const conf = normConfidence(r.avg_confidence)
    const value = Number(r.flow_count) || 0
    if (value <= 0) continue

    sourceTotals.set(r.source, (sourceTotals.get(r.source) ?? 0) + value)
    sourceConfSum.set(r.source, (sourceConfSum.get(r.source) ?? 0) + conf * value)
    catTotals.set(r.classified_category, (catTotals.get(r.classified_category) ?? 0) + value)
    catConfSum.set(r.classified_category, (catConfSum.get(r.classified_category) ?? 0) + conf * value)
    termTotals.set(r.terminal_status, (termTotals.get(r.terminal_status) ?? 0) + value)
    termConfSum.set(r.terminal_status, (termConfSum.get(r.terminal_status) ?? 0) + conf * value)

    const sc = `${r.source}|${r.classified_category}`
    const prev1 = srcCatLinks.get(sc) ?? { value: 0, conf: 0 }
    srcCatLinks.set(sc, { value: prev1.value + value, conf: prev1.conf + conf * value })

    const ct = `${r.classified_category}|${r.terminal_status}`
    const prev2 = catTermLinks.get(ct) ?? { value: 0, conf: 0 }
    catTermLinks.set(ct, { value: prev2.value + value, conf: prev2.conf + conf * value })
  }

  const sources: Node[] = [...sourceTotals.entries()]
    .map(([id, total]) => ({
      id,
      label: id,
      col: 0 as const,
      total,
      avgConfidence: (sourceConfSum.get(id) ?? 0) / Math.max(1, total),
    }))
    .sort((a, b) => b.total - a.total)

  const categories: Node[] = [...catTotals.entries()]
    .map(([id, total]) => ({
      id,
      label: id,
      col: 1 as const,
      total,
      avgConfidence: (catConfSum.get(id) ?? 0) / Math.max(1, total),
    }))
    .sort((a, b) => b.total - a.total)

  const terminals: Node[] = TERMINAL_ORDER.filter((t) => termTotals.has(t)).map((t) => ({
    id: t,
    label: TERMINAL_LABEL[t] ?? t,
    col: 2 as const,
    total: termTotals.get(t) ?? 0,
    avgConfidence: (termConfSum.get(t) ?? 0) / Math.max(1, termTotals.get(t) ?? 1),
  }))

  // 링크 색은 단계1→2 는 source 노드 색(인디고 기반), 단계2→3 는 terminal 색
  const srcLinks: Link[] = [...srcCatLinks.entries()].map(([key, v]) => {
    const [from, to] = key.split('|')
    return { from, to, value: v.value, color: '#6366f1' } // indigo-500
  })

  const termLinks: Link[] = [...catTermLinks.entries()].map(([key, v]) => {
    const [from, to] = key.split('|')
    return { from, to, value: v.value, color: TERMINAL_COLOR[to] ?? '#6b7280' }
  })

  return { sources, categories, terminals, srcLinks, termLinks }
}

// 노드 박스 좌표 계산
function layoutColumn(nodes: Node[], xStart: number, xEnd: number, yTop: number, yBottom: number, gap: number) {
  const total = nodes.reduce((s, n) => s + n.total, 0)
  const totalGap = gap * Math.max(0, nodes.length - 1)
  const availH = Math.max(1, yBottom - yTop - totalGap)
  const out: { node: Node; x: number; y: number; w: number; h: number }[] = []
  let y = yTop
  for (const n of nodes) {
    const h = Math.max(2, (n.total / Math.max(1, total)) * availH)
    out.push({ node: n, x: xStart, y, w: xEnd - xStart, h })
    y += h + gap
  }
  return out
}

function cubicPath(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) {
  // 좌→우 sankey 곡선: 양쪽 끝은 수직, 중간은 부드러운 S
  const cxA = (x0 + x2) / 2
  const cxB = (x0 + x2) / 2
  return [
    `M ${x0.toFixed(2)} ${y0.toFixed(2)}`,
    `C ${cxA.toFixed(2)} ${y0.toFixed(2)} ${cxB.toFixed(2)} ${y2.toFixed(2)} ${x2.toFixed(2)} ${y2.toFixed(2)}`,
    `L ${x3.toFixed(2)} ${y3.toFixed(2)}`,
    `C ${cxB.toFixed(2)} ${y3.toFixed(2)} ${cxA.toFixed(2)} ${y1.toFixed(2)} ${x1.toFixed(2)} ${y1.toFixed(2)}`,
    'Z',
  ].join(' ')
}

interface DeadPipe {
  source: string
  total: number
  orphanRate: number
  pinRate: number
}

function computeDeadPipelines(rows: RoiRow[]): DeadPipe[] {
  const agg = new Map<string, { total: number; orphan: number; pinned: number }>()
  for (const r of rows) {
    const v = Number(r.flow_count) || 0
    const prev = agg.get(r.source) ?? { total: 0, orphan: 0, pinned: 0 }
    prev.total += v
    if (r.terminal_status === 'orphan_unclassified') prev.orphan += v
    if (r.terminal_status === 'pinned') prev.pinned += v
    agg.set(r.source, prev)
  }
  return [...agg.entries()]
    .filter(([, v]) => v.total >= 20) // 너무 작은 소스 제외
    .map(([source, v]) => ({
      source,
      total: v.total,
      orphanRate: v.orphan / v.total,
      pinRate: v.pinned / v.total,
    }))
    .sort((a, b) => b.orphanRate - a.orphanRate || b.total - a.total)
}

export default async function SignalRoiPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const days = DAYS_OPTIONS.includes(Number(params.days) as 7 | 30) ? Number(params.days) : 7
  const { rows, error } = await fetchRoi(days)

  const { sources, categories, terminals, srcLinks, termLinks } = buildSankey(rows)
  const dead = computeDeadPipelines(rows)

  // SVG 레이아웃
  const W = 1100
  const H = 560
  const padX = 16
  const colW = 180
  const padY = 16
  const gap = 6

  const xs = {
    col0: padX,
    col1: padX + colW,
    col2: padX + colW * 3,
    col3: padX + colW * 4,
    col4: padX + colW * 6,
    col5: padX + colW * 6 + colW,
  }

  const srcLayout = layoutColumn(sources, xs.col0, xs.col1, padY, H - padY, gap)
  const catLayout = layoutColumn(categories, xs.col2, xs.col3, padY, H - padY, gap)
  const termLayout = layoutColumn(terminals, xs.col4, xs.col5, padY, H - padY, gap)

  const srcById = new Map(srcLayout.map((n) => [n.node.id, n]))
  const catById = new Map(catLayout.map((n) => [n.node.id, n]))
  const termById = new Map(termLayout.map((n) => [n.node.id, n]))

  // 링크의 노드 내 y-offset 계산 (노드를 비례 분할)
  // src→cat 링크
  const srcOutCursor = new Map<string, number>()
  const catInCursor = new Map<string, number>()
  const sortedSrcLinks = [...srcLinks].sort((a, b) => b.value - a.value)
  const srcLinkGeoms = sortedSrcLinks.flatMap((l) => {
    const s = srcById.get(l.from)
    const c = catById.get(l.to)
    if (!s || !c) return []
    const sShare = (s.h * l.value) / Math.max(1, s.node.total)
    const cShare = (c.h * l.value) / Math.max(1, c.node.total)
    const sCur = srcOutCursor.get(l.from) ?? 0
    const cCur = catInCursor.get(l.to) ?? 0
    srcOutCursor.set(l.from, sCur + sShare)
    catInCursor.set(l.to, cCur + cShare)
    const y0 = s.y + sCur
    const y1 = y0 + sShare
    const y2 = c.y + cCur
    const y3 = y2 + cShare
    return [{ l, x0: s.x + s.w, y0, y1, x2: c.x, y2, y3 }]
  })

  // cat→term 링크 (cat 의 out cursor 는 위 in cursor 와 별개)
  const catOutCursor = new Map<string, number>()
  const termInCursor = new Map<string, number>()
  const sortedTermLinks = [...termLinks].sort((a, b) => b.value - a.value)
  const termLinkGeoms = sortedTermLinks.flatMap((l) => {
    const c = catById.get(l.from)
    const t = termById.get(l.to)
    if (!c || !t) return []
    const cShare = (c.h * l.value) / Math.max(1, c.node.total)
    const tShare = (t.h * l.value) / Math.max(1, t.node.total)
    const cCur = catOutCursor.get(l.from) ?? 0
    const tCur = termInCursor.get(l.to) ?? 0
    catOutCursor.set(l.from, cCur + cShare)
    termInCursor.set(l.to, tCur + tShare)
    const y0 = c.y + cCur
    const y1 = y0 + cShare
    const y2 = t.y + tCur
    const y3 = y2 + tShare
    return [{ l, x0: c.x + c.w, y0, y1, x2: t.x, y2, y3 }]
  })

  function nodeColor(n: Node): string {
    if (n.col === 2) return TERMINAL_COLOR[n.id] ?? '#6b7280'
    // confidence 가 높을수록 진한 인디고, 낮으면 회색
    const c = n.avgConfidence
    if (c >= 0.7) return '#4338ca'      // indigo-700
    if (c >= 0.5) return '#6366f1'      // indigo-500
    if (c >= 0.3) return '#a5b4fc'      // indigo-300
    return '#cbd5e1'                     // slate-300
  }

  const totalKeywords = rows.reduce((s, r) => s + Number(r.flow_count || 0), 0)
  const totalPinned = rows
    .filter((r) => r.terminal_status === 'pinned')
    .reduce((s, r) => s + Number(r.flow_count || 0), 0)
  const totalOrphan = rows
    .filter((r) => r.terminal_status === 'orphan_unclassified')
    .reduce((s, r) => s + Number(r.flow_count || 0), 0)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">시그널 소스 ROI</h1>
          <p className="text-sm text-gray-500 mt-1">
            소스 → 분류 카테고리 → 종착 상태 Sankey. dead pipeline (cron 은 돌지만 핀 0) 식별용.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex gap-1">
            {DAYS_OPTIONS.map((d) => (
              <Link
                key={d}
                href={`/admin/trend-radar/sources/roi?days=${d}`}
                className={`px-3 py-1 rounded text-sm border ${
                  d === days
                    ? 'bg-black text-white border-black'
                    : 'bg-white text-gray-700 border-gray-200 hover:border-gray-400'
                }`}
              >
                최근 {d}일
              </Link>
            ))}
          </div>
          <Link
            href="/admin/trend-radar/sources"
            className="text-sm text-gray-700 hover:text-black underline"
          >
            ← 소스 헬스
          </Link>
        </div>
      </header>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          RPC 호출 실패: {error}
          <div className="mt-1 text-xs">
            <code>supabase/trends_v4_signal_roi_rpc.sql</code> 가 DB 에 적용됐는지 확인.
          </div>
        </div>
      )}

      {/* 헤드라인 KPI */}
      <section className="grid grid-cols-4 gap-3">
        <div className="rounded border border-gray-200 p-3">
          <div className="text-xs text-gray-500">총 키워드 행 ({days}일)</div>
          <div className="text-xl font-semibold mt-1">{totalKeywords.toLocaleString()}</div>
        </div>
        <div className="rounded border border-gray-200 p-3">
          <div className="text-xs text-gray-500">핀 전환</div>
          <div className="text-xl font-semibold mt-1" style={{ color: TERMINAL_COLOR.pinned }}>
            {totalPinned.toLocaleString()}{' '}
            <span className="text-xs text-gray-500">
              ({totalKeywords ? ((totalPinned / totalKeywords) * 100).toFixed(1) : '0.0'}%)
            </span>
          </div>
        </div>
        <div className="rounded border border-gray-200 p-3">
          <div className="text-xs text-gray-500">분류 안된 고아</div>
          <div
            className="text-xl font-semibold mt-1"
            style={{ color: TERMINAL_COLOR.orphan_unclassified }}
          >
            {totalOrphan.toLocaleString()}{' '}
            <span className="text-xs text-gray-500">
              ({totalKeywords ? ((totalOrphan / totalKeywords) * 100).toFixed(1) : '0.0'}%)
            </span>
          </div>
        </div>
        <div className="rounded border border-gray-200 p-3">
          <div className="text-xs text-gray-500">활성 소스</div>
          <div className="text-xl font-semibold mt-1">{sources.length}</div>
        </div>
      </section>

      {/* Sankey */}
      <section className="rounded border border-gray-200 bg-white p-3 overflow-x-auto">
        {rows.length === 0 ? (
          <div className="p-12 text-center text-sm text-gray-500">
            최근 {days}일 트렌드 키워드 데이터 없음.
          </div>
        ) : (
          <svg
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            className="block"
            role="img"
            aria-label="시그널 소스 ROI Sankey"
          >
            {/* 컬럼 헤더 */}
            <g fontSize="11" fill="#6b7280">
              <text x={xs.col0} y={10}>소스</text>
              <text x={xs.col2} y={10}>분류 카테고리</text>
              <text x={xs.col4} y={10}>종착 상태</text>
            </g>

            {/* src → cat 링크 (먼저 그려서 노드 아래에 깔리도록) */}
            <g opacity={0.45}>
              {srcLinkGeoms.map((g, i) => (
                <path
                  key={`s${i}`}
                  d={cubicPath(g.x0, g.y0, g.x0, g.y1, g.x2, g.y2, g.x2, g.y3)}
                  fill={g.l.color}
                  stroke="none"
                >
                  <title>
                    {g.l.from} → {g.l.to}: {g.l.value.toLocaleString()}건
                  </title>
                </path>
              ))}
            </g>

            {/* cat → term 링크 */}
            <g opacity={0.55}>
              {termLinkGeoms.map((g, i) => (
                <path
                  key={`t${i}`}
                  d={cubicPath(g.x0, g.y0, g.x0, g.y1, g.x2, g.y2, g.x2, g.y3)}
                  fill={g.l.color}
                  stroke="none"
                >
                  <title>
                    {g.l.from} → {TERMINAL_LABEL[g.l.to] ?? g.l.to}: {g.l.value.toLocaleString()}건
                  </title>
                </path>
              ))}
            </g>

            {/* 노드 */}
            {[...srcLayout, ...catLayout, ...termLayout].map((p) => (
              <g key={`${p.node.col}-${p.node.id}`}>
                <rect
                  x={p.x}
                  y={p.y}
                  width={p.w}
                  height={p.h}
                  fill={nodeColor(p.node)}
                  rx={2}
                >
                  <title>
                    {p.node.label} · {p.node.total.toLocaleString()}건
                    {p.node.col < 2
                      ? ` · avg confidence ${(p.node.avgConfidence * 100).toFixed(0)}%`
                      : ''}
                  </title>
                </rect>
                {p.h >= 12 && (
                  <text
                    x={p.node.col === 2 ? p.x - 6 : p.x + p.w + 6}
                    y={p.y + p.h / 2 + 3}
                    fontSize="11"
                    fill="#111827"
                    textAnchor={p.node.col === 2 ? 'end' : 'start'}
                  >
                    {p.node.label.length > 18 ? p.node.label.slice(0, 18) + '…' : p.node.label}{' '}
                    <tspan fill="#6b7280">({p.node.total.toLocaleString()})</tspan>
                  </text>
                )}
              </g>
            ))}
          </svg>
        )}
      </section>

      {/* Dead pipeline 검출 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          🚨 Dead Pipeline 후보 (orphan 비율 높은 순)
        </h2>
        <p className="text-xs text-gray-500 mb-2">
          cron 은 도는데 분류·핀 전환 흔적이 약한 소스. 보강(분류 프롬프트) 또는 철수 후보.
        </p>
        {dead.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
            데이터 부족 또는 모든 소스가 정상 분류 흐름.
          </div>
        ) : (
          <div className="rounded border border-gray-200 divide-y divide-gray-100">
            {dead.slice(0, 10).map((d) => {
              const danger = d.orphanRate >= 0.6 || d.pinRate === 0
              return (
                <div
                  key={d.source}
                  className="grid grid-cols-12 px-3 py-2 items-center text-sm"
                >
                  <div className="col-span-1 text-lg">
                    <span className={danger ? 'text-red-600' : 'text-gray-300'}>
                      {danger ? '⚠' : '·'}
                    </span>
                  </div>
                  <div className="col-span-4 font-mono">{d.source}</div>
                  <div className="col-span-2 text-right text-gray-600">
                    총 {d.total.toLocaleString()}건
                  </div>
                  <div className="col-span-2 text-right">
                    orphan{' '}
                    <span
                      className={d.orphanRate >= 0.6 ? 'text-red-600 font-semibold' : 'text-gray-600'}
                    >
                      {(d.orphanRate * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div className="col-span-2 text-right">
                    핀 전환{' '}
                    <span
                      className={
                        d.pinRate === 0 ? 'text-red-600 font-semibold' : 'text-green-700'
                      }
                    >
                      {(d.pinRate * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="col-span-1 text-right text-xs text-gray-400">{days}일</div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* 범례 */}
      <section className="rounded border border-dashed border-gray-300 p-3 text-xs text-gray-500">
        <div className="flex flex-wrap gap-4">
          <span>
            노드 폭 = row 수 · 색(소스/카테고리) = 평균 domain_score(직구 본업 연관도)
          </span>
          {TERMINAL_ORDER.map((t) => (
            <span key={t} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block w-3 h-3 rounded-sm"
                style={{ background: TERMINAL_COLOR[t] }}
              />
              {TERMINAL_LABEL[t]}
            </span>
          ))}
        </div>
        <div className="mt-2">
          분류 규칙: pins 매핑 → pinned · category 비어있음 → orphan_unclassified ·
          intent(commercial/transactional) or domain_score≥0.4 → recommended · 나머지 → rejected.
          상세: <code>supabase/trends_v4_signal_roi_rpc.sql</code>
        </div>
      </section>
    </div>
  )
}
