import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import SubstitutionFlow from './SubstitutionFlow'

export const dynamic = 'force-dynamic'

export interface SubstitutionRow {
  category_top: string
  faller_keyword: string
  riser_keyword: string
  faller_source: string
  riser_source: string
  faller_slope: number
  riser_slope: number
  pearson: number
  overlap_days: number
  faller_recent: number | null
  riser_recent: number | null
  faller_peak: number | null
  riser_recent_share: number | null
  prev_demand_estimate: number | null
  crossing_at: string | null
  cluster_label: string | null
}

const DAYS_OPTIONS = [
  { v: 14, label: '14일' },
  { v: 28, label: '28일 (기본)' },
  { v: 56, label: '56일' },
] as const

const CORR_OPTIONS = [
  { v: -0.3, label: '-0.3 (느슨)' },
  { v: -0.4, label: '-0.4 (기본)' },
  { v: -0.6, label: '-0.6 (강한 음상관)' },
] as const

async function fetchSubstitution(opts: { days: number; maxCorr: number }) {
  const sb = createAdminClient()
  // RPC는 DB(supabase/demand_substitution_rpc.sql)에 존재하나 generated 타입 미반영 — gen:types 시 캐스팅 제거
  const { data, error } = await sb.rpc('jimscanner_demand_substitution' as never, {
    days_window: opts.days,
    min_points: 5,
    min_slope: 0.0,
    max_corr: opts.maxCorr,
    result_limit: 120,
  } as never)
  if (error) return { rows: [] as SubstitutionRow[], error: error.message }
  return { rows: (data ?? []) as SubstitutionRow[], error: null as string | null }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/substitution' + (qs ? `?${qs}` : '')
}

export default async function SubstitutionPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; corr?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '28', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 28
  const corr = parseFloat(sp.corr ?? '-0.4')
  const validCorr = CORR_OPTIONS.some((c) => Math.abs(c.v - corr) < 0.001) ? corr : -0.4

  const current: Record<string, string> = { days: String(validDays), corr: String(validCorr) }

  const { rows, error } = await fetchSubstitution({ days: validDays, maxCorr: validCorr })

  const cats = Array.from(new Set(rows.map((r) => r.category_top))).sort()
  const strongest = rows.length > 0 ? rows[0] : null
  const totalLeak = rows.reduce((s, r) => s + (Number(r.prev_demand_estimate) || 0), 0)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🔀 수요 대체 레이더</h1>
          <p className="text-sm text-gray-500 mt-1">
            같은 need-space 안에서 <strong>쇠퇴 incumbent → 부상 substitute</strong> 로 수요가 새는 쌍을
            음상관(Pearson)으로 탐지. 부상 대체재를 교차 시점에 선점하면 리드타임 손해 없이 수요를 흡수.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-indigo-200 bg-indigo-50 px-4 py-3 text-xs text-indigo-900">
        <strong>읽는 법</strong> · 왼쪽(빨강) = 수요가 빠지는 incumbent(faller), 오른쪽(초록) = 흡수하는
        substitute(riser). 화살표 위 숫자는 두 궤적의 음상관 강도(Pearson, −1 에 가까울수록 깔끔한 교대).
        opportunity 보드와 달리 <strong>단일 점수가 아닌 쌍의 수요 교대</strong>를 본다.
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">관측 창</span>
          {DAYS_OPTIONS.map((d) => (
            <Link
              key={d.v}
              href={buildHref(current, { days: String(d.v) })}
              className={`px-2 py-1 text-xs rounded ${validDays === d.v ? 'bg-indigo-100 text-indigo-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {d.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Pearson ≤</span>
          {CORR_OPTIONS.map((c) => (
            <Link
              key={c.v}
              href={buildHref(current, { corr: String(c.v) })}
              className={`px-2 py-1 text-xs rounded ${Math.abs(validCorr - c.v) < 0.001 ? 'bg-indigo-100 text-indigo-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {c.label}
            </Link>
          ))}
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="대체 엣지" value={rows.length} />
        <Kpi label="need-space 수" value={cats.length} />
        <Kpi
          label="최강 음상관"
          value={strongest ? Number(strongest.pearson).toFixed(2) : '—'}
        />
        <Kpi label="누수 수요 합(peak)" value={Math.round(totalLeak)} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_demand_substitution</code> 미적용 가능성. supabase/demand_substitution_rpc.sql 적용 필요.
          </p>
        </div>
      )}

      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">탐지된 대체 쌍 없음</div>
          <div className="text-xs text-gray-400">
            트레일링 {validDays}일 안에서 음상관(≤ {validCorr}) 쌍이 아직 없음.
            <br />
            Pearson 임계값을 -0.3 으로 느슨하게 하거나 56일로 창을 늘려보기. 시계열 누적 후 풍부해짐.
          </div>
        </div>
      ) : (
        <SubstitutionFlow rows={rows} />
      )}

      {/* 공식 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 탐지 로직</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          need-space = 동일 category_top
          <br />
          faller = 트레일링 {validDays}일 regr_slope(volume_relative) &lt; 0
          <br />
          riser = 같은 need-space 안에서 regr_slope &gt; 0
          <br />
          edge 조건 = corr(faller, riser) ≤ {validCorr} (음상관) · 겹치는 관측일 ≥ 5
          <br />
          prev_demand_estimate = faller 의 peak volume_relative (쥐고 있던 수요량)
          <br />
          crossing_at = riser 값이 faller 값을 처음 추월한 날
        </code>
        <div className="pt-2">
          <strong>액션:</strong> riser → <em>대체재 선점</em>(ggsan 매칭·위탁 등록) ·
          faller → <em>incumbent 회피</em>(신규 진입 손절/관망). 인접 렌즈(#44 lead-lag · #43 self-cannibal · #31 co-search)
          와 달리 <strong>경쟁 need-space 내 교체</strong>를 음상관으로 잡는다.
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded border border-gray-200 p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
