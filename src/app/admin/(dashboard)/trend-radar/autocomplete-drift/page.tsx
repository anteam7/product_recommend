import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

type DriftRow = {
  source: string
  seed: string
  suggestion: string
  first_seen_at: string
  latest_at: string
  occurrences: number
  days_since_first_seen: number
  latest_rank: number
  rank_7d_ago: number | null
  rank_delta_7d: number | null
}

async function fetchData() {
  const sb = createAdminClient()

  // 1) 신규: 14일 내 first_seen
  const newQ = await (sb as unknown as {
    from: (n: string) => {
      select: (s: string) => {
        lte: (a: string, b: number) => {
          order: (col: string, opts: { ascending: boolean }) => {
            limit: (n: number) => Promise<{ data: DriftRow[] | null; error: unknown }>
          }
        }
      }
    }
  })
    .from('v_autocomplete_drift')
    .select(
      'source, seed, suggestion, first_seen_at, latest_at, occurrences, days_since_first_seen, latest_rank, rank_7d_ago, rank_delta_7d',
    )
    .lte('days_since_first_seen', 14)
    .order('latest_rank', { ascending: true })
    .limit(50)

  // 2) 급상승: rank_delta_7d >= 3
  const riserQ = await (sb as unknown as {
    from: (n: string) => {
      select: (s: string) => {
        gte: (a: string, b: number) => {
          order: (col: string, opts: { ascending: boolean }) => {
            limit: (n: number) => Promise<{ data: DriftRow[] | null; error: unknown }>
          }
        }
      }
    }
  })
    .from('v_autocomplete_drift')
    .select(
      'source, seed, suggestion, first_seen_at, latest_at, occurrences, days_since_first_seen, latest_rank, rank_7d_ago, rank_delta_7d',
    )
    .gte('rank_delta_7d', 3)
    .order('rank_delta_7d', { ascending: false })
    .limit(50)

  // 3) seed→suggestion bubble: 최근 7일 활성 (seed, suggestion) 집계
  const sevenAgo = new Date(Date.now() - 7 * 86400_000).toISOString()
  const { data: bubbleRows } = await (sb as unknown as {
    from: (n: string) => {
      select: (s: string) => {
        gte: (a: string, b: string) => {
          limit: (n: number) => Promise<{ data: Array<{ source: string; seed: string; suggestion: string; rank: number }> | null }>
        }
      }
    }
  })
    .from('jimscanner_autocomplete_snapshots')
    .select('source, seed, suggestion, rank')
    .gte('captured_at', sevenAgo)
    .limit(5000)

  const bubbleMap = new Map<string, { seed: string; count: number; suggestions: Set<string> }>()
  for (const r of bubbleRows ?? []) {
    const key = r.seed
    let v = bubbleMap.get(key)
    if (!v) {
      v = { seed: key, count: 0, suggestions: new Set() }
      bubbleMap.set(key, v)
    }
    v.count++
    v.suggestions.add(r.suggestion)
  }
  const bubble = [...bubbleMap.values()]
    .map((v) => ({ seed: v.seed, count: v.count, uniqueSuggestions: v.suggestions.size }))
    .sort((a, b) => b.uniqueSuggestions - a.uniqueSuggestions)
    .slice(0, 30)

  return {
    newSuggestions: (newQ.data ?? []) as DriftRow[],
    risers: (riserQ.data ?? []) as DriftRow[],
    bubble,
  }
}

