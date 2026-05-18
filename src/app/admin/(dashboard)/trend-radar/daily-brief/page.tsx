import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface ActionItem {
  title: string
  why?: string
  link: string
}

interface BriefRow {
  brief_date: string
  summary_md: string
  actions: ActionItem[] | unknown
  model: string | null
  prompt_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  created_at: string
}

async function fetchBriefs(): Promise<BriefRow[]> {
  const sb = createAdminClient()
  // 새 jimscanner_daily_briefs — supabase 타입엔 아직 없음 (`as any` 캐스팅).
  const { data } = await (sb.from as unknown as (n: string) => any)('jimscanner_daily_briefs')
    .select('brief_date, summary_md, actions, model, prompt_tokens, output_tokens, cost_usd, created_at')
    .order('brief_date', { ascending: false })
    .limit(60)
  return (data ?? []) as BriefRow[]
}

export default async function DailyBriefTimelinePage() {
  const briefs = await fetchBriefs()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">📰 Daily Brief 타임라인</h1>
          <p className="text-sm text-gray-500 mt-1">
            매일 새벽 자동 생성 · 어제 vs 오늘 변화 + cron 헬스 + 핀 변동 + 큐 적체 → 한국어 요약 + Top 3 액션
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 대시보드
        </Link>
      </header>

      {briefs.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 누적된 brief 가 없습니다</p>
          <p className="text-sm mt-2">
            scripts/run-crons.mjs 가 마지막 단계에서 scripts/daily-brief.mjs 를 spawn 합니다.
            <br />
            처음 실행 후 다음 새벽부터 누적됩니다.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {briefs.map((b) => {
            const actions: ActionItem[] = Array.isArray(b.actions)
              ? (b.actions as ActionItem[]).filter(
                  (a) => a && typeof a.title === 'string' && typeof a.link === 'string',
                )
              : []
            return (
              <article
                key={b.brief_date}
                className="rounded border border-gray-200 bg-white p-5"
              >
                <header className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
                  <h2 className="text-base font-bold">{b.brief_date}</h2>
                  <div className="text-xs text-gray-400 font-mono">
                    {b.model ?? '?'} · in {b.prompt_tokens ?? '-'} / out {b.output_tokens ?? '-'} ·
                    {b.cost_usd != null ? ` $${Number(b.cost_usd).toFixed(4)}` : ' $-'}
                  </div>
                </header>
                <div className="text-sm leading-relaxed whitespace-pre-wrap text-gray-800">
                  {b.summary_md}
                </div>
                {actions.length > 0 && (
                  <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-2">
                    {actions.map((a, i) => (
                      <Link
                        key={`${a.link}-${i}`}
                        href={a.link}
                        className="rounded border border-gray-200 bg-gray-50 hover:bg-gray-900 hover:text-white transition-colors p-3 block text-sm"
                      >
                        <div className="text-xs text-gray-400">Top {i + 1}</div>
                        <div className="font-semibold mt-0.5">{a.title}</div>
                        {a.why && (
                          <div className="text-xs text-gray-500 mt-1 line-clamp-2">{a.why}</div>
                        )}
                      </Link>
                    ))}
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
