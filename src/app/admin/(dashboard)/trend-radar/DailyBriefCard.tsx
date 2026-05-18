import Link from 'next/link'

interface ActionItem {
  title: string
  why?: string
  link: string
}

interface BriefRow {
  brief_date: string
  summary_md: string
  actions: ActionItem[] | unknown
  model?: string | null
  created_at?: string
}

export default function DailyBriefCard({ brief }: { brief: BriefRow | null }) {
  if (!brief) {
    return (
      <section className="rounded border border-dashed border-gray-300 bg-gray-50 p-6">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-gray-700">📰 Daily Brief</h2>
          <Link
            href="/admin/trend-radar/daily-brief"
            className="text-xs text-gray-500 hover:text-black underline"
          >
            과거 brief →
          </Link>
        </div>
        <p className="text-sm text-gray-500 mt-3">
          오늘 자 브리핑이 아직 생성되지 않았습니다. 매일 새벽 5시 후 cron 이 자동 생성합니다.
        </p>
      </section>
    )
  }

  const actions: ActionItem[] = Array.isArray(brief.actions)
    ? (brief.actions as ActionItem[]).filter(
        (a) => a && typeof a.title === 'string' && typeof a.link === 'string',
      )
    : []

  return (
    <section className="rounded border border-gray-900 bg-white p-5 shadow-sm">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-base font-bold">📰 Daily Brief · {brief.brief_date}</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            매일 새벽 자동 생성 · 오늘 무엇을 먼저 봐야 하는지
          </p>
        </div>
        <Link
          href="/admin/trend-radar/daily-brief"
          className="text-xs text-gray-600 hover:text-black underline"
        >
          타임라인 →
        </Link>
      </div>

      <div className="mt-4 text-sm leading-relaxed whitespace-pre-wrap text-gray-800">
        {brief.summary_md}
      </div>

      {actions.length > 0 && (
        <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-3">
          {actions.map((a, i) => (
            <Link
              key={`${a.link}-${i}`}
              href={a.link}
              className="rounded border border-gray-200 bg-gray-50 hover:bg-gray-900 hover:text-white transition-colors p-3 block"
            >
              <div className="text-xs text-gray-400 group-hover:text-gray-200">Top {i + 1}</div>
              <div className="text-sm font-semibold mt-1">{a.title}</div>
              {a.why && (
                <div className="text-xs text-gray-500 mt-1.5 line-clamp-2">{a.why}</div>
              )}
            </Link>
          ))}
        </div>
      )}
    </section>
  )
}
