import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface AuditRow {
  id: string
  decision_id: string | null
  target_type: string
  target_key: string
  audited_at: string
  age_days: number
  regret_score: number
  signals: Record<string, unknown> | null
  notes: string | null
}

interface DecisionRow {
  id: string
  target_type: string
  target_key: string
  source: string | null
  decision: string
  reason: string | null
  reason_code: string | null
  decided_at: string
}

const REGRET_THRESHOLD = 60

async function fetchData() {
  const sb = createAdminClient()

  // 최신 감사 결과 (target+age_days 별 최신만)
  // jimscanner_trends_regret_audits 는 마이그레이션 이후 존재. types 미반영 → as any.
  const auditsRes = await (sb as any)
    .from('jimscanner_trends_regret_audits')
    .select('id, decision_id, target_type, target_key, audited_at, age_days, regret_score, signals, notes')
    .order('audited_at', { ascending: false })
    .limit(2000)

  const allAudits: AuditRow[] = (auditsRes.data ?? []) as AuditRow[]

  // 각 (target_key, age_days) 의 최신 감사만
  const latestByKey = new Map<string, AuditRow>()
  for (const a of allAudits) {
    const k = `${a.target_type}::${a.target_key}::${a.age_days}`
    if (!latestByKey.has(k)) latestByKey.set(k, a)
  }
  const latest = Array.from(latestByKey.values())

  // 명시적 reject 결정 (있으면) — 사유 집계용
  const decisionsRes = await (sb as any)
    .from('jimscanner_trends_pin_decisions')
    .select('id, target_type, target_key, source, decision, reason, reason_code, decided_at')
    .eq('decision', 'reject')
    .order('decided_at', { ascending: false })
    .limit(1000)
  const decisions: DecisionRow[] = (decisionsRes.data ?? []) as DecisionRow[]
  const decisionById = new Map(decisions.map((d) => [d.id, d]))

  // 사유별 집계
  type ReasonAgg = { reason: string; total: number; regretted: number }
  const byReason = new Map<string, ReasonAgg>()
  for (const a of latest) {
    if (!a.decision_id) continue
    const d = decisionById.get(a.decision_id)
    const reason = d?.reason_code ?? d?.reason ?? 'unspecified'
    if (!byReason.has(reason)) byReason.set(reason, { reason, total: 0, regretted: 0 })
    const agg = byReason.get(reason)!
    agg.total++
    if (a.regret_score >= REGRET_THRESHOLD) agg.regretted++
  }
  const reasonAggs = Array.from(byReason.values()).sort(
    (a, b) => b.regretted / Math.max(1, b.total) - a.regretted / Math.max(1, a.total),
  )

  // KPI
  const totalAudits = latest.length
  const regretted = latest.filter((a) => a.regret_score >= REGRET_THRESHOLD).length
  const falseNegRate = totalAudits > 0 ? regretted / totalAudits : 0
  const avgScore =
    totalAudits > 0 ? latest.reduce((s, a) => s + Number(a.regret_score), 0) / totalAudits : 0

  // Top-N 후보 (regret_score 내림차순)
  const top = [...latest].sort((a, b) => b.regret_score - a.regret_score).slice(0, 40)

  return {
    kpi: { totalAudits, regretted, falseNegRate, avgScore },
    reasonAggs,
    top,
    decisionsCount: decisions.length,
    proxyMode: decisions.length === 0,
  }
}

function fmtPct(v: number) {
  return `${(v * 100).toFixed(1)}%`
}

function scoreColor(score: number) {
  if (score >= 80) return 'bg-red-100 text-red-800'
  if (score >= 60) return 'bg-orange-100 text-orange-800'
  if (score >= 40) return 'bg-yellow-50 text-yellow-800'
  return 'bg-gray-50 text-gray-600'
}

