import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

type AgentRun = {
  id: string
  created_at: string
  loop_name: string
  level: string
  triggered_by: string
  status: string
  summary: string | null
  stats: { processed?: number; succeeded?: number; failed?: number; warned?: number } | null
  duration_ms: number | null
}

const LOOP_LABELS: Record<string, string> = {
  'daily-triage': '일일 트리지',
  'ops-sweep': 'Ops 스윕',
  'upick-naver-register': '유픽→네이버 등록',
  'coupang-register': '쿠팡 등록',
  'naver-seo-ops': '네이버 SEO',
  'script-diagnose': '스크립트 진단',
}

const STATUS_STYLE: Record<string, string> = {
  completed: 'bg-green-100 text-green-800',
  partial: 'bg-yellow-100 text-yellow-800',
  failed: 'bg-red-100 text-red-800',
  running: 'bg-blue-100 text-blue-800',
}

const LEVEL_STYLE: Record<string, string> = {
  L1: 'bg-gray-100 text-gray-600',
  L2: 'bg-orange-100 text-orange-700',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sbLoose(): any {
  return createAdminClient()
}

async function fetchRuns(loopFilter?: string): Promise<AgentRun[]> {
  let q = sbLoose()
    .from('jimscanner_agent_runs')
    .select('id, created_at, loop_name, level, triggered_by, status, summary, stats, duration_ms')
    .order('created_at', { ascending: false })
    .limit(200)

  if (loopFilter && loopFilter !== 'all') q = q.eq('loop_name', loopFilter)

  const { data, error } = await q
  if (error) {
    console.error('agent-log fetch error:', error)
    return []
  }
  return data ?? []
}

const ALLOWED_LOOPS = new Set([
  'all', 'daily-triage', 'ops-sweep', 'upick-naver-register',
  'coupang-register', 'naver-seo-ops', 'script-diagnose',
])

function toKST(iso: string) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '-'
  return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false })
}

export default async function AgentLogPage({
  searchParams,
}: {
  searchParams: Promise<{ loop?: string }>
}) {
  const params = await searchParams
  const rawLoop = params.loop ?? 'all'
  const loopFilter = ALLOWED_LOOPS.has(rawLoop) ? rawLoop : 'all'
  const runs = await fetchRuns(loopFilter === 'all' ? undefined : loopFilter)

  const loopOptions = [
    { value: 'all', label: '전체' },
    ...Object.entries(LOOP_LABELS).map(([value, label]) => ({ value, label })),
  ]

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">🤖 에이전트 실행 로그</h1>
        <p className="mt-1 text-sm text-gray-500">
          Loop Engineering 이해도 부채 방지 — 에이전트가 무엇을·왜·어떻게 했는지 기록합니다.
        </p>
      </div>

      {/* 루프 필터 */}
      <div className="flex flex-wrap gap-2 mb-6">
        {loopOptions.map((opt) => (
          <Link
            key={opt.value}
            href={`/admin/agent-log${opt.value === 'all' ? '' : `?loop=${opt.value}`}`}
            className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
              loopFilter === opt.value
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
            }`}
          >
            {opt.label}
          </Link>
        ))}
      </div>

      {/* 통계 요약 */}
      {runs.length > 0 && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          {(['completed', 'partial', 'failed', 'running'] as const).map((s) => {
            const count = runs.filter((r) => r.status === s).length
            return (
              <div key={s} className="bg-white rounded-lg border p-4 text-center">
                <div className={`text-lg font-bold ${count > 0 && s === 'failed' ? 'text-red-600' : 'text-gray-900'}`}>
                  {count}
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {{ completed: '성공', partial: '부분성공', failed: '실패', running: '실행중' }[s]}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 실행 목록 */}
      {runs.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <div className="text-4xl mb-3">📭</div>
          <p>아직 실행 기록이 없습니다.</p>
          <p className="text-sm mt-1">run-crons.mjs 실행 후 자동으로 기록됩니다.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {runs.map((run) => (
            <Link
              key={run.id}
              href={`/admin/agent-log/${run.id}`}
              className="block bg-white rounded-lg border border-gray-200 p-4 hover:border-blue-300 hover:shadow-sm transition-all"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLE[run.status] ?? 'bg-gray-100 text-gray-600'}`}>
                    {run.status}
                  </span>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${LEVEL_STYLE[run.level] ?? 'bg-gray-100'}`}>
                    {run.level}
                  </span>
                  <span className="font-medium text-gray-800">
                    {LOOP_LABELS[run.loop_name] ?? run.loop_name}
                  </span>
                  <span className="text-xs text-gray-400">
                    {run.triggered_by === 'auto' ? '⚙️ 자동' : '👤 수동'}
                  </span>
                </div>
                <div className="text-xs text-gray-400 whitespace-nowrap">
                  {toKST(run.created_at)}
                  {run.duration_ms != null && (
                    <span className="ml-2 text-gray-300">{(run.duration_ms / 1000).toFixed(1)}s</span>
                  )}
                </div>
              </div>

              {run.summary && (
                <p className="mt-2 text-sm text-gray-600 line-clamp-2">{run.summary}</p>
              )}

              {run.stats && (
                <div className="mt-2 flex gap-3 text-xs text-gray-500">
                  {run.stats.processed != null && <span>처리 {run.stats.processed}</span>}
                  {run.stats.succeeded != null && <span className="text-green-600">✓ {run.stats.succeeded}</span>}
                  {run.stats.failed != null && run.stats.failed > 0 && (
                    <span className="text-red-600">✗ {run.stats.failed}</span>
                  )}
                  {run.stats.warned != null && run.stats.warned > 0 && (
                    <span className="text-yellow-600">⚠ {run.stats.warned}</span>
                  )}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
