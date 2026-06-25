import Link from 'next/link'
import type { Metadata } from 'next'
import {
  execLogStats24h,
  fetchExecutionLogs,
  type ExecKind,
  type ExecStatus,
} from '@/lib/execution-log'
import { personaById } from '@/lib/personas'
import { scenarioById } from '@/lib/scenarios'

export const metadata: Metadata = { title: '운영 일지 | 셀러 관리자' }
export const dynamic = 'force-dynamic'

const STATUS_STYLE: Record<ExecStatus, string> = {
  ok: 'bg-emerald-100 text-emerald-700',
  fail: 'bg-rose-100 text-rose-700',
  blocked: 'bg-amber-100 text-amber-700',
  skipped: 'bg-gray-100 text-gray-500',
  running: 'bg-blue-100 text-blue-700',
}
const KIND_LABEL: Record<ExecKind, string> = {
  cron: '⏱ 크론',
  persona: '🧑‍💼 페르소나',
  scenario_step: '🗺️ 시나리오',
}

function fmtKST(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function fmtDur(ms: number | null): string {
  if (ms == null) return '–'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60000)}m`
}

const FILTERS: Array<{ label: string; q: Record<string, string> }> = [
  { label: '전체', q: {} },
  { label: '크론', q: { kind: 'cron' } },
  { label: '페르소나', q: { kind: 'persona' } },
  { label: '시나리오', q: { kind: 'scenario_step' } },
  { label: '실패만', q: { status: 'fail' } },
]

const VALID_KINDS: ExecKind[] = ['cron', 'persona', 'scenario_step']
const VALID_STATUS: ExecStatus[] = ['ok', 'fail', 'blocked', 'skipped', 'running']

export default async function ExecutionLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; status?: string }>
}) {
  const sp = await searchParams
  const kind = VALID_KINDS.includes(sp.kind as ExecKind) ? (sp.kind as ExecKind) : undefined
  const status = VALID_STATUS.includes(sp.status as ExecStatus) ? (sp.status as ExecStatus) : undefined

  const [logs, stats] = await Promise.all([
    fetchExecutionLogs({ kind, status, limit: 150 }),
    execLogStats24h(),
  ])

  const scenarioName = (id: string | null) =>
    id ? scenarioById(id)?.name ?? id : null

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-4">
        <h1 className="text-xl font-extrabold text-gray-900">📒 운영 일지</h1>
        <p className="mt-0.5 text-sm text-gray-500">
          페르소나·시나리오·크론의 작업 단위 실행 기록. 무엇이 깨지고 느리고 자주 막히는지의 근거 자료 →{' '}
          <Link href="/admin/scenarios" className="text-blue-600 hover:underline">
            셀러 헬스·회고 시나리오
          </Link>
          의 입력.{' '}
          <Link href="/admin/agent-log" className="text-blue-600 hover:underline">
            루프 단위 로그 →
          </Link>
        </p>
      </div>

      {/* 24h 요약 */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: '24h 실행', value: stats.total, tone: 'text-slate-700' },
          { label: '성공', value: stats.ok, tone: 'text-emerald-600' },
          { label: '실패', value: stats.fail, tone: 'text-rose-600' },
          { label: '차단', value: stats.blocked, tone: 'text-amber-600' },
        ].map((c) => (
          <div key={c.label} className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
            <p className="text-xs text-gray-500">{c.label}</p>
            <p className={`mt-1 text-2xl font-bold ${c.tone}`}>{c.value}</p>
          </div>
        ))}
      </div>

      {/* 필터 */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => {
          const active = (f.q.kind ?? undefined) === kind && (f.q.status ?? undefined) === status
          const qs = new URLSearchParams(f.q).toString()
          return (
            <Link
              key={f.label}
              href={qs ? `/admin/execution-logs?${qs}` : '/admin/execution-logs'}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                active ? 'bg-slate-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {f.label}
            </Link>
          )
        })}
      </div>

      {/* 테이블 */}
      {logs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
          아직 실행 로그가 없습니다. 크론·시나리오 러너가 실행 시 자동 기록하고, 페르소나 위임도{' '}
          <code className="rounded bg-gray-100 px-1">logExecution()</code> 로 기록할 수 있습니다.
          <br />
          (테이블 미생성 시: <code className="rounded bg-gray-100 px-1">supabase/seller_execution_logs.sql</code> 적용 필요)
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                <th className="px-3 py-2 font-medium">시각</th>
                <th className="px-3 py-2 font-medium">종류</th>
                <th className="px-3 py-2 font-medium">소스</th>
                <th className="px-3 py-2 font-medium">시나리오 / 페르소나</th>
                <th className="px-3 py-2 font-medium">상태</th>
                <th className="px-3 py-2 font-medium">소요</th>
                <th className="px-3 py-2 font-medium">요약</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((r) => {
                const persona = r.persona_id ? personaById(r.persona_id) : null
                const sName = scenarioName(r.scenario_id)
                return (
                  <tr key={r.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-500">
                      {fmtKST(r.created_at)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs">
                      {KIND_LABEL[r.kind] ?? r.kind}
                    </td>
                    <td className="px-3 py-2 font-medium text-gray-800">{r.source}</td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      {sName && <span className="mr-1">{sName}</span>}
                      {persona && (
                        <span
                          className="rounded bg-slate-100 px-1.5 py-0.5"
                          style={{ color: persona.accent }}
                        >
                          {persona.nameKr}
                        </span>
                      )}
                      {!sName && !persona && <span className="text-gray-300">–</span>}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                          STATUS_STYLE[r.status] ?? 'bg-gray-100 text-gray-500'
                        }`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-500">
                      {fmtDur(r.duration_ms)}
                    </td>
                    <td
                      className="max-w-xs truncate px-3 py-2 text-xs text-gray-500"
                      title={r.summary ?? ''}
                    >
                      {r.error ? <span className="text-rose-600">{r.error}</span> : r.summary ?? '–'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
