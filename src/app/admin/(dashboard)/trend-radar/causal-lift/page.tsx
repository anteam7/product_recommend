import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface LiftRow {
  id: string
  action_id: string
  pin_id: string
  action_type: string
  action_at: string
  category_top: string | null
  plc_stage: string | null
  lift_volume_7d: number | null
  lift_volume_28d: number | null
  ci_lo: number | null
  ci_hi: number | null
  is_significant: boolean | null
  control_set: string[] | null
  control_size: number | null
  computed_at: string
}

async function fetchData() {
  const sb = createAdminClient()
  const since = new Date(Date.now() - 90 * 86400_000).toISOString()

  // jimscanner_actions_lift_cache 는 신규 테이블 — types 재생성 전이라 as any 캐스팅.
  const { data, error } = await (sb as any)
    .from('jimscanner_actions_lift_cache')
    .select('*')
    .gte('action_at', since)
    .order('action_at', { ascending: false })
    .limit(500)

  if (error) {
    return { rows: [] as LiftRow[], errorMsg: error.message }
  }
  return { rows: ((data ?? []) as LiftRow[]), errorMsg: null as string | null }
}

function fmtNum(v: number | null | undefined, digits = 1) {
  if (v == null || !Number.isFinite(v)) return '—'
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toFixed(digits)}`
}

export default async function CausalLiftPage() {
  const { rows, errorMsg } = await fetchData()

  const total = rows.length
  const significant = rows.filter((r) => r.is_significant).length
  const sigRatio = total > 0 ? Math.round((significant / total) * 100) : 0

  // 액션 타입별 평균 28d lift (= ROI 프록시)
  const byType = new Map<string, { count: number; sumLift: number; sig: number }>()
  for (const r of rows) {
    const k = r.action_type
    let v = byType.get(k)
    if (!v) { v = { count: 0, sumLift: 0, sig: 0 }; byType.set(k, v) }
    v.count++
    if (r.lift_volume_28d != null) v.sumLift += r.lift_volume_28d
    if (r.is_significant) v.sig++
  }
  const ranking = [...byType.entries()]
    .map(([type, v]) => ({
      type,
      count: v.count,
      avgLift: v.count > 0 ? v.sumLift / v.count : 0,
      sig: v.sig,
      sigRatio: v.count > 0 ? Math.round((v.sig / v.count) * 100) : 0,
    }))
    .sort((a, b) => b.avgLift - a.avgLift)

  // 핀별 그룹핑 (타임라인)
  const byPin = new Map<string, LiftRow[]>()
  for (const r of rows) {
    if (!byPin.has(r.pin_id)) byPin.set(r.pin_id, [])
    byPin.get(r.pin_id)!.push(r)
  }
  const pinList = [...byPin.entries()]
    .map(([pin, items]) => ({
      pin,
      items: items.sort((a, b) => a.action_at.localeCompare(b.action_at)),
      sig: items.filter((i) => i.is_significant).length,
      total: items.length,
      bestLift: Math.max(...items.map((i) => i.lift_volume_28d ?? -Infinity)),
    }))
    .sort((a, b) => b.bestLift - a.bestLift)
    .slice(0, 30)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">핀 행동 인과효과 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            합성대조군 기반 Diff-in-Differences · 같은 카테고리 비핀 키워드 N≤20 대비 7/28일 lift · 95% bootstrap CI
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {errorMsg && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          <strong>cache 조회 실패:</strong> {errorMsg} — supabase/causal_lift.sql 마이그레이션 미적용일 수 있음.
        </div>
      )}

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="측정된 액션" value={total} hint="최근 90일" />
        <KpiCard label="유의 lift 발생" value={significant} hint={`${sigRatio}% · CI excludes 0`} />
        <KpiCard label="액션 타입" value={byType.size} hint="구분된 행동 유형" />
        <KpiCard label="추적 핀" value={byPin.size} hint="액션 받은 핀" />
      </section>

      {/* 액션 타입별 ROI 랭킹 */}
      <section className="rounded border border-gray-200 p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">
          액션 타입별 평균 lift (28일) — ROI 랭킹
        </h2>
        {ranking.length === 0 ? (
          <div className="text-sm text-gray-500 text-center py-6">
            아직 측정 데이터 없음. <code className="px-1 bg-gray-100 rounded">node --env-file=.env.local scripts/compute-causal-lift.mjs</code>
          </div>
        ) : (
          <div className="space-y-1">
            <div className="grid grid-cols-12 text-xs text-gray-500 px-2 py-1">
              <div className="col-span-1">#</div>
              <div className="col-span-4">액션 타입</div>
              <div className="col-span-2 text-right">avg lift</div>
              <div className="col-span-2 text-right">유의 / 전체</div>
              <div className="col-span-3 text-right">유의 비율</div>
            </div>
            {ranking.map((r, i) => (
              <div key={r.type} className="grid grid-cols-12 px-2 py-1 text-sm rounded hover:bg-gray-50">
                <div className="col-span-1 font-mono text-gray-400">{i + 1}</div>
                <div className="col-span-4 truncate font-medium">{r.type}</div>
                <div className={`col-span-2 text-right font-mono font-bold ${r.avgLift > 0 ? 'text-emerald-700' : r.avgLift < 0 ? 'text-rose-700' : 'text-gray-500'}`}>
                  {fmtNum(r.avgLift)}
                </div>
                <div className="col-span-2 text-right font-mono text-gray-600">
                  {r.sig} / {r.count}
                </div>
                <div className="col-span-3 text-right text-xs text-gray-500">{r.sigRatio}%</div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 핀별 타임라인 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">
          핀별 액션 타임라인 (best 28d lift 상위 30)
        </h2>
        {pinList.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
            <p className="text-base font-medium">측정 데이터 없음</p>
            <p className="text-sm mt-2">
              admin_actions 가 핀 키워드(target_id 또는 metadata.keyword)와 연결되어야 측정됨.
              <br />
              로컬 cron: <code className="px-1 bg-gray-100 rounded">node --env-file=.env.local scripts/compute-causal-lift.mjs</code>
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {pinList.map((p) => (
              <div key={p.pin} className="rounded border border-gray-200 p-3">
                <div className="flex items-baseline justify-between mb-2">
                  <div>
                    <div className="font-medium text-sm">{p.pin}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {p.total}개 액션 · 유의 {p.sig}건 · best lift {fmtNum(p.bestLift)}
                    </div>
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="grid grid-cols-12 text-xs text-gray-500 px-1">
                    <div className="col-span-2">일자</div>
                    <div className="col-span-3">액션</div>
                    <div className="col-span-2 text-right">lift 7d</div>
                    <div className="col-span-2 text-right">lift 28d</div>
                    <div className="col-span-2 text-right">CI (28d)</div>
                    <div className="col-span-1 text-right">유의</div>
                  </div>
                  {p.items.map((it) => (
                    <div key={it.action_id} className="grid grid-cols-12 px-1 py-1 text-xs rounded hover:bg-gray-50">
                      <div className="col-span-2 font-mono text-gray-500">{it.action_at.slice(0, 10)}</div>
                      <div className="col-span-3 truncate">{it.action_type}</div>
                      <div className={`col-span-2 text-right font-mono ${num(it.lift_volume_7d) > 0 ? 'text-emerald-700' : num(it.lift_volume_7d) < 0 ? 'text-rose-700' : 'text-gray-500'}`}>
                        {fmtNum(it.lift_volume_7d)}
                      </div>
                      <div className={`col-span-2 text-right font-mono font-semibold ${num(it.lift_volume_28d) > 0 ? 'text-emerald-700' : num(it.lift_volume_28d) < 0 ? 'text-rose-700' : 'text-gray-500'}`}>
                        {fmtNum(it.lift_volume_28d)}
                      </div>
                      <div className="col-span-2 text-right font-mono text-gray-500">
                        [{fmtNum(it.ci_lo)}, {fmtNum(it.ci_hi)}]
                      </div>
                      <div className="col-span-1 text-right">
                        {it.is_significant ? (
                          <span className="inline-block px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[10px] font-semibold">SIG</span>
                        ) : (
                          <span className="text-gray-400 text-[10px]">—</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function num(v: number | null | undefined): number {
  return v == null || !Number.isFinite(v) ? 0 : v
}

function KpiCard({ label, value, hint }: { label: string; value: number; hint: string | number }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}
