import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface EdgeRow {
  id: string
  source_term: string
  target_term: string
  pattern: string
  count: number
  reason_tags: string[]
  sample_snippets: string[]
  source_product_id: string | null
  target_product_id: string | null
  first_seen: string
  last_seen: string
}

interface GgsanCandidateRow {
  goods_no: string
  title: string
  cate_label: string | null
  price_krw: number | null
  is_imminent: boolean
}

async function fetchData() {
  const sb = createAdminClient()

  // 전체 edges (최근 60일)
  const cutoff = new Date(Date.now() - 60 * 86400000).toISOString()
  const edgesRes = await (sb as any)
    .from('jimscanner_substitution_edges')
    .select(
      'id, source_term, target_term, pattern, count, reason_tags, sample_snippets, source_product_id, target_product_id, first_seen, last_seen',
    )
    .gte('last_seen', cutoff)
    .order('count', { ascending: false })
    .limit(2000)

  const edges: EdgeRow[] = (edgesRes.data ?? []) as EdgeRow[]

  // target 별 인바운드 집계 (코드 측)
  const targetMap = new Map<
    string,
    {
      target_term: string
      target_product_id: string | null
      inbound: number
      sources: Set<string>
      reasons: Map<string, number>
      patterns: Map<string, number>
      last_seen: string
    }
  >()
  for (const e of edges) {
    const k = e.target_term
    let cur = targetMap.get(k)
    if (!cur) {
      cur = {
        target_term: e.target_term,
        target_product_id: e.target_product_id,
        inbound: 0,
        sources: new Set(),
        reasons: new Map(),
        patterns: new Map(),
        last_seen: e.last_seen,
      }
      targetMap.set(k, cur)
    }
    cur.inbound += e.count
    cur.sources.add(e.source_term)
    for (const t of e.reason_tags ?? []) {
      cur.reasons.set(t, (cur.reasons.get(t) ?? 0) + e.count)
    }
    cur.patterns.set(e.pattern, (cur.patterns.get(e.pattern) ?? 0) + e.count)
    if (e.last_seen > cur.last_seen) cur.last_seen = e.last_seen
    if (!cur.target_product_id && e.target_product_id) cur.target_product_id = e.target_product_id
  }

  const targets = [...targetMap.values()]
    .sort((a, b) => b.inbound - a.inbound)
    .slice(0, 50)

  // ggsan 도매 후보 매칭 — target_term ilike
  let ggsanByTarget = new Map<string, GgsanCandidateRow[]>()
  if (targets.length > 0) {
    const orClauses = targets
      .slice(0, 30)
      .map((t) => `title.ilike.%${t.target_term.replace(/[%,]/g, '')}%`)
      .filter((s) => s.length > 0)
      .join(',')
    if (orClauses) {
      const { data: ggsan } = await sb
        .from('jimscanner_ggsan_products')
        .select('goods_no, title, cate_label, price_krw, is_imminent')
        .or(orClauses)
        .eq('status', 'active')
        .order('last_seen_at', { ascending: false })
        .limit(300)
      for (const g of (ggsan ?? []) as GgsanCandidateRow[]) {
        const lower = (g.title ?? '').toLowerCase()
        for (const t of targets) {
          if (lower.includes(t.target_term.toLowerCase())) {
            const arr = ggsanByTarget.get(t.target_term) ?? []
            if (arr.length < 3) arr.push(g)
            ggsanByTarget.set(t.target_term, arr)
          }
        }
      }
    }
  }

  // 상위 source->target edges (Sankey 대용 — 리스트)
  const topEdges = [...edges].sort((a, b) => b.count - a.count).slice(0, 80)

  // 시간축 누적 (월별)
  const monthly = new Map<string, number>()
  for (const e of edges) {
    const ym = e.last_seen.slice(0, 7)
    monthly.set(ym, (monthly.get(ym) ?? 0) + e.count)
  }
  const months = [...monthly.entries()].sort((a, b) => a[0].localeCompare(b[0]))

  return { edges, targets, ggsanByTarget, topEdges, months, totalEdges: edges.length }
}

function ReasonChip({ tag, count }: { tag: string; count: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs">
      <span className="font-medium">{tag}</span>
      <span className="text-gray-500">{count}</span>
    </span>
  )
}

