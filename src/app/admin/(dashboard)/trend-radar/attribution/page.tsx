import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { setSpikeVerdict } from './actions'

export const dynamic = 'force-dynamic'

interface AttributionRow {
  id: string
  keyword: string
  spike_at: string
  spike_score: number | null
  spike_ratio: number | null
  candidate_source: string
  candidate_url: string | null
  candidate_title: string
  candidate_published_at: string | null
  score: number
  reasoning: string | null
  matched_at: string
  verdict: 'reproducible' | 'one_off' | 'noise' | null
}

interface SpikeBucket {
  keyword: string
  spike_at: string
  spike_score: number | null
  spike_ratio: number | null
  cards: AttributionRow[]
  topScore: number
  verdictSummary: { reproducible: number; one_off: number; noise: number; pending: number }
}

const SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  naver_tvtime: { label: 'TV', cls: 'bg-violet-100 text-violet-700' },
  naver_news: { label: 'NEWS', cls: 'bg-blue-100 text-blue-700' },
  daum_news: { label: 'NEWS', cls: 'bg-blue-100 text-blue-700' },
  '82cook': { label: '82cook', cls: 'bg-pink-100 text-pink-700' },
  natepan: { label: 'natepan', cls: 'bg-orange-100 text-orange-700' },
  dcinside: { label: 'DC', cls: 'bg-teal-100 text-teal-700' },
  ppomppu: { label: 'ppomppu', cls: 'bg-amber-100 text-amber-700' },
}

async function fetchData(): Promise<SpikeBucket[]> {
  const sb = createAdminClient()
  const since = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString()

  // 새 테이블 — types 미반영. `as any` 캐스팅.
  const { data, error } = await (
    sb.from('jimscanner_trends_spike_attribution' as never) as never as ReturnType<typeof sb.from>
  )
    .select(
      'id, keyword, spike_at, spike_score, spike_ratio, candidate_source, candidate_url, candidate_title, candidate_published_at, score, reasoning, matched_at, verdict',
    )
    .gte('spike_at', since)
    .order('spike_at', { ascending: false })
    .order('score', { ascending: false })
    .limit(500)

  if (error || !data) return []

  const rows = data as unknown as AttributionRow[]
  const map = new Map<string, SpikeBucket>()
  for (const r of rows) {
    const key = `${r.keyword}::${r.spike_at}`
    let bucket = map.get(key)
    if (!bucket) {
      bucket = {
        keyword: r.keyword,
        spike_at: r.spike_at,
        spike_score: r.spike_score,
        spike_ratio: r.spike_ratio,
        cards: [],
        topScore: 0,
        verdictSummary: { reproducible: 0, one_off: 0, noise: 0, pending: 0 },
      }
      map.set(key, bucket)
    }
    bucket.cards.push(r)
    if (r.score > bucket.topScore) bucket.topScore = r.score
    if (r.verdict === 'reproducible') bucket.verdictSummary.reproducible++
    else if (r.verdict === 'one_off') bucket.verdictSummary.one_off++
    else if (r.verdict === 'noise') bucket.verdictSummary.noise++
    else bucket.verdictSummary.pending++
  }

  return Array.from(map.values()).sort(
    (a, b) => new Date(b.spike_at).getTime() - new Date(a.spike_at).getTime(),
  )
}

