import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface FiredSource {
  source: string
  category: string
  hits: number
  first_at: string
  last_at: string
}

interface ConvergenceRow {
  keyword: string
  quorum: number
  category_count: number
  entropy: number
  fired_sources: FiredSource[]
  first_at: string
  last_at: string
  lag_seconds: number
  computed_at: string
}

const CATEGORY_LABEL: Record<string, string> = {
  community: '커뮤니티',
  news: '뉴스',
  commerce: '커머스',
  broadcast: '방송',
  b2b: 'B2B',
  search: '검색',
  other: '기타',
}

const CATEGORY_COLOR: Record<string, string> = {
  community: 'bg-purple-100 text-purple-700',
  news: 'bg-blue-100 text-blue-700',
  commerce: 'bg-green-100 text-green-700',
  broadcast: 'bg-red-100 text-red-700',
  b2b: 'bg-amber-100 text-amber-700',
  search: 'bg-slate-100 text-slate-700',
  other: 'bg-gray-100 text-gray-600',
}

async function fetchData(params: { minQuorum: number; sort: 'entropy' | 'quorum' | 'recent' }) {
  const sb = createAdminClient()

  // MV 는 아직 타입에 없으므로 as any
  const { data, error } = await (sb as any)
    .from('jimscanner_trends_convergence')
    .select('keyword, quorum, category_count, entropy, fired_sources, first_at, last_at, lag_seconds, computed_at')
    .gte('quorum', params.minQuorum)
    .order(params.sort === 'recent' ? 'last_at' : params.sort, { ascending: false })
    .limit(200)

  if (error) {
    return { rows: [] as ConvergenceRow[], error: error.message }
  }

  return { rows: (data ?? []) as ConvergenceRow[], error: null }
}

