import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import NewsLeadPinButton from './NewsLeadPinButton'

export const dynamic = 'force-dynamic'

interface LagSummaryRow {
  sample_size: number
  p50_lag_days: number | null
  p90_lag_days: number | null
  avg_lag_days: number | null
  max_lag_days: number | null
}

interface CandidateRow {
  keyword: string
  recent_mentions: number
  last_news_day: string
  first_news_day_recent: string
  latest_titles: string[] | null
  search_unseen_30d: boolean
  days_since_news_first: number
  learned_p50_lag: number | null
  preempt_window_open: boolean
  goods_no: string | null
  ggsan_title: string | null
  price_krw: number | null
  is_imminent: boolean | null
  cate_cd: string | null
  cate_label: string | null
  image_url: string | null
  detail_url: string | null
  sim: number | null
}

interface RunRow {
  status: string
  fetched_count: number
  inserted_count: number
  started_at: string
  duration_ms: number | null
  error_message: string | null
}

interface CandidateGroup {
  keyword: string
  recent_mentions: number
  last_news_day: string
  first_news_day_recent: string
  latest_titles: string[]
  search_unseen_30d: boolean
  days_since_news_first: number
  learned_p50_lag: number | null
  preempt_window_open: boolean
  matches: CandidateRow[]
}

async function fetchData() {
  // 새 마이그레이션 테이블은 types/supabase.ts 미반영 → as any 캐스팅 사용
  const sb = createAdminClient() as any

  const [lagRes, candRes, runRes, mentionRes] = await Promise.all([
    sb.from('jimscanner_news_lag_summary').select('*').maybeSingle(),
    sb.rpc('jimscanner_news_lead_with_ggsan', {
      result_limit: 50,
      min_sim: 0.2,
      per_keyword_limit: 3,
    }),
    sb
      .from('jimscanner_trends_runs')
      .select('status, fetched_count, inserted_count, started_at, duration_ms, error_message')
      .eq('source', 'news_keyword_extract')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    sb
      .from('jimscanner_news_keyword_mentions')
      .select('keyword', { count: 'exact', head: true }),
  ])

  const lag = (lagRes.data ?? null) as LagSummaryRow | null
  const candidates = ((candRes.data ?? []) as CandidateRow[])
  const lastRun = (runRes.data ?? null) as RunRow | null
  const totalKeywordRows = (mentionRes.count ?? 0) as number

  // keyword 별로 group
  const groupsMap = new Map<string, CandidateGroup>()
  for (const r of candidates) {
    let g = groupsMap.get(r.keyword)
    if (!g) {
      g = {
        keyword: r.keyword,
        recent_mentions: r.recent_mentions,
        last_news_day: r.last_news_day,
        first_news_day_recent: r.first_news_day_recent,
        latest_titles: r.latest_titles ?? [],
        search_unseen_30d: r.search_unseen_30d,
        days_since_news_first: r.days_since_news_first,
        learned_p50_lag: r.learned_p50_lag,
        preempt_window_open: r.preempt_window_open,
        matches: [],
      }
      groupsMap.set(r.keyword, g)
    }
    if (r.goods_no) g.matches.push(r)
  }
  const groups = [...groupsMap.values()].sort((a, b) => {
    if (a.preempt_window_open !== b.preempt_window_open) return a.preempt_window_open ? -1 : 1
    return b.recent_mentions - a.recent_mentions
  })

  return { lag, groups, lastRun, totalKeywordRows }
}

