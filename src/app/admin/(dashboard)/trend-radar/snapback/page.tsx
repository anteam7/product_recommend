import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface SnapbackRow {
  id: string
  cycle_key: string
  sample_title: string | null
  sample_site_label: string | null
  deal_started_at: string
  deal_ended_at: string
  deal_span_days: number | null
  matched_trend_keyword: string | null
  trend_source: string | null
  pre_deal_avg: number | null
  during_deal_peak: number | null
  post_end_avg_7d: number | null
  post_end_avg_14d: number | null
  recovery_curve: Array<{ d: number; v: number }> | null
  snapback_ratio: number | null
  snapback_score: number | null
  recommended_entry_offset_days: number | null
  status: string
  computed_at: string
}

async function fetchData() {
  const sb = createAdminClient()
  // 신규 테이블 — types/supabase 미반영, as any 캐스팅 (CLAUDE.md 정책)
  const { data, error } = await (sb as any)
    .from('jimscanner_deal_snapback_scores')
    .select(
      'id, cycle_key, sample_title, sample_site_label, deal_started_at, deal_ended_at, deal_span_days, matched_trend_keyword, trend_source, pre_deal_avg, during_deal_peak, post_end_avg_7d, post_end_avg_14d, recovery_curve, snapback_ratio, snapback_score, recommended_entry_offset_days, status, computed_at',
    )
    .order('snapback_score', { ascending: false, nullsFirst: false })
    .limit(100)
  if (error) {
    return { rows: [] as SnapbackRow[], error: error.message }
  }
  return { rows: (data ?? []) as SnapbackRow[], error: null as string | null }
}

function avgRatio(rows: SnapbackRow[]) {
  const vs = rows.map((r) => r.snapback_ratio).filter((v): v is number => v != null)
  if (!vs.length) return null
  return vs.reduce((a, b) => a + b, 0) / vs.length
}

function fmtPct(v: number | null | undefined) {
  if (v == null) return '—'
  return `${Math.round(v * 100)}%`
}

function RecoveryChart({ curve }: { curve: Array<{ d: number; v: number }> | null }) {
  if (!curve || curve.length === 0) {
    return <div className="text-[10px] text-gray-400">곡선 데이터 없음</div>
  }
  const maxV = Math.max(1, ...curve.map((p) => p.v))
  const w = 240
  const h = 64
  const minD = -14
  const maxD = 14
  const xOf = (d: number) => ((d - minD) / (maxD - minD)) * w
  const yOf = (v: number) => h - (v / maxV) * (h - 8) - 4
  const pts = curve.map((p) => `${xOf(p.d).toFixed(1)},${yOf(p.v).toFixed(1)}`).join(' ')
  return (
    <svg width={w} height={h} className="block">
      <line x1={xOf(0)} y1={0} x2={xOf(0)} y2={h} stroke="#fb923c" strokeDasharray="2 2" />
      {curve.map((p, i) => (
        <circle key={i} cx={xOf(p.d)} cy={yOf(p.v)} r={2} className="fill-indigo-500" />
      ))}
      <polyline points={pts} fill="none" stroke="#6366f1" strokeWidth={1.5} />
    </svg>
  )
}

