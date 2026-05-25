import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface VelocityRow {
  keyword: string
  sellers_28d: number
  new_sellers_7d: number
  churned_sellers_7d: number
  active_sellers_2d: number
  new_seller_rate_pct: number
  churn_rate_pct: number
  entry_phase: 'rush' | 'saturating' | 'cooling' | 'stable' | 'unknown'
}

interface VolumeRow {
  keyword: string
  volume_relative: number | null
}

const PHASE_LABEL: Record<VelocityRow['entry_phase'], { label: string; cls: string }> = {
  rush:       { label: '🚀 골드러시', cls: 'bg-red-100 text-red-800 border-red-200' },
  saturating: { label: '⚠️ 포화시작',  cls: 'bg-amber-100 text-amber-800 border-amber-200' },
  cooling:    { label: '❄️ 식어감',     cls: 'bg-sky-100 text-sky-800 border-sky-200' },
  stable:     { label: '✓ 안정',       cls: 'bg-gray-100 text-gray-700 border-gray-200' },
  unknown:    { label: '?',           cls: 'bg-gray-50 text-gray-500 border-gray-200' },
}

async function fetchData() {
  const sb = createAdminClient()

  // view: as any (regenerated 안 된 schema)
  const { data: velocity, error } = await (sb as any)
    .from('serp_entry_velocity_v')
    .select('keyword, sellers_28d, new_sellers_7d, churned_sellers_7d, active_sellers_2d, new_seller_rate_pct, churn_rate_pct, entry_phase')
    .gte('sellers_28d', 3)
    .order('new_seller_rate_pct', { ascending: false })
    .limit(200)

  if (error) {
    return { rows: [], volumeMap: new Map<string, number>(), err: error.message }
  }

  const rows = (velocity ?? []) as VelocityRow[]

  // volume_relative join — 키워드 최근 14일 max
  const since = new Date(Date.now() - 14 * 86400000).toISOString()
  const { data: vols } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, volume_relative')
    .in('source', ['naver_search_trend', 'naver_shopping_insight'])
    .gte('collected_at', since)
    .limit(2000)

  const volumeMap = new Map<string, number>()
  for (const v of (vols ?? []) as VolumeRow[]) {
    if (!v.volume_relative) continue
    const cur = volumeMap.get(v.keyword) ?? 0
    if (v.volume_relative > cur) volumeMap.set(v.keyword, v.volume_relative)
  }

  return { rows, volumeMap, err: null }
}