function formatLag(sec: number): string {
  if (!sec || sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  if (sec < 86400) return `${Math.round(sec / 3600)}h`
  return `${Math.round(sec / 86400)}d`
}

function formatTime(iso: string): string {
  if (!iso) return '—'
  return iso.slice(5, 16).replace('T', ' ')
}

export default async function ConvergencePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string }>
}) {
  const sp = await searchParams
  const minQuorum = Math.max(1, Math.min(10, parseInt(sp.q ?? '3', 10) || 3))
  const sort = (['entropy', 'quorum', 'recent'].includes(sp.sort ?? '')
    ? sp.sort
    : 'entropy') as 'entropy' | 'quorum' | 'recent'

  const { rows, error } = await fetchData({ minQuorum, sort })

  const maxQuorum = rows.reduce((m, r) => Math.max(m, r.quorum), 0)
  const maxEntropy = rows.reduce((m, r) => Math.max(m, r.entropy), 0)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Convergence Quorum</h1>
          <p className="text-sm text-gray-500 mt-1">
            롤링 48h · 이질 소스 동시 점화 합의 · quorum = distinct 소스 수 · entropy = 카테고리 다양성
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="flex items-center gap-4 text-sm">
        <div className="flex items-center gap-1">
          <span className="text-gray-500">최소 quorum:</span>
          {[2, 3, 4, 5].map((q) => (
            <Link
              key={q}
              href={`/admin/trend-radar/convergence?q=${q}&sort=${sort}`}
              className={`px-2 py-1 rounded ${
                minQuorum === q ? 'bg-black text-white' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              ≥{q}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-gray-500">정렬:</span>
          {(['entropy', 'quorum', 'recent'] as const).map((s) => (
            <Link
              key={s}
              href={`/admin/trend-radar/convergence?q=${minQuorum}&sort=${s}`}
              className={`px-2 py-1 rounded ${
                sort === s ? 'bg-black text-white' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {s}
            </Link>
          ))}
        </div>
        <div className="ml-auto text-xs text-gray-400">
          {rows.length}건 · max quorum {maxQuorum} · max entropy {maxEntropy.toFixed(2)}
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          데이터 로드 실패: {error}
          <br />
          <span className="text-xs text-red-500">
            MV 가 아직 적용되지 않았을 수 있습니다. supabase/trends_v6_convergence.sql 적용 + RPC 1회 실행 필요.
          </span>
        </div>
      )}

      {rows.length === 0 && !error ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 합의 시그널 없음</p>
          <p className="text-sm mt-2">
            최소 quorum ≥{minQuorum} 인 키워드가 없습니다.
            <br />
            jimscanner_trends_recompute_convergence() RPC 가 매 정시 갱신 — 데이터 누적 후 다시 방문.
          </p>
        </div>
      ) : (
        <section>
          <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-2 border-b border-gray-200">
            <div className="col-span-1">#</div>
            <div className="col-span-4">키워드</div>
            <div className="col-span-1 text-right">quorum</div>
            <div className="col-span-1 text-right">cats</div>
            <div className="col-span-1 text-right">entropy</div>
            <div className="col-span-1 text-right">lag</div>
            <div className="col-span-3">점화 소스 (시간순)</div>
          </div>
          {rows.map((r, i) => (
            <details
              key={r.keyword}
              className="group border-b border-gray-100 hover:bg-gray-50/60 transition-colors"
            >
              <summary className="grid grid-cols-12 px-3 py-2 cursor-pointer items-center list-none">
                <div className="col-span-1 text-gray-400 font-mono text-sm">{i + 1}</div>
                <div className="col-span-4 font-medium text-sm truncate">{r.keyword}</div>
                <div className="col-span-1 text-right font-mono font-bold text-sm">{r.quorum}</div>
                <div className="col-span-1 text-right font-mono text-gray-600 text-sm">{r.category_count}</div>
                <div className="col-span-1 text-right font-mono text-gray-600 text-sm">
                  {Number(r.entropy).toFixed(2)}
                </div>
                <div className="col-span-1 text-right font-mono text-gray-500 text-xs">
                  {formatLag(r.lag_seconds)}
                </div>
                <div className="col-span-3 flex flex-wrap gap-1">
                  {(r.fired_sources ?? []).slice(0, 6).map((f) => (
                    <span
                      key={f.source}
                      className={`text-[10px] px-1.5 py-0.5 rounded ${
                        CATEGORY_COLOR[f.category] ?? CATEGORY_COLOR.other
                      }`}
                      title={`${f.source} · ${CATEGORY_LABEL[f.category] ?? f.category} · ${f.hits}회 · 처음 ${formatTime(f.first_at)} → 마지막 ${formatTime(f.last_at)}`}
                    >
                      {f.source}
                    </span>
                  ))}
                  {(r.fired_sources?.length ?? 0) > 6 && (
                    <span className="text-[10px] text-gray-400">
                      +{(r.fired_sources?.length ?? 0) - 6}
                    </span>
                  )}
                </div>
              </summary>

              {/* 타임라인 */}
              <div className="px-3 pb-3 pt-1">
                <div className="grid gap-0.5 text-xs">
                  <div className="grid grid-cols-12 text-[10px] text-gray-400 px-2 pb-1 border-b border-gray-100">
                    <div className="col-span-3">소스</div>
                    <div className="col-span-2">카테고리</div>
                    <div className="col-span-1 text-right">hits</div>
                    <div className="col-span-3">처음 등장</div>
                    <div className="col-span-3">마지막 등장</div>
                  </div>
                  {(r.fired_sources ?? []).map((f) => (
                    <div
                      key={f.source}
                      className="grid grid-cols-12 px-2 py-1 items-center hover:bg-white"
                    >
                      <div className="col-span-3 font-mono truncate">{f.source}</div>
                      <div className="col-span-2">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] ${
                            CATEGORY_COLOR[f.category] ?? CATEGORY_COLOR.other
                          }`}
                        >
                          {CATEGORY_LABEL[f.category] ?? f.category}
                        </span>
                      </div>
                      <div className="col-span-1 text-right font-mono">{f.hits}</div>
                      <div className="col-span-3 text-gray-500 font-mono">{formatTime(f.first_at)}</div>
                      <div className="col-span-3 text-gray-500 font-mono">{formatTime(f.last_at)}</div>
                    </div>
                  ))}
                </div>
                <div className="text-[10px] text-gray-400 mt-2 px-2">
                  computed_at {formatTime(r.computed_at)} · window 48h
                </div>
              </div>
            </details>
          ))}
        </section>
      )}

      <footer className="text-xs text-gray-400 pt-4 border-t border-gray-100">
        <p>
          <strong>quorum</strong> = 48h 윈도우에서 같은 키워드를 가리킨 distinct 소스 수.
          <strong> entropy</strong> = 점화 소스 카테고리 분포의 Shannon 엔트로피(다양성↑ = 다중 청중↑).
          <strong> lag</strong> = 첫 점화 → 마지막 점화 간격. lag 가 짧고 entropy 가 높을수록 진짜 동시 합의.
        </p>
      </footer>
    </div>
  )
}