export default async function RegretAuditPage() {
  let result: Awaited<ReturnType<typeof fetchData>> | null = null
  let errorMessage: string | null = null
  try {
    result = await fetchData()
  } catch (e: unknown) {
    errorMessage = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">거절 사후 감사 (Regret Audit)</h1>
          <p className="text-sm text-gray-500 mt-1">
            거절한 키워드/상품을 30/60/90일 후 재평가. 거절 결정의 false-negative 비율과 회후 발굴 후보.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {errorMessage && (
        <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
          <div className="font-semibold mb-1">감사 데이터 로드 실패</div>
          <div className="font-mono text-xs">{errorMessage}</div>
          <div className="mt-2 text-xs">
            마이그레이션 미적용 가능성. <code>supabase/trends_v4_regret_audit.sql</code> 을 먼저 적용하세요.
          </div>
        </div>
      )}

      {result && (
        <>
          {result.proxyMode && (
            <div className="rounded border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
              <span className="font-semibold">Proxy 모드: </span>
              명시적 reject 결정(<code>jimscanner_trends_pin_decisions</code>)이 없어, 분류된 키워드 중 pinned=false 항목을 거절 proxy 로 평가합니다.
            </div>
          )}

          {/* KPI */}
          <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard
              label="평가된 거절 수"
              value={result.kpi.totalAudits.toLocaleString()}
              sub={`최신 (target × age_days) 기준`}
            />
            <KpiCard
              label="후회 (regret≥60)"
              value={result.kpi.regretted.toLocaleString()}
              sub={`임계치 ${REGRET_THRESHOLD}`}
            />
            <KpiCard
              label="False-Negative Rate"
              value={fmtPct(result.kpi.falseNegRate)}
              sub="후회 / 총 평가"
              highlight={result.kpi.falseNegRate >= 0.2}
            />
            <KpiCard
              label="평균 regret_score"
              value={result.kpi.avgScore.toFixed(1)}
              sub="0~100"
            />
          </section>

          {/* 사유별 후회율 */}
          <section className="space-y-2">
            <h2 className="text-lg font-semibold">거절 사유별 후회율</h2>
            {result.reasonAggs.length === 0 ? (
              <p className="text-sm text-gray-500">
                사유 코드가 기록된 명시적 거절이 없습니다. <code>jimscanner_trends_pin_decisions.reason_code</code> 를 채워 넣으면 여기에 집계됩니다.
              </p>
            ) : (
              <div className="rounded border border-gray-200 divide-y divide-gray-100">
                <div className="px-4 py-2 grid grid-cols-12 text-xs font-semibold text-gray-500 bg-gray-50">
                  <div className="col-span-6">사유</div>
                  <div className="col-span-2 text-right">총</div>
                  <div className="col-span-2 text-right">후회</div>
                  <div className="col-span-2 text-right">후회율</div>
                </div>
                {result.reasonAggs.map((r) => {
                  const rate = r.total > 0 ? r.regretted / r.total : 0
                  return (
                    <div key={r.reason} className="px-4 py-2 grid grid-cols-12 text-sm">
                      <div className="col-span-6 font-mono text-xs">{r.reason}</div>
                      <div className="col-span-2 text-right">{r.total}</div>
                      <div className="col-span-2 text-right">{r.regretted}</div>
                      <div className={`col-span-2 text-right font-semibold ${rate >= 0.3 ? 'text-red-600' : rate >= 0.15 ? 'text-orange-600' : 'text-gray-700'}`}>
                        {fmtPct(rate)}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {/* Top 후회 후보 */}
          <section className="space-y-2">
            <h2 className="text-lg font-semibold">Top 회후 발굴 후보</h2>
            {result.top.length === 0 ? (
              <div className="rounded border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
                아직 감사 결과 없음. <code>node --env-file=.env.local scripts/audit-rejected-pins.mjs</code> 를 실행하세요.
              </div>
            ) : (
              <div className="rounded border border-gray-200 divide-y divide-gray-100 overflow-hidden">
                <div className="px-4 py-2 grid grid-cols-12 text-xs font-semibold text-gray-500 bg-gray-50">
                  <div className="col-span-1">score</div>
                  <div className="col-span-1">age</div>
                  <div className="col-span-5">target</div>
                  <div className="col-span-3">signals</div>
                  <div className="col-span-2 text-right">감사일</div>
                </div>
                {result.top.map((a) => {
                  const s = (a.signals ?? {}) as Record<string, unknown>
                  const summary = [
                    s.tvtime_reappearance ? `TV×${s.tvtime_reappearance}` : null,
                    s.ggsan_restock ? 'ggsan재입고' : null,
                    Number(s.ggsan_price_drop_pct) > 0 ? `가격↓${s.ggsan_price_drop_pct}%` : null,
                    Number(s.news_velocity) > 0 ? `news/${s.news_velocity}d` : null,
                    Number(s.blog_velocity) > 0 ? `blog/${s.blog_velocity}d` : null,
                  ].filter(Boolean).join(', ')
                  return (
                    <div key={a.id} className="px-4 py-2 grid grid-cols-12 items-center text-sm">
                      <div className="col-span-1">
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-mono font-semibold ${scoreColor(a.regret_score)}`}>
                          {Math.round(a.regret_score)}
                        </span>
                      </div>
                      <div className="col-span-1 text-xs text-gray-500 font-mono">{a.age_days}d</div>
                      <div className="col-span-5">
                        <div className="font-medium">{a.target_key}</div>
                        <div className="text-xs text-gray-500">{a.target_type}{a.notes ? ` · ${a.notes}` : ''}</div>
                      </div>
                      <div className="col-span-3 text-xs text-gray-600">{summary || '—'}</div>
                      <div className="col-span-2 text-right text-xs text-gray-400 font-mono">
                        {a.audited_at?.slice(0, 16)}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <footer className="pt-4 text-xs text-gray-400">
            decisions={result.decisionsCount} · regret threshold={REGRET_THRESHOLD}
          </footer>
        </>
      )}
    </div>
  )
}

function KpiCard({
  label,
  value,
  sub,
  highlight,
}: {
  label: string
  value: string
  sub?: string
  highlight?: boolean
}) {
  return (
    <div className={`rounded border p-4 ${highlight ? 'border-red-300 bg-red-50' : 'border-gray-200 bg-white'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-red-700' : 'text-gray-900'}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
    </div>
  )
}
