import Link from 'next/link'
import { notFound } from 'next/navigation'
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
  what_happened: string | null
  why: string | null
  how: string | null
  stats: Record<string, number> | null
  detail: Record<string, unknown> | null
  duration_ms: number | null
  workspace_path: string | null
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sbLoose(): any {
  return createAdminClient()
}

async function fetchRun(id: string): Promise<AgentRun | null> {
  const { data, error } = await sbLoose()
    .from('jimscanner_agent_runs')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !data) return null
  return data as AgentRun
}

function toKST(iso: string) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '-'
  return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false })
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-lg border border-gray-200 p-5">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">{title}</h2>
      {children}
    </section>
  )
}

export default async function AgentRunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const run = await fetchRun(id)
  if (!run) notFound()

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* 뒤로가기 */}
      <Link href="/admin/agent-log" className="text-sm text-blue-600 hover:underline mb-4 inline-block">
        ← 목록으로
      </Link>

      {/* 헤더 */}
      <div className="mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          <span className={`px-2.5 py-1 rounded-full text-sm font-medium ${STATUS_STYLE[run.status] ?? 'bg-gray-100 text-gray-600'}`}>
            {run.status}
          </span>
          <h1 className="text-xl font-bold text-gray-900">
            {LOOP_LABELS[run.loop_name] ?? run.loop_name}
          </h1>
          <span className="text-sm text-gray-400">{run.level}</span>
          <span className="text-sm text-gray-400">
            {run.triggered_by === 'auto' ? '⚙️ 자동 실행' : '👤 수동 실행'}
          </span>
        </div>
        <div className="mt-2 text-sm text-gray-500">
          {toKST(run.created_at)}
          {run.duration_ms != null && ` · ${(run.duration_ms / 1000).toFixed(1)}초 소요`}
        </div>
        {run.summary && (
          <p className="mt-3 text-gray-700 font-medium">{run.summary}</p>
        )}
      </div>

      <div className="space-y-4">
        {/* 통계 */}
        {run.stats && Object.keys(run.stats).length > 0 && (
          <Section title="📊 수치">
            <div className="flex flex-wrap gap-6">
              {Object.entries(run.stats).map(([k, v]) => (
                <div key={k} className="text-center">
                  <div className="text-2xl font-bold text-gray-800">{v}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{k}</div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* 무엇을 했는지 */}
        {run.what_happened && (
          <Section title="📋 무엇을 했나 (What)">
            <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
              {run.what_happened}
            </div>
          </Section>
        )}

        {/* 왜 했는지 */}
        {run.why && (
          <Section title="🎯 왜 했나 (Why)">
            <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
              {run.why}
            </div>
          </Section>
        )}

        {/* 어떻게 했는지 */}
        {run.how && (
          <Section title="⚙️ 어떻게 했나 (How)">
            <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed font-mono bg-gray-50 rounded p-3">
              {run.how}
            </div>
          </Section>
        )}

        {/* 상세 데이터 */}
        {run.detail && Object.keys(run.detail).length > 0 && (
          <Section title="🔍 상세 데이터">
            <pre className="text-xs text-gray-600 overflow-auto max-h-96 bg-gray-50 rounded p-3">
              {JSON.stringify(run.detail, null, 2)}
            </pre>
          </Section>
        )}

        {/* 파일 경로 */}
        {run.workspace_path && (
          <Section title="📁 저장 위치">
            <code className="text-sm text-gray-600 bg-gray-50 px-2 py-1 rounded">
              {run.workspace_path}
            </code>
          </Section>
        )}
      </div>
    </div>
  )
}