export default async function SnapbackPage() {
  const { rows, error } = await fetchData()
  const total = rows.length
  const pinned = rows.filter((r) => r.status === 'pinned').length
  const avg = avgRatio(rows)
  const queue = rows
    .filter((r) => (r.snapback_score ?? 0) >= 50 && r.status === 'candidate')
    .slice(0, 8)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">⚡ Post-Deal Snapback</h1>
          <p className="text-sm text-gray-500 mt-1">
            핫딜 종료 후 정상가 수요 회복 윈도우. quasarzone 사이클 ↔ 네이버 검색량 매칭.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {error && (
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          데이터 조회 오류: {error}
          <br />
          <span className="text-amber-700">
            마이그레이션(supabase/post_deal_snapback.sql) 적용 후 cron(scripts/analyze-deal-snapback.mjs) 1회 실행 필요.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="ended 사이클" value={String(total)} hint="snapback 점수 산출됨" />
        <Stat label="평균 스냅백 비율" value={fmtPct(avg)} hint="post7 / peak" />
        <Stat label="핀된 후보" value={String(pinned)} hint="status=pinned" />
        <Stat label="진입 큐" value={String(queue.length)} hint="score ≥ 50, 미핀" />
      </div>

      <section className="bg-gradient-to-br from-amber-50 to-white border border-amber-200 rounded-lg p-4">
        <h2 className="text-sm font-bold text-gray-900 mb-2">🎯 진입 D-day 큐</h2>
        {queue.length === 0 ? (
          <p className="text-xs text-gray-500">아직 진입 권장 후보 없음. 데이터 누적 후 다시 방문.</p>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {queue.map((r) => (
              <div key={r.id} className="bg-white border rounded-md p-3 text-xs space-y-1">
                <div className="font-semibold text-gray-900 line-clamp-2">{r.sample_title ?? r.cycle_key}</div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">
                    score {r.snapback_score ?? '?'}
                  </span>
                  <span className="text-[10px] text-gray-500">
                    snapback {fmtPct(r.snapback_ratio)}
                  </span>
                </div>
                <div className="text-[11px] text-gray-700">
                  진입 D+{r.recommended_entry_offset_days ?? '?'}
                </div>
                <div className="text-[10px] text-gray-400">
                  종료 {new Date(r.deal_ended_at).toLocaleDateString('ko-KR')}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="bg-white border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-gray-900">📈 전체 스냅백 후보</h2>
          <span className="text-[11px] text-gray-500">최신 100건</span>
        </div>
        {rows.length === 0 ? (
          <div className="text-xs text-gray-500 py-6 text-center border border-dashed border-gray-200 rounded">
            아직 산출 결과 없음.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[860px]">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold text-gray-600">상품 / 키워드</th>
                  <th className="text-right px-2 py-2 font-semibold text-gray-600">score</th>
                  <th className="text-right px-2 py-2 font-semibold text-gray-600">snapback</th>
                  <th className="text-right px-2 py-2 font-semibold text-gray-600">peak / post7</th>
                  <th className="text-right px-2 py-2 font-semibold text-gray-600">D+n</th>
                  <th className="text-left px-3 py-2 font-semibold text-gray-600">회복 곡선</th>
                  <th className="text-left px-3 py-2 font-semibold text-gray-600">상태</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-b-0 align-top">
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-900 line-clamp-1">
                        {r.sample_title ?? r.cycle_key}
                      </div>
                      <div className="text-[10px] text-gray-500">
                        {r.sample_site_label && (
                          <span className="px-1 py-0.5 rounded bg-fuchsia-50 text-fuchsia-700 mr-1">
                            {r.sample_site_label}
                          </span>
                        )}
                        매칭 「{r.matched_trend_keyword ?? '—'}」
                      </div>
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-gray-900">
                      {r.snapback_score ?? '—'}
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-gray-700">
                      {fmtPct(r.snapback_ratio)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-gray-500">
                      {r.during_deal_peak != null ? Math.round(r.during_deal_peak) : '—'} /{' '}
                      {r.post_end_avg_7d != null ? Math.round(r.post_end_avg_7d) : '—'}
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-gray-700">
                      {r.recommended_entry_offset_days != null
                        ? `D+${r.recommended_entry_offset_days}`
                        : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <RecoveryChart curve={r.recovery_curve} />
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded ${
                          r.status === 'pinned'
                            ? 'bg-emerald-100 text-emerald-700'
                            : r.status === 'promoted'
                              ? 'bg-blue-100 text-blue-700'
                              : r.status === 'dismissed'
                                ? 'bg-gray-100 text-gray-500'
                                : 'bg-amber-100 text-amber-700'
                        }`}
                      >
                        {r.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="text-[10px] text-gray-400">
        cron: <code>node scripts/analyze-deal-snapback.mjs</code> · 마이그레이션:{' '}
        <code>supabase/post_deal_snapback.sql</code>
      </p>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-white border rounded-lg p-3">
      <div className="text-[11px] font-semibold text-gray-600">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-gray-900">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-gray-500">{hint}</div>}
    </div>
  )
}