export default async function AutocompleteDriftPage() {
  const { newSuggestions, risers, bubble } = await fetchData()

  return (
    <div className="space-y-8 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">자동완성 드리프트</h1>
          <p className="text-sm text-gray-500 mt-1">
            google_suggest / naver_autocomplete 의 신규·급상승 완성어. 검색량 폭증의 전조 (anticipatory signal).
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 1) 신규 완성어 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">
          🆕 신규 완성어 Top 50{' '}
          <span className="text-xs font-normal text-gray-500 ml-2">(지난 14일 내 first_seen, latest_rank 오름차순)</span>
        </h2>
        {newSuggestions.length === 0 ? (
          <EmptyHint />
        ) : (
          <div className="rounded border border-gray-200 divide-y divide-gray-100">
            <div className="grid grid-cols-12 px-3 py-2 text-xs text-gray-500 bg-gray-50">
              <div className="col-span-1">#</div>
              <div className="col-span-4">완성어</div>
              <div className="col-span-3">seed</div>
              <div className="col-span-1 text-right">rank</div>
              <div className="col-span-1 text-right">days</div>
              <div className="col-span-2 text-right">first_seen</div>
            </div>
            {newSuggestions.map((r, i) => (
              <div
                key={`${r.source}::${r.seed}::${r.suggestion}`}
                className="grid grid-cols-12 px-3 py-2 text-sm hover:bg-gray-50"
              >
                <div className="col-span-1 font-mono text-gray-400">{i + 1}</div>
                <div className="col-span-4">
                  <div className="font-medium">{r.suggestion}</div>
                  <div className="text-xs text-gray-400">{r.source}</div>
                </div>
                <div className="col-span-3 text-xs text-gray-600 truncate">{r.seed}</div>
                <div className="col-span-1 text-right font-mono">{r.latest_rank}</div>
                <div className="col-span-1 text-right font-mono text-gray-500">{r.days_since_first_seen}</div>
                <div className="col-span-2 text-right text-xs text-gray-400 font-mono">
                  {r.first_seen_at?.slice(0, 10)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 2) 급상승 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">
          📈 급상승 완성어{' '}
          <span className="text-xs font-normal text-gray-500 ml-2">(rank_delta_7d ≥ 3 — 7일 전 대비 3계단 이상 상승)</span>
        </h2>
        {risers.length === 0 ? (
          <EmptyHint />
        ) : (
          <div className="rounded border border-gray-200 divide-y divide-gray-100">
            <div className="grid grid-cols-12 px-3 py-2 text-xs text-gray-500 bg-gray-50">
              <div className="col-span-1">#</div>
              <div className="col-span-4">완성어</div>
              <div className="col-span-3">seed</div>
              <div className="col-span-1 text-right">현재</div>
              <div className="col-span-1 text-right">7d전</div>
              <div className="col-span-2 text-right">Δ rank</div>
            </div>
            {risers.map((r, i) => (
              <div
                key={`${r.source}::${r.seed}::${r.suggestion}`}
                className="grid grid-cols-12 px-3 py-2 text-sm hover:bg-gray-50"
              >
                <div className="col-span-1 font-mono text-gray-400">{i + 1}</div>
                <div className="col-span-4">
                  <div className="font-medium">{r.suggestion}</div>
                  <div className="text-xs text-gray-400">{r.source}</div>
                </div>
                <div className="col-span-3 text-xs text-gray-600 truncate">{r.seed}</div>
                <div className="col-span-1 text-right font-mono">{r.latest_rank}</div>
                <div className="col-span-1 text-right font-mono text-gray-500">{r.rank_7d_ago ?? '-'}</div>
                <div className="col-span-2 text-right font-mono font-bold text-emerald-700">
                  +{r.rank_delta_7d}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 3) seed bubble */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">
          🫧 seed → suggestion bubble{' '}
          <span className="text-xs font-normal text-gray-500 ml-2">(최근 7일, unique 완성어 수 기준)</span>
        </h2>
        {bubble.length === 0 ? (
          <EmptyHint />
        ) : (
          <div className="flex flex-wrap gap-2">
            {bubble.map((b) => {
              const size = Math.min(60, 12 + b.uniqueSuggestions * 2)
              return (
                <div
                  key={b.seed}
                  className="rounded-full bg-blue-50 border border-blue-200 px-3 py-1 flex items-baseline gap-2"
                  style={{ fontSize: `${Math.max(11, Math.min(18, size / 3))}px` }}
                >
                  <span className="font-medium">{b.seed}</span>
                  <span className="text-xs text-blue-700 font-mono">{b.uniqueSuggestions}</span>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <footer className="text-xs text-gray-400 pt-4 border-t border-gray-100">
        매일 KST 05:30 cron · <code className="px-1 bg-gray-100 rounded">scripts/autocomplete-drift-cron.mjs</code> ·
        commercial/transactional intent 인 신규 완성어는 자동으로 핀 후보 큐(jimscanner_trends_pins) 에 enqueue.
      </footer>
    </div>
  )
}

function EmptyHint() {
  return (
    <div className="rounded border border-dashed border-gray-300 p-8 text-center text-gray-500 text-sm">
      아직 데이터 없음 — cron 1~2일 누적 후 표시.
    </div>
  )
}