function ageLabel(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 60) return `${m}m 전`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h 전`
  return `${Math.floor(h / 24)}d 전`
}

function scoreColor(score: number): string {
  if (score >= 0.7) return 'text-green-700 bg-green-50 border-green-200'
  if (score >= 0.4) return 'text-yellow-700 bg-yellow-50 border-yellow-200'
  return 'text-gray-600 bg-gray-50 border-gray-200'
}

function patternLabel(b: SpikeBucket): { text: string; cls: string } {
  const total =
    b.verdictSummary.reproducible + b.verdictSummary.one_off + b.verdictSummary.noise
  if (total === 0) return { text: '미분류', cls: 'bg-gray-100 text-gray-500' }
  if (b.verdictSummary.reproducible > b.verdictSummary.one_off)
    return { text: '재현형 ★', cls: 'bg-emerald-100 text-emerald-800' }
  if (b.verdictSummary.one_off > 0)
    return { text: '일회성', cls: 'bg-rose-100 text-rose-700' }
  return { text: '노이즈', cls: 'bg-gray-200 text-gray-600' }
}

export default async function AttributionPage() {
  const buckets = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Spike Attribution Board</h1>
          <p className="text-sm text-gray-500 mt-1">
            키워드 급등의 외부 트리거 (TV·뉴스·커뮤니티) 자동 매칭. spike 마다 운영자가
            <span className="font-medium text-emerald-700"> 재현 가능</span> /
            <span className="font-medium text-rose-700"> 일회성</span> /
            <span className="font-medium text-gray-500"> 노이즈</span> 라벨.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {buckets.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">최근 14일 spike attribution 데이터 없음</p>
          <p className="text-sm mt-2 font-mono">
            node --env-file=.env.local scripts/spike-attribution.mjs
          </p>
          <p className="text-xs mt-2">
            (테이블 마이그레이션: <code>supabase/spike_attribution.sql</code>)
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {buckets.map((b) => {
            const label = patternLabel(b)
            return (
              <section key={`${b.keyword}::${b.spike_at}`} className="rounded border border-gray-200">
                <header className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-baseline justify-between flex-wrap gap-2">
                  <div className="flex items-baseline gap-3">
                    <h2 className="text-lg font-bold">{b.keyword}</h2>
                    <span className="text-xs text-gray-500 font-mono">
                      {b.spike_at.slice(0, 16)} · {ageLabel(b.spike_at)}
                    </span>
                    {b.spike_ratio != null && (
                      <span className="text-xs text-gray-600">
                        baseline 대비 {b.spike_ratio.toFixed(2)}×
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-2 py-1 rounded font-medium ${label.cls}`}>
                      {label.text}
                    </span>
                    <span className="text-xs text-gray-500">
                      top {(b.topScore * 100).toFixed(0)}% · 후보 {b.cards.length}건
                    </span>
                  </div>
                </header>

                <div className="divide-y divide-gray-100">
                  {b.cards.map((c) => {
                    const badge = SOURCE_BADGE[c.candidate_source] ?? {
                      label: c.candidate_source,
                      cls: 'bg-gray-100 text-gray-700',
                    }
                    const scoreCls = scoreColor(c.score)
                    return (
                      <div key={c.id} className="px-4 py-3 grid grid-cols-12 gap-3 items-center text-sm">
                        <div className="col-span-1">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${badge.cls}`}>
                            {badge.label}
                          </span>
                        </div>
                        <div className="col-span-6">
                          {c.candidate_url ? (
                            <a
                              href={c.candidate_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-medium text-blue-700 hover:underline line-clamp-2"
                            >
                              {c.candidate_title}
                            </a>
                          ) : (
                            <div className="font-medium text-gray-800 line-clamp-2">
                              {c.candidate_title}
                            </div>
                          )}
                          {c.reasoning && (
                            <div className="text-xs text-gray-500 mt-0.5">↪ {c.reasoning}</div>
                          )}
                        </div>
                        <div className="col-span-1 text-right">
                          <span className={`text-xs font-mono px-2 py-1 border rounded ${scoreCls}`}>
                            {(c.score * 100).toFixed(0)}
                          </span>
                        </div>
                        <div className="col-span-1 text-xs text-gray-500 text-right">
                          {c.candidate_published_at ? ageLabel(c.candidate_published_at) : '—'}
                        </div>
                        <div className="col-span-3">
                          <VerdictForm
                            id={c.id}
                            current={c.verdict}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </section>
            )
          })}
        </div>
      )}

      <section className="rounded border border-dashed border-gray-300 p-4 text-xs text-gray-500 leading-relaxed">
        <strong className="text-gray-700">동작:</strong> jimscanner_trends_keywords 의 최근 7일
        시계열에서 키워드별 p90 + baseline 대비 1.8× 이상 spike 를 탐지 → spike 직전 24~72h 안의
        market_raw (TV·뉴스·커뮤니티) 후보를 keyword ILIKE 매칭 → claude CLI 로 1:N 매칭 점수.
        <br />
        <strong className="text-gray-700">운영자 액션:</strong> 카드별 verdict (재현 가능/일회성/노이즈)
        를 남기면 향후 출처 가중치 학습 데이터로 사용.
      </section>
    </div>
  )
}

function VerdictForm({
  id,
  current,
}: {
  id: string
  current: 'reproducible' | 'one_off' | 'noise' | null
}) {
  const opts: { value: '' | 'reproducible' | 'one_off' | 'noise'; label: string; cls: string }[] = [
    { value: 'reproducible', label: '재현', cls: 'bg-emerald-600 text-white' },
    { value: 'one_off', label: '일회', cls: 'bg-rose-600 text-white' },
    { value: 'noise', label: '노이즈', cls: 'bg-gray-500 text-white' },
    { value: '', label: '해제', cls: 'bg-white text-gray-500 border border-gray-300' },
  ]
  return (
    <div className="flex gap-1">
      {opts.map((o) => {
        const isCurrent =
          (o.value === '' && current === null) || (o.value !== '' && current === o.value)
        return (
          <form key={o.value || 'clear'} action={setSpikeVerdict}>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="verdict" value={o.value} />
            <button
              type="submit"
              className={`text-[10px] px-2 py-1 rounded font-medium transition ${
                isCurrent ? o.cls + ' ring-2 ring-offset-1 ring-black/30' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {o.label}
            </button>
          </form>
        )
      })}
    </div>
  )
}
