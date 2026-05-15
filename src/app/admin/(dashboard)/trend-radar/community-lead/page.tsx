import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface LeadRow {
  product_id: string
  canonical_name: string
  category_top: string | null
  community_rolling_14d: number
  commerce_rolling_14d: number
  lead_days: number
  dominant_board: string | null
  ggsan_match_count: number
  community_first_seen: string
  commerce_first_seen: string | null
}

const DAYS_OPTIONS = [
  { v: 7,  label: '7일' },
  { v: 14, label: '14일 (기본)' },
  { v: 30, label: '30일' },
] as const

const SIM_OPTIONS = [
  { v: 0.2,  label: '0.20 (느슨)' },
  { v: 0.25, label: '0.25 (기본)' },
  { v: 0.35, label: '0.35 (엄격)' },
] as const

const RESULT_LIMIT = 100

// 커뮤니티 보드 → 표시 라벨 + 인구통계 chip
const BOARD_META: Record<string, { label: string; demo: string; tone: string }> = {
  '82cook':            { label: '82cook',   demo: '주부',   tone: 'bg-pink-100 text-pink-700' },
  '82cook_talk':       { label: '82cook',   demo: '주부',   tone: 'bg-pink-100 text-pink-700' },
  '82cook_recipe':     { label: '82cook',   demo: '주부',   tone: 'bg-pink-100 text-pink-700' },
  'natepan':           { label: '네이트판', demo: '여초',   tone: 'bg-rose-100 text-rose-700' },
  'natepan_top':       { label: '네이트판', demo: '여초',   tone: 'bg-rose-100 text-rose-700' },
  'ppomppu':           { label: '뽐뿌',     demo: '남초',   tone: 'bg-blue-100 text-blue-700' },
  'ppomppu_sale':      { label: '뽐뿌',     demo: '남초',   tone: 'bg-blue-100 text-blue-700' },
  'ppomppu_freeboard': { label: '뽐뿌',     demo: '남초',   tone: 'bg-blue-100 text-blue-700' },
  'dcinside':          { label: '디시',     demo: '남초',   tone: 'bg-slate-100 text-slate-700' },
  'dcinside_hit':      { label: '디시',     demo: '남초',   tone: 'bg-slate-100 text-slate-700' },
  'clien':             { label: '클리앙',   demo: '남초',   tone: 'bg-emerald-100 text-emerald-700' },
  'clien_park':        { label: '클리앙',   demo: '남초',   tone: 'bg-emerald-100 text-emerald-700' },
}

async function fetchRows(opts: { days: number; sim: number; ggsanOnly: boolean }) {
  const sb = createAdminClient()
  // RPC가 마이그레이션 후에만 존재 — 타입 안전 위해 any 캐스팅
  const { data, error } = await (sb as any).rpc('jimscanner_community_lead', {
    days_window: opts.days,
    min_sim: opts.sim,
    result_limit: RESULT_LIMIT,
  })
  if (error) {
    console.error('community_lead rpc error', error)
    return [] as LeadRow[]
  }
  let rows = (data ?? []) as LeadRow[]
  if (opts.ggsanOnly) rows = rows.filter((r) => r.ggsan_match_count > 0)
  return rows
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/community-lead' + (qs ? `?${qs}` : '')
}

