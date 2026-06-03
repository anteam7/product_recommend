import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { NEWS_TOPICS, URGENCY_RANK, type NewsTopic } from './rules'

export const dynamic = 'force-dynamic'

// 뉴스가 적재되는 source — daum_news 는 단일 run 351건으로 모든 소스 중 최대 적재량이나
// 현재 발굴 점수 기여 0. 가장 큰 사장된 데이터를 돌발 수요 토픽으로 번역한다.
const NEWS_SOURCES = ['naver_news', 'daum_news']
// 수요측 교차판정 — 검색(trends_keywords) vs 커뮤니티(clien_park) 가 '이미 시작(lag)'인지 판정
const COMMUNITY_SOURCES = ['clien_park', 'quasarzone_sale']

interface RawRow {
  title: string | null
  source: string
  source_url: string | null
  captured_at: string
  metadata: Record<string, unknown> | null
}

interface TopicResult {
  topic: NewsTopic
  newsCount: number
  lastNewsAt: string
  sampleHeadlines: { title: string; url: string | null }[]
  searchHits: number
  communityHits: number
  demandPhase: 'lead' | 'lag' | 'unknown'
  urgencyScore: number
}

function textOf(r: RawRow): string {
  const desc = r.metadata && typeof r.metadata['description'] === 'string' ? (r.metadata['description'] as string) : ''
  return `${r.title ?? ''} ${desc}`.toLowerCase()
}

function matchesAny(haystack: string, needles: string[]): boolean {
  for (const n of needles) {
    if (haystack.includes(n.toLowerCase())) return true
  }
  return false
}

async function fetchBoard(): Promise<{ results: TopicResult[]; totalNews: number; error: string | null }> {
  const sb = createAdminClient()
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [news, search, community] = await Promise.all([
    sb
      .from('jimscanner_market_raw')
      .select('title, source, source_url, captured_at, metadata')
      .in('source', NEWS_SOURCES)
      .gte('captured_at', since7d)
      .order('captured_at', { ascending: false })
      .limit(2000),
    sb
      .from('jimscanner_trends_keywords')
      .select('keyword, collected_at')
      .gte('collected_at', since7d)
      .limit(3000),
    sb
      .from('jimscanner_market_raw')
      .select('title, metadata, captured_at')
      .in('source', COMMUNITY_SOURCES)
      .gte('captured_at', since7d)
      .limit(2000),
  ])

  if (news.error) return { results: [], totalNews: 0, error: news.error.message }

  const newsRows = (news.data ?? []) as RawRow[]
  const searchRows = (search.data ?? []) as { keyword: string | null; collected_at: string }[]
  const communityRows = (community.data ?? []) as { title: string | null; metadata: Record<string, unknown> | null }[]

  const searchBlob = searchRows.map((s) => (s.keyword ?? '').toLowerCase())
  const communityBlob = communityRows.map((c) => {
    const desc = c.metadata && typeof c.metadata['description'] === 'string' ? (c.metadata['description'] as string) : ''
    return `${c.title ?? ''} ${desc}`.toLowerCase()
  })

  const results: TopicResult[] = []

  for (const topic of NEWS_TOPICS) {
    const matched = newsRows.filter((r) => matchesAny(textOf(r), topic.newsKeywords))
    if (matched.length === 0) continue

    const lastNewsAt = matched[0].captured_at // 이미 내림차순
    const sampleHeadlines = matched.slice(0, 4).map((r) => ({ title: r.title ?? '(제목 없음)', url: r.source_url }))

    // 수요측 반응 — 검색 키워드 / 커뮤니티 글에서 demandKeyword 매칭 카운트
    const searchHits = searchBlob.filter((kw) => matchesAny(kw, topic.demandKeywords)).length
    const communityHits = communityBlob.filter((c) => matchesAny(c, topic.demandKeywords)).length

    // lead/lag 교차판정: 수요측 반응이 거의 없으면 아직 잠잠(lead=선점 골든타임),
    // 이미 검색·커뮤니티에 번졌으면 lag(이미 시작).
    const demandSignal = searchHits + communityHits
    const demandPhase: TopicResult['demandPhase'] =
      demandSignal === 0 ? 'lead' : demandSignal >= 3 ? 'lag' : 'unknown'

    // 긴급도 점수: 기본 urgency + 최근성 + lead 가산(선점 가치) + 뉴스 볼륨
    const ageHours = (Date.now() - new Date(lastNewsAt).getTime()) / 3_600_000
    const recencyBoost = ageHours < 24 ? 2 : ageHours < 72 ? 1 : 0
    const baseScore = 10 - URGENCY_RANK[topic.baseUrgency] * 3
    const leadBoost = demandPhase === 'lead' ? 3 : demandPhase === 'unknown' ? 1 : 0
    const volumeBoost = Math.min(2, Math.floor(matched.length / 5))
    const urgencyScore = baseScore + recencyBoost + leadBoost + volumeBoost

    results.push({
      topic,
      newsCount: matched.length,
      lastNewsAt,
      sampleHeadlines,
      searchHits,
      communityHits,
      demandPhase,
      urgencyScore,
    })
  }

  results.sort((a, b) => b.urgencyScore - a.urgencyScore)
  return { results, totalNews: newsRows.length, error: null }
}