export default async function SellerEntryPage() {
  const { rows, volumeMap, err } = await fetchData()

  // KPI
  const phaseCounts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.entry_phase] = (acc[r.entry_phase] ?? 0) + 1
    return acc
  }, {})

  // scatter 좌표 (x=volume, y=new_seller_rate_pct, 색=phase)
  const scatter = rows
    .filter((r) => volumeMap.has(r.keyword))
    .map((r) => ({
      keyword: r.keyword,
      x: volumeMap.get(r.keyword) ?? 0,
      y: r.new_seller_rate_pct,
      phase: r.entry_phase,
      churn: r.churn_rate_pct,
    }))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">SERP 신규 셀러 진입률</h1>
          <p className="text-sm text-gray-500 mt-1">
            Competitive Entry Velocity · 키워드별 최근 7일 신규 진입 셀러 / 28일 누적 셀러
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {err && (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          뷰 조회 실패: {err}. <code>supabase/serp_seller_snapshots.sql</code> 적용 필요.
        </div>
      )}

      <section className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <KpiCard label="키워드 (≥3 셀러)" value={rows.length} hint="28일 누적" />
        <KpiCard label="🚀 골드러시" value={phaseCounts.rush ?? 0} hint="신규 ≥30% · 이탈 <15%" />
        <KpiCard label="⚠️ 포화시작" value={phaseCounts.saturating ?? 0} hint="신규·이탈 둘 다 ≥15%" />
        <KpiCard label="❄️ 식어감"   value={phaseCounts.cooling ?? 0} hint="이탈 ≥25%" />
        <KpiCard label="✓ 안정"     value={phaseCounts.stable ?? 0} hint="기준 미만" />
      </section>

      <Scatter points={scatter} />

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">신규 진입률 Top 50</h2>
        {rows.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
            <p className="text-base font-medium">아직 스냅샷이 없습니다</p>
            <p className="text-sm mt-2">
              <code className="px-1 bg-gray-100 rounded">
                node --env-file=.env.local scripts/collect-naver-shopping-serp.mjs
              </code>
              <br />
              일 1회 cron 등록 필요. 28일 누적 후에야 phase 분류가 안정됨.
            </p>
          </div>
        ) : (
          <div className="rounded border border-gray-200">
            <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-2 border-b border-gray-200 bg-gray-50">
              <div className="col-span-4">키워드</div>
              <div className="col-span-2">Phase</div>
              <div className="col-span-1 text-right">신규</div>
              <div className="col-span-1 text-right">이탈</div>
              <div className="col-span-1 text-right">신규%</div>
              <div className="col-span-1 text-right">이탈%</div>
              <div className="col-span-1 text-right">28일</div>
              <div className="col-span-1 text-right">검색량</div>
            </div>
            {rows.slice(0, 50).map((r) => {
              const ph = PHASE_LABEL[r.entry_phase]
              return (
                <div key={r.keyword} className="grid grid-cols-12 px-3 py-2 text-sm border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                  <div className="col-span-4 truncate font-medium">{r.keyword}</div>
                  <div className="col-span-2">
                    <span className={`inline-block px-2 py-0.5 text-xs rounded border ${ph.cls}`}>{ph.label}</span>
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-600">{r.new_sellers_7d}</div>
                  <div className="col-span-1 text-right font-mono text-gray-600">{r.churned_sellers_7d}</div>
                  <div className="col-span-1 text-right font-mono font-bold">{r.new_seller_rate_pct}%</div>
                  <div className="col-span-1 text-right font-mono text-gray-600">{r.churn_rate_pct}%</div>
                  <div className="col-span-1 text-right font-mono text-gray-500">{r.sellers_28d}</div>
                  <div className="col-span-1 text-right font-mono text-gray-500">
                    {volumeMap.get(r.keyword)?.toFixed(0) ?? '—'}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

function KpiCard({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}

function Scatter({ points }: { points: { keyword: string; x: number; y: number; phase: string; churn: number }[] }) {
  if (points.length === 0) {
    return (
      <section className="rounded border border-gray-200 p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-2">진입속도 산점도</h2>
        <p className="text-xs text-gray-500">검색량 매핑된 키워드가 없습니다.</p>
      </section>
    )
  }
  const W = 720, H = 280, P = 36
  const maxX = Math.max(...points.map((p) => p.x), 100)
  const maxY = Math.max(...points.map((p) => p.y), 50)

  const colorOf = (phase: string) =>
    phase === 'rush' ? '#dc2626'
      : phase === 'saturating' ? '#d97706'
      : phase === 'cooling' ? '#0284c7'
      : '#6b7280'

  return (
    <section className="rounded border border-gray-200 p-4">
      <h2 className="text-sm font-semibold text-gray-700 mb-2">
        진입속도 산점도{' '}
        <span className="text-xs font-normal text-gray-500 ml-1">
          x=검색량 · y=신규진입률% · 색=phase
        </span>
      </h2>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-3xl">
        <line x1={P} y1={H - P} x2={W - 8} y2={H - P} stroke="#d1d5db" />
        <line x1={P} y1={8} x2={P} y2={H - P} stroke="#d1d5db" />
        <text x={W - 8} y={H - P + 14} textAnchor="end" fontSize="10" fill="#6b7280">검색량 →</text>
        <text x={P + 4} y={14} fontSize="10" fill="#6b7280">신규진입률% ↑</text>
        {points.map((p, i) => {
          const cx = P + (p.x / maxX) * (W - P - 8)
          const cy = (H - P) - (p.y / maxY) * (H - P - 8)
          const r = 4 + Math.min(p.churn / 10, 6)
          return (
            <circle
              key={`${p.keyword}-${i}`}
              cx={cx}
              cy={cy}
              r={r}
              fill={colorOf(p.phase)}
              fillOpacity={0.55}
              stroke={colorOf(p.phase)}
            >
              <title>{p.keyword} · 신규{p.y}% · 이탈{p.churn}%</title>
            </circle>
          )
        })}
      </svg>
      <div className="flex gap-3 text-xs text-gray-600 mt-2">
        <span><span className="inline-block w-3 h-3 rounded-full mr-1" style={{ background: '#dc2626' }} />rush</span>
        <span><span className="inline-block w-3 h-3 rounded-full mr-1" style={{ background: '#d97706' }} />saturating</span>
        <span><span className="inline-block w-3 h-3 rounded-full mr-1" style={{ background: '#0284c7' }} />cooling</span>
        <span><span className="inline-block w-3 h-3 rounded-full mr-1" style={{ background: '#6b7280' }} />stable</span>
        <span className="ml-2 text-gray-400">원 크기 = churn rate</span>
      </div>
    </section>
  )
}