export default async function CommunityLeadPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; sim?: string; ggsan?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '14', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 14
  const sim = parseFloat(sp.sim ?? '0.25')
  const validSim = SIM_OPTIONS.some((s) => Math.abs(s.v - sim) < 0.001) ? sim : 0.25
  const ggsanOnly = sp.ggsan === '1'

  const current: Record<string, string> = {
    days: String(validDays),
    sim: String(validSim),
    ggsan: ggsanOnly ? '1' : '',
  }

  const rows = await fetchRows({ days: validDays, sim: validSim, ggsanOnly })
  // lead_days DESC 정렬 (commerce 가 아직 안 떴으면 windowed 최대)
  const sorted = [...rows].sort((a, b) => {
    if (b.lead_days !== a.lead_days) return b.lead_days - a.lead_days
    const aGap = a.community_rolling_14d - a.commerce_rolling_14d
    const bGap = b.community_rolling_14d - b.commerce_rolling_14d
    return bGap - aGap
  })

  const ggsanMatched = rows.filter((r) => r.ggsan_match_count > 0).length
  const pureLead = rows.filter((r) => r.commerce_rolling_14d === 0).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🌊 커뮤니티 선행 (lead-lag)</h1>
          <p className="text-sm text-gray-500 mt-1">
            82cook · 네이트판 · 뽐뿌 · 디시 · 클리앙 raw 시그널이 네이버 commerce 보다 먼저
            반응한 product 후보. <strong>lead_days DESC</strong> · 도매 플리핑 발굴용.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-4 rounded border border-gray-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">롤링 기간</span>
          {DAYS_OPTIONS.map((d) => (
            <Link
              key={d.v}
              href={buildHref(current, { days: String(d.v) })}
              className={`px-2 py-1 text-xs rounded ${validDays === d.v ? 'bg-cyan-100 text-cyan-800 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {d.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">유사도 ≥</span>
          {SIM_OPTIONS.map((s) => (
            <Link
              key={s.v}
              href={buildHref(current, { sim: String(s.v) })}
              className={`px-2 py-1 text-xs rounded ${Math.abs(validSim - s.v) < 0.001 ? 'bg-cyan-100 text-cyan-800 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {s.label}
            </Link>
          ))}
        </div>
        <Link
          href={buildHref(current, { ggsan: ggsanOnly ? null : '1' })}
          className={`px-3 py-1 text-xs rounded ${ggsanOnly ? 'bg-amber-100 text-amber-700 font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
        >
          {ggsanOnly ? '✓ ' : ''}ggsan 매칭만
        </Link>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="후보 product" value={rows.length} />
        <Kpi label="ggsan 매칭" value={ggsanMatched} highlight={ggsanMatched > 0} />
        <Kpi label="순수 선행 (commerce=0)" value={pureLead} highlight={pureLead > 0} />
        <Kpi label="최대 lead_days" value={sorted[0]?.lead_days ?? 0} />
      </section>

      {/* 결과 카드 */}
      {sorted.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div>조건에 맞는 커뮤니티 선행 후보 없음</div>
          <div className="text-xs text-gray-400">
            유사도 임계값을 낮추거나 기간을 늘려보세요. 14일 누적 권장.
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
            <div className="col-span-1">#</div>
            <div className="col-span-4">canonical product</div>
            <div className="col-span-2">dominant board</div>
            <div className="col-span-1 text-right">community</div>
            <div className="col-span-1 text-right">commerce</div>
            <div className="col-span-1 text-right">lead_days</div>
            <div className="col-span-1 text-right">ggsan</div>
            <div className="col-span-1 text-right">first_seen</div>
          </div>
          {sorted.map((r, i) => {
            const meta = r.dominant_board ? BOARD_META[r.dominant_board] : null
            const isPureLead = r.commerce_rolling_14d === 0
            return (
              <Link
                key={r.product_id}
                href={`/admin/trend-radar/products/${r.product_id}`}
                className={`grid grid-cols-12 px-3 py-2 rounded border transition-colors ${
                  isPureLead
                    ? 'border-cyan-300 bg-cyan-50/50 hover:bg-cyan-50'
                    : 'border-gray-200 hover:bg-gray-50'
                }`}
              >
                <div className="col-span-1 text-gray-400 font-mono">{i + 1}</div>
                <div className="col-span-4">
                  <div className="font-medium leading-snug">{r.canonical_name}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{r.category_top ?? '-'}</div>
                </div>
                <div className="col-span-2 flex items-center gap-1 flex-wrap">
                  {meta ? (
                    <>
                      <span className={`text-[11px] px-2 py-0.5 rounded font-semibold ${meta.tone}`}>
                        {meta.label}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                        {meta.demo}
                      </span>
                    </>
                  ) : (
                    <span className="text-[11px] text-gray-400">{r.dominant_board ?? '-'}</span>
                  )}
                </div>
                <div className="col-span-1 text-right font-mono font-bold text-cyan-700">
                  {r.community_rolling_14d}
                </div>
                <div className="col-span-1 text-right font-mono text-gray-600">
                  {r.commerce_rolling_14d}
                </div>
                <div className="col-span-1 text-right font-mono font-bold">
                  {r.lead_days}
                  <span className="text-[10px] text-gray-400 ml-0.5">d</span>
                </div>
                <div className="col-span-1 text-right">
                  {r.ggsan_match_count > 0 ? (
                    <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700 font-semibold">
                      {r.ggsan_match_count}
                    </span>
                  ) : (
                    <span className="text-xs text-gray-300">—</span>
                  )}
                </div>
                <div className="col-span-1 text-right text-xs text-gray-400">
                  {r.community_first_seen.slice(5, 10)}
                </div>
              </Link>
            )
          })}
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div>
          <strong>lead_days</strong> = commerce 첫 등장일 − 커뮤니티 첫 등장일. commerce 미출현 시 윈도우 길이로 캡.
        </div>
        <div>
          <strong>도매 플리핑 정석:</strong> 뽐뿌·82cook 등 커뮤니티에서 터지기 시작했지만 네이버쇼핑/홈쇼핑은
          아직 잠잠한 (lead_days ↑ + commerce=0) 상품에서 ggsan 도매 매칭이 잡히는 후보가 우선순위.
        </div>
        <div>
          dominant_board 의 demographic chip(주부/남초/여초)은 타겟 마케팅 작성 시 참고.
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-cyan-300 bg-cyan-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-cyan-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