function formatAge(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 60) return `${min}분 전`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}시간 전`
  return `${Math.floor(h / 24)}일 전`
}

const PHASE_META: Record<TopicResult['demandPhase'], { label: string; cls: string; hint: string }> = {
  lead: {
    label: '🟢 LEAD · 선점 골든타임',
    cls: 'bg-green-100 text-green-800 border-green-300',
    hint: '뉴스는 떴지만 검색·커뮤니티는 아직 잠잠 — 위탁 선점 적기',
  },
  unknown: {
    label: '🟡 번지는 중',
    cls: 'bg-yellow-100 text-yellow-800 border-yellow-300',
    hint: '수요 반응 초기 — 빠르게 확보',
  },
  lag: {
    label: '🔴 LAG · 이미 시작',
    cls: 'bg-red-100 text-red-700 border-red-300',
    hint: '이미 검색·커뮤니티로 번짐 — 경쟁 심화, 마진 압박',
  },
}

const URGENCY_BADGE: Record<string, string> = {
  critical: 'bg-red-600 text-white',
  high: 'bg-orange-500 text-white',
  watch: 'bg-gray-400 text-white',
}

export default async function NewsDemandPage() {
  const { results, totalNews, error } = await fetchBoard()

  const leadCount = results.filter((r) => r.demandPhase === 'lead').length
  const criticalCount = results.filter((r) => r.topic.baseUrgency === 'critical').length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">📰 뉴스 → 수요 선점 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            돌발 뉴스(한파·미세먼지·리콜·품귀·정책)를 상품 수요로 번역 — 검색·커뮤니티로 번지기 전 위탁 선점
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-indigo-200 bg-indigo-50 px-4 py-3 text-xs text-indigo-900">
        <strong>왜 뉴스인가</strong> · daum_news/naver_news 는 run당 최대 적재량이지만 발굴 점수 기여 0에 가까운{' '}
        <strong>가장 큰 사장된 데이터</strong>. 돌발 뉴스는 고정 캘린더로 못 잡는 예측불가·단기폭발 수요를 만든다.
        뉴스가 검색·커뮤니티로 번지기 <strong>전(lead)</strong>이 위탁 선점 골든타임.
        <span className="block mt-1 text-indigo-700">
          현재 rule 기반 추출(MVP). market_signals 적재 + LLM 토픽 추출은 후속 Phase — supabase/news_demand.sql 참조.
        </span>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="활성 토픽" value={results.length} />
        <Kpi label="🟢 LEAD (선점 적기)" value={leadCount} highlight={leadCount > 0} />
        <Kpi label="🔴 critical 토픽" value={criticalCount} />
        <Kpi label="분석 뉴스 (7일)" value={totalNews} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          조회 에러: <code className="font-mono text-xs">{error}</code>
        </div>
      )}

      {!error && results.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">활성 돌발 수요 토픽 없음</div>
          <div className="text-xs text-gray-400">
            최근 7일 뉴스에서 한파·폭염·미세먼지·감염병·리콜·품귀·정책 키워드가 잡히지 않음.
            <br />
            naver_news / daum_news 수집이 도는지 소스 헬스에서 확인.
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {results.map((r) => {
            const phase = PHASE_META[r.demandPhase]
            return (
              <div
                key={r.topic.key}
                className={`rounded border p-4 ${
                  r.demandPhase === 'lead' ? 'border-green-200 bg-green-50/30' : 'border-gray-200'
                }`}
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[10px] px-2 py-0.5 rounded font-semibold ${URGENCY_BADGE[r.topic.baseUrgency]}`}>
                      {r.topic.baseUrgency.toUpperCase()}
                    </span>
                    <span className="text-base font-bold">{r.topic.label}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-mono">
                      {r.topic.signalType}
                    </span>
                    <span className={`text-[11px] px-2 py-0.5 rounded border ${phase.cls}`} title={phase.hint}>
                      {phase.label}
                    </span>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-bold font-mono text-indigo-700">{r.urgencyScore}</div>
                    <div className="text-[10px] text-gray-400">긴급도</div>
                  </div>
                </div>

                {r.topic.note && <p className="text-xs text-gray-500 mt-2">{r.topic.note}</p>}

                {/* 수요 번역 */}
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-gray-400">영향 카테고리</span>
                  {r.topic.impactedCategories.map((c) => (
                    <span key={c} className="bg-indigo-100 text-indigo-800 px-2 py-0.5 rounded">
                      {c}
                    </span>
                  ))}
                </div>

                {/* 교차판정 + 뉴스 볼륨 */}
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-600">
                  <span>📰 뉴스 {r.newsCount}건 · 최근 {formatAge(r.lastNewsAt)}</span>
                  <span>🔍 검색반응 {r.searchHits}</span>
                  <span>💬 커뮤니티반응 {r.communityHits}</span>
                </div>

                {/* 헤드라인 샘플 */}
                <ul className="mt-2 space-y-0.5">
                  {r.sampleHeadlines.map((h, i) => (
                    <li key={i} className="text-xs text-gray-500 truncate">
                      {h.url ? (
                        <a href={h.url} target="_blank" rel="noopener" className="hover:text-indigo-700 hover:underline">
                          · {h.title}
                        </a>
                      ) : (
                        <span>· {h.title}</span>
                      )}
                    </li>
                  ))}
                </ul>

                {/* ggsan 소싱 후보 점프 */}
                <div className="mt-3 flex flex-wrap gap-2">
                  {r.topic.ggsanCateCodes.length > 0 ? (
                    r.topic.ggsanCateCodes.map((code) => (
                      <Link
                        key={code}
                        href={`/admin/trend-radar/recommend?cate=${code}`}
                        className="text-xs bg-black text-white px-3 py-1 rounded hover:bg-gray-800"
                      >
                        🔗 ggsan 후보 보기 ({code})
                      </Link>
                    ))
                  ) : (
                    <span className="text-[11px] text-gray-400 px-2 py-1">
                      ggsan 카테고리 매핑 미지정 — 일반 소싱 탐색 필요
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 긴급도 / lead·lag 판정식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          demand_phase = (검색+커뮤니티 반응 == 0) ? LEAD(선점) : (≥3) ? LAG(이미 시작) : 번지는 중
          <br />
          긴급도 = baseUrgency(critical10/high7/watch4) + 최근성(≤24h:+2) + lead가산(+3) + 뉴스볼륨(최대+2)
        </code>
        <div className="pt-1 text-gray-400">
          후속 Phase: 뉴스 원문 LLM 토픽 추출 → market_signals(signal_type=topic/gov_notice) 적재 ·
          recommend RPC 에 news_topic_boost 결합 (supabase/news_demand.sql).
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-green-300 bg-green-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-green-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
