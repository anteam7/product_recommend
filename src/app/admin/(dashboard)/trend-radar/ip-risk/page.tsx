import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface IpRiskRow {
  id: string
  keyword: string
  keyword_kind: string
  ip_class: string
  risk_score: number
  risk_grade: 'safe' | 'caution' | 'block' | string
  active_marks: number
  dead_marks: number
  exact_hit: boolean
  class_47_hit: boolean
  pb_coupang_hit: boolean
  celeb_hit: boolean
  bigcorp_hit: boolean
  opposition_count: number
  trial_count: number
  top_mark_name: string | null
  top_mark_applicant: string | null
  top_mark_app_no: string | null
  top_mark_status: string | null
  top_mark_app_date: string | null
  top_mark_expire_date: string | null
  alt_terms: string[] | null
  scanned_at: string
}

interface RunRow {
  id: string
  started_at: string
  finished_at: string | null
  scanned_keywords: number
  blocked_count: number
  caution_count: number
  safe_count: number
  error_count: number
}

const GRADE_OPTIONS = [
  { v: '', label: '전체' },
  { v: 'block', label: '🛑 block' },
  { v: 'caution', label: '⚠️ caution' },
  { v: 'safe', label: '✓ safe' },
] as const

async function fetchData(grade: string) {
  const sb = createAdminClient()

  let query = sb
    // 신설 테이블은 generated 타입에 아직 없음 — `as never` 캐스팅.
    .from('jimscanner_ip_risk' as never)
    .select(
      'id, keyword, keyword_kind, ip_class, risk_score, risk_grade, active_marks, dead_marks, exact_hit, class_47_hit, pb_coupang_hit, celeb_hit, bigcorp_hit, opposition_count, trial_count, top_mark_name, top_mark_applicant, top_mark_app_no, top_mark_status, top_mark_app_date, top_mark_expire_date, alt_terms, scanned_at',
    )
    .order('risk_score', { ascending: false })
    .limit(500)

  if (grade) query = query.eq('risk_grade', grade) as typeof query

  const { data: rowsRaw, error } = (await query) as {
    data: IpRiskRow[] | null
    error: { message: string } | null
  }

  const { data: runsRaw } = (await sb
    .from('jimscanner_ip_risk_runs' as never)
    .select('id, started_at, finished_at, scanned_keywords, blocked_count, caution_count, safe_count, error_count')
    .order('started_at', { ascending: false })
    .limit(5)) as { data: RunRow[] | null }

  return {
    rows: (rowsRaw ?? []) as IpRiskRow[],
    runs: (runsRaw ?? []) as RunRow[],
    error: error?.message ?? null,
  }
}

function gradePill(grade: string) {
  if (grade === 'block') return 'bg-red-100 text-red-800 border-red-200'
  if (grade === 'caution') return 'bg-amber-100 text-amber-800 border-amber-200'
  if (grade === 'safe') return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  return 'bg-gray-100 text-gray-600 border-gray-200'
}

function gradeIcon(grade: string) {
  if (grade === 'block') return '🛑'
  if (grade === 'caution') return '⚠️'
  if (grade === 'safe') return '✓'
  return '·'
}

