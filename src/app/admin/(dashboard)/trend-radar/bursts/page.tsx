import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

const TYPES = ['all', 'news_driven', 'deal_driven', 'viral_blog', 'unexplained'] as const
type BurstType = (typeof TYPES)[number]

const TYPE_LABEL: Record<BurstType, string> = {
  all: '전체',
  news_driven: '📰 news_driven',
  deal_driven: '🏷 deal_driven',
  viral_blog: '✍️ viral_blog',
  unexplained: '❓ unexplained',
}

const TYPE_HINT: Record<Exclude<BurstType, 'all'>, string> = {
  news_driven: '뉴스 노출 → 며칠 내 사그라들 가능성. 등록 신중.',
  deal_driven: '특가 캘린더 매칭 → 차익 윈도우. 즉시 등록 후보.',
  viral_blog: '블로그 바이럴 → 단기 트래픽. 키워드 SEO 후보.',
  unexplained: '외부 원인 없음 → 진짜 organic 수요. 우선 발굴 후보.',
}

const TYPE_BADGE: Record<Exclude<BurstType, 'all'>, string> = {
  news_driven: 'bg-blue-100 text-blue-700 border-blue-200',
  deal_driven: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  viral_blog: 'bg-purple-100 text-purple-700 border-purple-200',
  unexplained: 'bg-amber-100 text-amber-700 border-amber-200',
}

const DAYS_OPTIONS = [
  { v: 3, label: '3일' },
  { v: 7, label: '7일 (기본)' },
  { v: 14, label: '14일' },
  { v: 30, label: '30일' },
] as const

interface CausePayload {
  id: string
  source: string
  title: string | null
  source_url: string | null
  captured_at: string
  score: number
}

interface BurstRow {
  id: string
  keyword: string
  source: string | null
  cluster_id: string | null
  burst_date: string
  detected_at: string
  baseline_mean: number | null
  latest_volume: number | null
  z_score: number | null
  spike_ratio: number | null
  burst_type: string
  top_cause_score: number | null
  cause_sources: Record<string, number>
  top_cause_payload: CausePayload[]
}

async function fetchBursts(days: number, type: BurstType) {
  const sb = createAdminClient()
  const since = new Date(Date.now() - days * 86400_000).toISOString()
  let q = sb
    .from('jimscanner_trends_bursts' as never)
    .select(
      'id, keyword, source, cluster_id, burst_date, detected_at, baseline_mean, latest_volume, z_score, spike_ratio, burst_type, top_cause_score, cause_sources, top_cause_payload',
    )
    .gte('detected_at', since)
    .order('detected_at', { ascending: false })
    .order('z_score', { ascending: false })
    .limit(500)
  if (type !== 'all') q = q.eq('burst_type' as never, type)
  const { data, error } = await q
  if (error) return { rows: [] as BurstRow[], error: error.message }
  return { rows: (data ?? []) as unknown as BurstRow[], error: null as string | null }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>) {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/bursts' + (qs ? `?${qs}` : '')
}

function sourceLabel(s: string) {
  switch (s) {
    case 'naver_news':
      return '📰 뉴스'
    case 'naver_blog':
      return '✍️ 블로그'
    case 'quasarzone_sale':
      return '🏷 특가'
    default:
      return s
  }
}

