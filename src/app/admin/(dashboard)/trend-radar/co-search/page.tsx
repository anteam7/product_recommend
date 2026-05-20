import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface EdgeRow {
  keyword_a: string
  keyword_b: string
  source: string
  weight: number
  observed_at: string
}

type ClusterNode = {
  keyword: string
  members: Set<string>
  edgeCount: number
  totalWeight: number
}

async function fetchEdges() {
  const sb = createAdminClient()
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()
  // 'as any' — 새 마이그레이션 (trends_v5_query_edges.sql) 적용 전까지 타입 미생성
  const { data, error } = await (sb as any)
    .from('jimscanner_trends_query_edges')
    .select('keyword_a, keyword_b, source, weight, observed_at')
    .gte('observed_at', since)
    .order('weight', { ascending: false })
    .limit(2000)
  if (error) return { rows: [] as EdgeRow[], error: error.message as string | null }
  return { rows: (data ?? []) as EdgeRow[], error: null as string | null }
}

/**
 * Greedy union-find 기반 단순 클러스터링 — modularity 보다 가벼움.
 * weight 내림차순으로 엣지 훑으며 연결 + 클러스터 크기 cap (12).
 */
function clusterEdges(rows: EdgeRow[]) {
  const parent = new Map<string, string>()
  const size = new Map<string, number>()

  function find(x: string): string {
    let p = parent.get(x) ?? x
    while (p !== (parent.get(p) ?? p)) {
      p = parent.get(p) ?? p
    }
    let cur = x
    while (cur !== p) {
      const next = parent.get(cur) ?? cur
      parent.set(cur, p)
      cur = next
    }
    return p
  }
  function add(x: string) {
    if (!parent.has(x)) {
      parent.set(x, x)
      size.set(x, 1)
    }
  }
  function union(a: string, b: string, cap = 12) {
    add(a); add(b)
    const ra = find(a), rb = find(b)
    if (ra === rb) return
    const sa = size.get(ra) ?? 1
    const sb = size.get(rb) ?? 1
    if (sa + sb > cap) return
    if (sa < sb) {
      parent.set(ra, rb)
      size.set(rb, sa + sb)
    } else {
      parent.set(rb, ra)
      size.set(ra, sa + sb)
    }
  }

  for (const e of rows) {
    union(e.keyword_a, e.keyword_b)
  }

  const groups = new Map<string, ClusterNode>()
  for (const e of rows) {
    const root = find(e.keyword_a)
    let g = groups.get(root)
    if (!g) {
      g = { keyword: root, members: new Set(), edgeCount: 0, totalWeight: 0 }
      groups.set(root, g)
    }
    g.members.add(e.keyword_a)
    g.members.add(e.keyword_b)
    g.edgeCount += 1
    g.totalWeight += e.weight
  }
  return [...groups.values()]
    .filter((g) => g.members.size >= 3)
    .sort((a, b) => b.totalWeight - a.totalWeight)
}

export default async function CoSearchPage() {
  const { rows, error } = await fetchEdges()

  if (error) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold">Co-search 그래프</h1>
        <div className="mt-4 rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">테이블 미존재 또는 접근 불가</p>
          <p className="mt-1">
            먼저 마이그레이션을 적용하세요:
            <code className="ml-2 px-1 bg-amber-100 rounded">supabase/trends_v5_query_edges.sql</code>
          </p>
          <p className="mt-2 text-xs text-amber-700 font-mono">{error}</p>
        </div>
      </div>
    )
  }

  const clusters = clusterEdges(rows)
  const topEdges = rows.slice(0, 50)

  const bySource = new Map<string, number>()
  for (const r of rows) {
    bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1)
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Co-search 그래프</h1>
          <p className="text-sm text-gray-500 mt-1">
            네이버 자동완성·연관검색어 + product alias 동시 출현 기반 키워드-키워드 인접 그래프 (최근 30일).
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-500 hover:text-black"
        >
          ← 대시보드
        </Link>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="총 엣지" value={rows.length} />
        <Kpi label="클러스터 (≥3)" value={clusters.length} />
        <Kpi
          label="네이버 자동완성"
          value={bySource.get('naver_suggest') ?? 0}
        />
        <Kpi
          label="연관검색어"
          value={bySource.get('naver_related') ?? 0}
        />
      </section>

      {/* 묶음 진입 권장 클러스터 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          🪢 묶음 진입 권장 클러스터 ({clusters.length})
          <span className="text-xs font-normal text-gray-500 ml-2">
            한 핀이 가져올 SEO halo 후보 — 한 번에 콘텐츠/상품 묶음 등록 권장
          </span>
        </h2>
        {clusters.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
            아직 클러스터 없음. KST 03:40 cron 누적 후 다시 확인.
          </div>
        ) : (
          <div className="grid gap-2">
            {clusters.slice(0, 20).map((c, i) => (
              <div
                key={i}
                className="rounded border border-gray-200 px-3 py-2 hover:bg-gray-50"
              >
                <div className="flex items-baseline justify-between flex-wrap gap-2">
                  <div className="font-medium text-sm">
                    클러스터 #{i + 1}{' '}
                    <span className="text-xs font-normal text-gray-500">
                      {c.members.size}개 키워드 · {c.edgeCount} 엣지 · weight {c.totalWeight.toFixed(1)}
                    </span>
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {[...c.members].slice(0, 12).map((kw) => (
                    <span
                      key={kw}
                      className="text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-100"
                    >
                      {kw}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Top 엣지 테이블 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">Top 엣지 ({topEdges.length})</h2>
        <div className="rounded border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs">
              <tr>
                <th className="px-3 py-2 text-left">keyword_a</th>
                <th className="px-3 py-2 text-left">keyword_b</th>
                <th className="px-3 py-2 text-left">source</th>
                <th className="px-3 py-2 text-right">weight</th>
                <th className="px-3 py-2 text-right">observed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {topEdges.map((e, i) => (
                <tr key={i}>
                  <td className="px-3 py-1.5">{e.keyword_a}</td>
                  <td className="px-3 py-1.5">{e.keyword_b}</td>
                  <td className="px-3 py-1.5 text-xs text-gray-500">{e.source}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{e.weight.toFixed(1)}</td>
                  <td className="px-3 py-1.5 text-right text-xs text-gray-400 font-mono">
                    {e.observed_at?.slice(5, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="text-xs text-gray-500">
        수집: <code className="px-1 bg-gray-100 rounded">scripts/collect-naver-related-keywords.mjs</code> · 권장 cron KST 03:40
      </section>
    </div>
  )
}

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-gray-200 p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{value.toLocaleString()}</div>
    </div>
  )
}