export default async function IpRiskPage({
  searchParams,
}: {
  searchParams: Promise<{ grade?: string }>
}) {
  const sp = await searchParams
  const grade = sp.grade ?? ''

  const { rows, runs, error } = await fetchData(grade)

  const total = rows.length
  const blocked = rows.filter((r) => r.risk_grade === 'block').length
  const caution = rows.filter((r) => r.risk_grade === 'caution').length
  const safe = rows.filter((r) => r.risk_grade === 'safe').length
  const lastRun = runs[0]

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🛡 KIPRIS IP 리스크 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            핀·추천 후보 토큰을 KIPRIS Open API 로 야간 조회 — 활성 상표·출원인·47류 매칭·분쟁이력으로 risk_score 산출.
            카드의 IP 배지(safe/caution/block)에 동기화됨.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 안내 */}
      <div className="rounded border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900 space-y-1">
        <div>
          <strong>실행:</strong>{' '}
          <code className="font-mono">node --env-file=.env.local scripts/kipris-ip-risk-scan.mjs</code>{' '}
          (run-crons 와 함께 등록 가능)
        </div>
        <div>
          <strong>KIPRIS_API_KEY</strong> 미설정 시 dry-run 모드(룰 추정)로 동작.
          정확한 게이트는 plus.kipris.or.kr 키 발급 후 활성화.
        </div>
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500">등급</span>
        {GRADE_OPTIONS.map((g) => {
          const active = grade === g.v
          const href = g.v ? `/admin/trend-radar/ip-risk?grade=${g.v}` : '/admin/trend-radar/ip-risk'
          return (
            <Link
              key={g.v || 'all'}
              href={href}
              className={`px-2 py-1 text-xs rounded ${active ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {g.label}
            </Link>
          )
        })}
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="스캔 키워드" value={total} />
        <Kpi label="🛑 block" value={blocked} highlight={blocked > 0} highlightTone="red" />
        <Kpi label="⚠️ caution" value={caution} />
        <Kpi label="✓ safe" value={safe} />
        <Kpi
          label="마지막 스캔"
          value={lastRun?.finished_at ? lastRun.finished_at.slice(0, 16).replace('T', ' ') : '—'}
        />
      </section>

      {/* 에러 */}
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 space-y-1">
          <div>로드 실패: <code className="font-mono text-xs">{error}</code></div>
          <div className="text-xs">
            테이블 <code>jimscanner_ip_risk</code> 가 DB 에 적용 안 됐을 가능성.{' '}
            <code>supabase/kipris_ip_risk.sql</code> 적용 필요.
          </div>
        </div>
      )}

      {/* 결과 */}
      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">스캔 결과 없음</div>
          <div className="text-xs text-gray-400">
            첫 실행: <code className="font-mono">node --env-file=.env.local scripts/kipris-ip-risk-scan.mjs --limit 50</code>
          </div>
        </div>
      ) : (
        <div className="rounded border border-gray-200 divide-y divide-gray-100">
          {rows.map((r) => (
            <div key={r.id} className="px-4 py-3 grid grid-cols-12 gap-3 items-start text-sm">
              <div className="col-span-3">
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded border ${gradePill(r.risk_grade)}`}>
                    {gradeIcon(r.risk_grade)} {r.risk_grade}
                  </span>
                  <span className="text-xs text-gray-400 font-mono">{r.risk_score.toFixed(2)}</span>
                </div>
                <div className="font-medium mt-1">{r.keyword}</div>
                <div className="text-[11px] text-gray-500 mt-0.5">
                  {r.keyword_kind} · class {r.ip_class}
                </div>
              </div>

              <div className="col-span-3 text-xs space-y-0.5">
                <div>
                  활성 <span className="font-mono">{r.active_marks}</span>{' '}
                  · 사장 <span className="font-mono text-gray-400">{r.dead_marks}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {r.exact_hit && <span className="bg-red-50 text-red-700 px-1.5 py-0.5 rounded text-[10px]">정확일치</span>}
                  {r.class_47_hit && <span className="bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded text-[10px]">47류</span>}
                  {r.pb_coupang_hit && <span className="bg-red-50 text-red-700 px-1.5 py-0.5 rounded text-[10px]">쿠팡PB</span>}
                  {r.bigcorp_hit && <span className="bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded text-[10px]">대기업</span>}
                  {r.celeb_hit && <span className="bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded text-[10px]">셀럽</span>}
                  {(r.opposition_count + r.trial_count) > 0 && (
                    <span className="bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded text-[10px]">
                      분쟁 {r.opposition_count + r.trial_count}
                    </span>
                  )}
                </div>
              </div>

              <div className="col-span-3 text-xs">
                {r.top_mark_name ? (
                  <div className="space-y-0.5">
                    <div className="font-medium">{r.top_mark_name}</div>
                    <div className="text-gray-500">{r.top_mark_applicant ?? '—'}</div>
                    <div className="text-[10px] text-gray-400 font-mono">
                      {r.top_mark_status ?? '—'} · {r.top_mark_app_no ?? r.top_mark_expire_date ?? ''}
                    </div>
                  </div>
                ) : (
                  <span className="text-gray-400">매칭 상표 없음</span>
                )}
              </div>

              <div className="col-span-3 text-xs">
                {(r.alt_terms ?? []).length > 0 ? (
                  <div>
                    <div className="text-[10px] text-gray-500 mb-0.5">대체어 후보</div>
                    <div className="flex flex-wrap gap-1">
                      {(r.alt_terms ?? []).map((t) => (
                        <span key={t} className="bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded text-[10px]">
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : (
                  <span className="text-gray-400 text-[10px]">대체어 없음</span>
                )}
                <div className="text-[10px] text-gray-400 font-mono mt-1">
                  {r.scanned_at.slice(0, 16).replace('T', ' ')}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 최근 실행 */}
      {runs.length > 0 && (
        <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
          <div className="font-semibold text-gray-700">📋 최근 스캔 실행</div>
          <table className="w-full">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-100">
                <th className="py-1">시각</th>
                <th>처리</th>
                <th>block</th>
                <th>caution</th>
                <th>safe</th>
                <th>err</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-gray-100">
                  <td className="py-1">{r.started_at.slice(0, 16).replace('T', ' ')}</td>
                  <td>{r.scanned_keywords}</td>
                  <td className="text-red-700">{r.blocked_count}</td>
                  <td className="text-amber-700">{r.caution_count}</td>
                  <td className="text-emerald-700">{r.safe_count}</td>
                  <td>{r.error_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}

function Kpi({
  label,
  value,
  highlight = false,
  highlightTone = 'red',
}: {
  label: string
  value: number | string
  highlight?: boolean
  highlightTone?: 'red' | 'amber'
}) {
  const tone = highlight
    ? highlightTone === 'red'
      ? 'border-red-300 bg-red-50'
      : 'border-amber-300 bg-amber-50'
    : 'border-gray-200'
  const valTone = highlight
    ? highlightTone === 'red'
      ? 'text-red-700'
      : 'text-amber-700'
    : ''
  return (
    <div className={`rounded border p-3 ${tone}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${valTone}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
