import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface BriefRow {
  date: string
  brief_md: string
  signals_jsonb: any
  action_items: any
  source_links: any
  model: string | null
  input_token_count: number
  output_token_count: number
  status: string
  notes: string | null
  generated_at: string
}

interface ActionItem {
  label: string
  reason: string
  link: string | null
  priority: 'high' | 'med' | 'low'
}

async function fetchBriefs() {
  const sb = createAdminClient()
  const { data, error } = await (sb as any)
    .from('jimscanner_trends_daily_brief')
    .select('date, brief_md, signals_jsonb, action_items, source_links, model, input_token_count, output_token_count, status, notes, generated_at')
    .order('date', { ascending: false })
    .limit(7)
  return { rows: (data ?? []) as BriefRow[], error: error?.message ?? null }
}

function priorityClass(p: string) {
  if (p === 'high') return 'border-red-300 bg-red-50'
  if (p === 'low') return 'border-gray-200 bg-gray-50'
  return 'border-amber-300 bg-amber-50'
}

function priorityLabel(p: string) {
  if (p === 'high') return '🔴 high'
  if (p === 'low') return '⚪ low'
  return '🟡 med'
}

// 매우 단순한 markdown → JSX 변환 (heading / bullet / paragraph)
function renderMarkdown(md: string) {
  const lines = md.split('\n')
  const out: React.ReactNode[] = []
  let bulletBuf: string[] = []
  const flushBullets = () => {
    if (bulletBuf.length > 0) {
      out.push(
        <ul key={`ul-${out.length}`} className="list-disc list-inside space-y-1 text-sm text-gray-800 my-2">
          {bulletBuf.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>,
      )
      bulletBuf = []
    }
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (/^#\s+/.test(line)) {
      flushBullets()
      out.push(
        <h2 key={`h-${out.length}`} className="text-xl font-bold text-gray-900 mt-4 mb-2">
          {line.replace(/^#\s+/, '')}
        </h2>,
      )
    } else if (/^##\s+/.test(line)) {
      flushBullets()
      out.push(
        <h3 key={`h-${out.length}`} className="text-base font-semibold text-gray-800 mt-3 mb-1">
          {line.replace(/^##\s+/, '')}
        </h3>,
      )
    } else if (/^\s*[-*]\s+/.test(line)) {
      bulletBuf.push(line.replace(/^\s*[-*]\s+/, ''))
    } else if (line.trim() === '') {
      flushBullets()
    } else {
      flushBullets()
      out.push(
        <p key={`p-${out.length}`} className="text-sm text-gray-800 my-1.5 whitespace-pre-wrap">
          {line}
        </p>,
      )
    }
  }
  flushBullets()
  return out
}

export default async function BriefPage() {
  const { rows, error } = await fetchBriefs()

  if (error) {
    return (
      <div className="space-y-4 p-6">
        <h1 className="text-2xl font-bold">오늘의 브리프</h1>
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <p className="font-semibold">테이블 로드 실패</p>
          <p className="mt-1 font-mono text-xs">{error}</p>
          <p className="mt-2">
            <code className="bg-white px-1 rounded">supabase/trends_v4_daily_brief.sql</code> 가
            적용되었는지 확인하세요.
          </p>
        </div>
      </div>
    )
  }

  const latest = rows[0]
  const history = rows.slice(1)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">📰 오늘의 브리프</h1>
          <p className="text-sm text-gray-500 mt-1">
            매일 06:30 KST · 6종 시그널(가속도·ggsan·KCA·TV·다소스·가격절벽) 한 페이지 다이제스트
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          전체 보드 →
        </Link>
      </header>

      {!latest ? (
        <EmptyState />
      ) : (
        <>
          <LatestBrief brief={latest} />

          {history.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-gray-700 mb-2">최근 7일</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
                {history.map((h) => (
                  <HistoryCard key={h.date} brief={h} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function LatestBrief({ brief }: { brief: BriefRow }) {
  const actions: ActionItem[] = Array.isArray(brief.action_items)
    ? (brief.action_items as ActionItem[])
    : []

  return (
    <>
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3 pb-3 border-b border-gray-100">
          <div className="flex items-baseline gap-3">
            <span className="text-sm font-mono text-gray-500">{brief.date}</span>
            <StatusBadge status={brief.status} />
          </div>
          <div className="text-xs text-gray-400">
            {brief.model} · tokens {brief.input_token_count}/{brief.output_token_count} ·{' '}
            {new Date(brief.generated_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false })}
          </div>
        </div>

        <div className="prose prose-sm max-w-none">{renderMarkdown(brief.brief_md)}</div>

        {brief.notes && (
          <p className="mt-3 text-xs text-amber-700 bg-amber-50 px-2 py-1 rounded">
            ⚠️ {brief.notes}
          </p>
        )}
      </section>

      {actions.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">
            ⚡ 액션 아이템 ({actions.length})
          </h2>
          <div className="space-y-2">
            {actions.map((a, i) => (
              <div
                key={i}
                className={`flex items-start justify-between gap-3 rounded border px-3 py-2 ${priorityClass(a.priority)}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-mono text-gray-500">{i + 1}</span>
                    <span className="text-xs">{priorityLabel(a.priority)}</span>
                    <span className="text-sm font-medium text-gray-900">{a.label}</span>
                  </div>
                  {a.reason && (
                    <p className="text-xs text-gray-600 mt-0.5 ml-7">근거: {a.reason}</p>
                  )}
                </div>
                {a.link && (
                  <Link
                    href={a.link}
                    className="text-xs text-blue-600 hover:text-blue-800 underline whitespace-nowrap shrink-0"
                  >
                    이동 →
                  </Link>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {Array.isArray(brief.source_links) && brief.source_links.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">참조 링크</h2>
          <div className="flex flex-wrap gap-2">
            {(brief.source_links as Array<{ label: string; link: string; kind: string }>).map(
              (l, i) => (
                <Link
                  key={i}
                  href={l.link}
                  className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-gray-50 text-gray-700"
                >
                  <span className="text-gray-400 mr-1">[{l.kind}]</span>
                  {l.label.slice(0, 40)}
                </Link>
              ),
            )}
          </div>
        </section>
      )}
    </>
  )
}

function HistoryCard({ brief }: { brief: BriefRow }) {
  const actionCount = Array.isArray(brief.action_items) ? brief.action_items.length : 0
  return (
    <div className="rounded border border-gray-200 p-2 hover:bg-gray-50">
      <div className="text-xs font-mono text-gray-500">{brief.date}</div>
      <div className="text-xs text-gray-600 mt-1">{actionCount} 액션</div>
      <div className="mt-1">
        <StatusBadge status={brief.status} compact />
      </div>
    </div>
  )
}

function StatusBadge({ status, compact = false }: { status: string; compact?: boolean }) {
  const cls =
    status === 'ok'
      ? 'bg-green-100 text-green-700'
      : status === 'fallback'
        ? 'bg-amber-100 text-amber-700'
        : status === 'empty'
          ? 'bg-gray-100 text-gray-600'
          : 'bg-red-100 text-red-700'
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${cls} ${compact ? '' : 'uppercase'}`}>
      {status}
    </span>
  )
}

function EmptyState() {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
      <p className="text-base font-medium">아직 생성된 브리프가 없습니다</p>
      <p className="text-sm mt-2">
        매일 KST 06:30 에 <code className="px-1 bg-gray-100 rounded">scripts/generate-daily-brief.mjs</code>{' '}
        가 자동 생성합니다.
      </p>
      <p className="text-xs mt-4 text-gray-400">
        수동 생성: <code className="px-1 bg-gray-100 rounded">node --env-file=.env.local scripts/generate-daily-brief.mjs --force</code>
      </p>
    </div>
  )
}