export default async function NewsLeadPage() {
  const { lag, groups, lastRun, totalKeywordRows } = await fetchData()

  const preemptCount = groups.filter((g) => g.preempt_window_open).length
  const withGgsan = groups.filter((g) => g.matches.length > 0).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">📰 뉴스 → 검색 Lead 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            naver_news 본문에서 추출한 키워드 중{' '}
            <strong className="text-red-700">아직 검색 트렌드에 부상하지 않은 선점창</strong>{' '}
            후보. 학습된 lag (P50) 이내면 <span className="text-red-700">선점창 OPEN</span>.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="후보 키워드" value={groups.length} />
        <Kpi label="🔥 선점창 OPEN" value={preemptCount} highlight={preemptCount > 0} />
        <Kpi label="ggsan 매칭됨" value={withGgsan} />
        <Kpi
          label="학습 lag P50"
          value={lag?.p50_lag_days != null ? `${Number(lag.p50_lag_days).toFixed(1)}일` : '학습중'}
        />
        <Kpi
          label="lag P90"
          value={lag?.p90_lag_days != null ? `${Number(lag.p90_lag_days).toFixed(1)}일` : '학습중'}
          hint={lag?.sample_size ? `n=${lag.sample_size}` : undefined}
        />
      </section>

      {/* 운영 상태 */}
      <section className="rounded border border-gray-200 px-4 py-3 text-xs text-gray-600 space-y-1">
        <div>
          <strong>키워드 적재 누적:</strong> {totalKeywordRows.toLocaleString()} row
          {lastRun ? (
            <span className="ml-2">
              · 마지막 extract: <code className="px-1 bg-gray-100 rounded">{lastRun.started_at?.slice(0, 16)}</code>{' '}
              ({lastRun.status} · {lastRun.fetched_count} raw → {lastRun.inserted_count} bucket
              {lastRun.duration_ms ? ` · ${lastRun.duration_ms}ms` : ''})
            </span>
          ) : (
            <span className="ml-2 text-amber-700">
              · extract 아직 미실행 — <code className="px-1 bg-gray-100 rounded">node --env-file=.env.local scripts/news-keyword-extract.mjs</code>
            </span>
          )}
        </div>
        <div className="text-gray-400">
          학습 lag = (검색 트렌드 첫 등장 − 뉴스 첫 등장) 분포의 P50 / P90. 표본이 작으면 기본값 3일 가정.
        </div>
      </section>

      {/* 후보 리스트 */}
      {groups.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <p className="text-base font-medium">아직 후보 없음</p>
          <p className="text-sm">
            추출 스크립트가 충분한 뉴스를 적재해야 burst 후보가 나타납니다.
            <br />
            <code className="px-1 bg-gray-100 rounded mt-2 inline-block">
              node --env-file=.env.local scripts/news-keyword-extract.mjs
            </code>
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.keyword} className="rounded border border-gray-200 overflow-hidden">
              <div
                className={`px-4 py-3 flex items-start justify-between flex-wrap gap-3 ${
                  g.preempt_window_open ? 'bg-red-50' : 'bg-gray-50'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <h3 className="font-semibold text-base">📰 {g.keyword}</h3>
                    {g.preempt_window_open && (
                      <span className="text-xs bg-red-600 text-white px-2 py-0.5 rounded font-semibold">
                        🔥 선점창 OPEN
                      </span>
                    )}
                    {!g.search_unseen_30d && (
                      <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded">
                        검색 이미 부상
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-600 mt-1">
                    뉴스 mention <strong className="font-mono">{g.recent_mentions}</strong>회
                    {' · '}
                    {g.first_news_day_recent.slice(5)}~{g.last_news_day.slice(5)}
                    {' · '}
                    뉴스 첫 등장 후 <strong className="font-mono">{g.days_since_news_first}</strong>일 경과
                    {g.learned_p50_lag != null && (
                      <> (학습 P50 {Number(g.learned_p50_lag).toFixed(1)}일)</>
                    )}
                  </div>
                  {g.latest_titles.length > 0 && (
                    <div className="text-xs text-gray-500 mt-2 space-y-0.5">
                      {g.latest_titles.slice(0, 2).map((t, i) => (
                        <div key={i} className="truncate" title={t}>
                          · {t}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex-shrink-0">
                  <NewsLeadPinButton keyword={g.keyword} />
                </div>
              </div>

              {/* ggsan 매칭 */}
              {g.matches.length === 0 ? (
                <div className="px-4 py-3 text-xs text-gray-400">
                  ggsan 도매몰에 해당 키워드 trgm 매칭 후보 없음 (sim &lt; 0.2).
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {g.matches.map((m) => (
                    <a
                      key={m.goods_no!}
                      href={m.detail_url ?? '#'}
                      target="_blank"
                      rel="noopener"
                      className="flex items-start gap-3 px-4 py-3 hover:bg-amber-50 transition-colors"
                    >
                      <div className="w-16 h-16 bg-gray-100 rounded overflow-hidden flex-shrink-0 relative">
                        {m.image_url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={m.image_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                        )}
                        {m.is_imminent && (
                          <span className="absolute top-0 left-0 bg-red-600 text-white text-[9px] px-1 leading-tight rounded-br">
                            임박
                          </span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium leading-snug line-clamp-2" title={m.ggsan_title ?? ''}>
                          {m.ggsan_title}
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                          {m.cate_label ?? m.cate_cd} · {m.goods_no}
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="text-base font-bold">
                          {m.price_krw
                            ? `${m.price_krw.toLocaleString()}원`
                            : <span className="text-gray-400 text-xs">가격 X</span>}
                        </div>
                        <div className="text-xs font-mono text-gray-400 mt-1">
                          sim {Number(m.sim ?? 0).toFixed(3)}
                        </div>
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div>
          <strong>로직:</strong> 뉴스 mention(최근 7일 누적 ≥2) AND 검색 트렌드 30일 미부상 →{' '}
          P50 lag 이내 = 선점창 OPEN.
        </div>
        <div>
          <strong>참고:</strong> 한국어 토큰화는 형태소 분석기 없이 stopword/조사 strip 기반.
          정밀도 부족분은 LLM batch 후처리로 보강 가능.
        </div>
      </section>
    </div>
  )
}

function Kpi({
  label,
  value,
  highlight = false,
  hint,
}: {
  label: string
  value: number | string
  highlight?: boolean
  hint?: string
}) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-red-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      {hint && <div className="text-[10px] text-gray-400 mt-0.5">{hint}</div>}
    </div>
  )
}