export default async function BurstsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; type?: string }>
}) {
  const sp = await searchParams
  const daysParsed = parseInt(sp.days ?? '7', 10)
  const days = DAYS_OPTIONS.some((d) => d.v === daysParsed) ? daysParsed : 7
  const type = (TYPES.includes(sp.type as BurstType) ? sp.type : 'all') as BurstType

  const current: Record<string, string> = {
    days: String(days),
    type,
  }

  const { rows, error } = await fetchBursts(days, type)

  // 타입별 카운트 (전체 days 기준)
  const { rows: allRows } = type === 'all' ? { rows } : await fetchBursts(days, 'all')
  const typeCounts: Record<string, number> = {}
  for (const r of allRows) typeCounts[r.burst_type] = (typeCounts[r.burst_type] ?? 0) + 1

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">급등 키워드 원인 자동주석</h1>
          <p className="text-sm text-gray-500 mt-1">
            28일 baseline 대비 Z &gt; 2.5 인 일일 burst · 72h 윈도우 market_raw 매칭 원인 후보
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* KPI: 타입별 분포 */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(['news_driven', 'deal_driven', 'viral_blog', 'unexplained'] as const).map((t) => (
          <Link
            key={t}
            href={buildHref(current, { type: t === type ? null : t })}
            className={`rounded border p-3 transition-colors ${
              type === t
                ? TYPE_BADGE[t] + ' ring-2 ring-offset-1 ring-current'
                : 'border-gray-200 hover:bg-gray-50'
            }`}
          >
            <div className="text-xs text-gray-500">{TYPE_LABEL[t]}</div>
            <div className="text-2xl font-bold mt-1">{typeCounts[t] ?? 0}</div>
            <div className="text-[11px] text-gray-500 mt-1 leading-tight">{TYPE_HINT[t]}</div>
          </Link>
        ))}
      </section>

      {/* 필터 */}
      <div className="flex items-center gap-3 flex-wrap text-sm">
        <span className="text-gray-500">기간:</span>
        {DAYS_OPTIONS.map((d) => (
          <Link
            key={d.v}
            href={buildHref(current, { days: String(d.v) })}
            className={`px-2 py-1 rounded ${
              days === d.v ? 'bg-black text-white' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
            }`}
          >
            {d.label}
          </Link>
        ))}
        <span className="text-gray-300">|</span>
        <Link
          href={buildHref(current, { type: null })}
          className={`px-2 py-1 rounded ${
            type === 'all' ? 'bg-black text-white' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
          }`}
        >
          전체 타입
        </Link>
        <span className="text-gray-400 text-xs ml-auto">총 {rows.length}건</span>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          ⚠️ {error}
          <div className="text-xs mt-1 text-red-600">
            마이그레이션 미적용일 수 있음:{' '}
            <code className="bg-red-100 px-1 rounded">supabase/trends_burst_attribution.sql</code>
          </div>
        </div>
      )}

      {/* burst 카드 리스트 */}
      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">표시할 burst 가 없습니다</p>
          <p className="text-sm mt-2">
            매일 KST 04:30 detect-trend-bursts cron 이 누적된 시계열에서 Z &gt; 2.5 burst 를 산출합니다.
          </p>
          <p className="text-xs mt-4 text-gray-400">
            수동 실행:{' '}
            <code className="ml-1 px-1 bg-gray-100 rounded">
              node --env-file=.env.local scripts/detect-trend-bursts.mjs
            </code>
          </p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {rows.map((r) => (
            <BurstCard key={r.id} r={r} />
          ))}
        </div>
      )}
    </div>
  )
}

function BurstCard({ r }: { r: BurstRow }) {
  const type = (r.burst_type as Exclude<BurstType, 'all'>) ?? 'unexplained'
  const badgeCls = TYPE_BADGE[type] ?? 'bg-gray-100 text-gray-700 border-gray-200'
  const spike = r.spike_ratio ?? 0
  const z = r.z_score ?? 0
  const sources = r.cause_sources ?? {}
  const causes = r.top_cause_payload ?? []

  return (
    <div className="rounded border border-gray-200 p-4 bg-white">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-bold truncate">{r.keyword}</h3>
            <span className={`text-[11px] px-2 py-0.5 rounded border ${badgeCls}`}>
              {TYPE_LABEL[type]}
            </span>
          </div>
          <div className="text-xs text-gray-500 mt-1">
            burst {r.burst_date} · {r.source ?? '?'}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-xs text-gray-500">spike</div>
          <div className="text-xl font-mono font-bold">{spike.toFixed(1)}×</div>
          <div className="text-[11px] text-gray-400">z={z.toFixed(2)}</div>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 flex-wrap text-[11px]">
        <span className="text-gray-500">매칭 분포:</span>
        {Object.keys(sources).length === 0 ? (
          <span className="text-gray-400">없음</span>
        ) : (
          Object.entries(sources)
            .sort((a, b) => b[1] - a[1])
            .map(([src, n]) => (
              <span key={src} className="px-2 py-0.5 rounded bg-gray-100 text-gray-700">
                {sourceLabel(src)} {n}
              </span>
            ))
        )}
      </div>

      {causes.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {causes.map((c, i) => (
            <li key={c.id} className="text-sm">
              <div className="flex items-baseline gap-2">
                <span className="text-[11px] font-mono text-gray-400">{i + 1}.</span>
                <span className="text-[11px] text-gray-500 shrink-0">{sourceLabel(c.source)}</span>
                {c.source_url ? (
                  <a
                    href={c.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-700 hover:underline truncate"
                  >
                    {c.title ?? c.source_url}
                  </a>
                ) : (
                  <span className="truncate">{c.title ?? '(제목 없음)'}</span>
                )}
              </div>
              <div className="text-[11px] text-gray-400 ml-6">
                {c.captured_at.slice(0, 16).replace('T', ' ')} · score {c.score.toFixed(2)}
              </div>
            </li>
          ))}
        </ul>
      )}

      {causes.length === 0 && (
        <div className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
          72h 윈도우 내 외부 원인 없음 — organic 가능성, 우선 발굴 후보
        </div>
      )}
    </div>
  )
}