export default async function SubstitutionPage() {
  const { edges, targets, ggsanByTarget, topEdges, months, totalEdges } = await fetchData()

  return (
    <div className="space-y-8 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">대체구매 마이그레이션 트래커</h1>
          <p className="text-sm text-gray-500 mt-1">
            &lsquo;A 대신/말고/보다/대안/vs B&rsquo; 발화 패턴에서 추출한 수요 이동 보드. 검색량보다
            먼저 나타나는 명시적 인텐트 시그널. 추출 cron:{' '}
            <code className="rounded bg-gray-100 px-1">scripts/extract-substitution.mjs</code>
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 대시보드
        </Link>
      </header>

      <section className="grid grid-cols-4 gap-3">
        <div className="rounded border border-gray-200 p-4">
          <div className="text-xs text-gray-500">최근 60일 엣지</div>
          <div className="text-2xl font-bold">{totalEdges.toLocaleString()}</div>
        </div>
        <div className="rounded border border-gray-200 p-4">
          <div className="text-xs text-gray-500">고유 target</div>
          <div className="text-2xl font-bold">{targets.length}</div>
        </div>
        <div className="rounded border border-gray-200 p-4">
          <div className="text-xs text-gray-500">상위 50 target 합산 inbound</div>
          <div className="text-2xl font-bold">
            {targets.reduce((s, t) => s + t.inbound, 0).toLocaleString()}
          </div>
        </div>
        <div className="rounded border border-gray-200 p-4">
          <div className="text-xs text-gray-500">ggsan 매칭된 target</div>
          <div className="text-2xl font-bold">{ggsanByTarget.size}</div>
        </div>
      </section>

      {totalEdges === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 추출된 엣지 없음</p>
          <p className="text-sm mt-2">
            <code className="rounded bg-gray-100 px-1">
              node --env-file=.env.local scripts/extract-substitution.mjs
            </code>{' '}
            실행 또는 cron 누적 후 재방문.
          </p>
        </div>
      ) : (
        <>
          <section>
            <h2 className="text-lg font-semibold mb-3">
              상위 target — 인바운드 엣지 수 Top 50
            </h2>
            <div className="overflow-x-auto rounded border border-gray-200">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-3 py-2 text-left">#</th>
                    <th className="px-3 py-2 text-left">target</th>
                    <th className="px-3 py-2 text-right">inbound</th>
                    <th className="px-3 py-2 text-right">distinct src</th>
                    <th className="px-3 py-2 text-left">이유 태그</th>
                    <th className="px-3 py-2 text-left">패턴</th>
                    <th className="px-3 py-2 text-left">ggsan 후보</th>
                    <th className="px-3 py-2 text-left">last seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {targets.map((t, i) => {
                    const reasonsSorted = [...t.reasons.entries()].sort((a, b) => b[1] - a[1])
                    const patternsStr = [...t.patterns.entries()]
                      .sort((a, b) => b[1] - a[1])
                      .map(([p, c]) => `${p}:${c}`)
                      .join(' · ')
                    const candidates = ggsanByTarget.get(t.target_term) ?? []
                    return (
                      <tr key={t.target_term} className="hover:bg-gray-50">
                        <td className="px-3 py-2 text-gray-400">{i + 1}</td>
                        <td className="px-3 py-2 font-medium">{t.target_term}</td>
                        <td className="px-3 py-2 text-right font-mono">{t.inbound}</td>
                        <td className="px-3 py-2 text-right font-mono text-gray-500">
                          {t.sources.size}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {reasonsSorted.slice(0, 5).map(([tag, c]) => (
                              <ReasonChip key={tag} tag={tag} count={c} />
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-500">{patternsStr}</td>
                        <td className="px-3 py-2">
                          {candidates.length === 0 ? (
                            <span className="text-xs text-gray-400">—</span>
                          ) : (
                            <div className="space-y-0.5">
                              {candidates.map((c) => (
                                <div key={c.goods_no} className="text-xs">
                                  {c.is_imminent && (
                                    <span className="mr-1 text-red-600">🔥</span>
                                  )}
                                  <span className="truncate">{c.title.slice(0, 32)}</span>
                                  {c.price_krw != null && (
                                    <span className="ml-1 text-gray-500">
                                      {c.price_krw.toLocaleString()}원
                                    </span>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-500">
                          {t.last_seen.slice(0, 10)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">
              source → target 상위 80 엣지 (Sankey 대용 리스트)
            </h2>
            <div className="grid grid-cols-2 gap-2">
              {topEdges.map((e) => (
                <div
                  key={e.id}
                  className="flex items-center gap-2 rounded border border-gray-100 bg-white px-3 py-2 text-sm"
                >
                  <span className="truncate text-gray-700">{e.source_term}</span>
                  <span className="text-gray-400">→[{e.pattern}]→</span>
                  <span className="truncate font-medium">{e.target_term}</span>
                  <span className="ml-auto font-mono text-xs text-gray-500">×{e.count}</span>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">시간축 누적 — 월별 엣지 발생량</h2>
            <div className="rounded border border-gray-200 p-4">
              <div className="flex items-end gap-2 h-32">
                {months.map(([ym, c]) => {
                  const max = Math.max(...months.map(([, v]) => v), 1)
                  const h = Math.max(2, Math.round((c / max) * 100))
                  return (
                    <div key={ym} className="flex flex-col items-center gap-1 flex-1">
                      <div className="text-xs text-gray-500 font-mono">{c}</div>
                      <div
                        className="w-full bg-blue-500 rounded-t"
                        style={{ height: `${h}%` }}
                        title={`${ym}: ${c}`}
                      />
                      <div className="text-xs text-gray-400">{ym}</div>
                    </div>
                  )
                })}
              </div>
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">샘플 스니펫 (상위 target 10개)</h2>
            <div className="space-y-3">
              {targets.slice(0, 10).map((t) => {
                const relevantEdges = edges.filter((e) => e.target_term === t.target_term)
                const snippets = relevantEdges
                  .flatMap((e) => e.sample_snippets ?? [])
                  .filter(Boolean)
                  .slice(0, 3)
                if (snippets.length === 0) return null
                return (
                  <div key={t.target_term} className="rounded border border-gray-100 p-3">
                    <div className="font-medium text-sm mb-2">
                      → {t.target_term}{' '}
                      <span className="text-xs text-gray-500">(inbound {t.inbound})</span>
                    </div>
                    <ul className="space-y-1 text-xs text-gray-700">
                      {snippets.map((s, i) => (
                        <li key={i} className="italic">
                          &ldquo;…{s}…&rdquo;
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              })}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
