import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import PromoteButton from './PromoteButton'

export const dynamic = 'force-dynamic'

type ExpansionRow = {
  id: string
  seed_keyword: string
  expanded_keyword: string
  depth: number
  parent_keyword: string | null
  source: string
  est_volume: number | null
  mapped_product_id: string | null
  collected_at: string
}

async function fetchData() {
  const sb = createAdminClient()
  // jimscanner_keyword_expansion 은 신규 테이블 — 타입 재생성 전이라 캐스팅.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (sb as any)
    .from('jimscanner_keyword_expansion')
    .select(
      'id, seed_keyword, expanded_keyword, depth, parent_keyword, source, est_volume, mapped_product_id, collected_at',
    )
    .order('seed_keyword', { ascending: true })
    .order('depth', { ascending: true })
    .order('expanded_keyword', { ascending: true })
    .limit(5000)
  return (data ?? []) as unknown as ExpansionRow[]
}

type TreeNode = {
  keyword: string
  depth: number
  source: string
  mapped: boolean
  est_volume: number | null
  children: TreeNode[]
}

function buildTree(rows: ExpansionRow[]): TreeNode[] {
  // 같은 (seed, source) 트리 단위로 묶음.
  // parent_keyword 가 같은 seed 안의 다른 노드를 가리킴 (depth 0 은 parent null = 시드 자신).
  // 시드 자신은 depth=0 행으로 들어있음.
  const groupKey = (r: ExpansionRow) => `${r.seed_keyword}::${r.source}`
  const groups = new Map<string, ExpansionRow[]>()
  for (const r of rows) {
    const k = groupKey(r)
    const arr = groups.get(k) ?? []
    arr.push(r)
    groups.set(k, arr)
  }

  const roots: TreeNode[] = []
  for (const [, list] of groups) {
    const byKw = new Map<string, TreeNode>()
    let root: TreeNode | null = null
    for (const r of list) {
      const node: TreeNode = {
        keyword: r.expanded_keyword,
        depth: r.depth,
        source: r.source,
        mapped: r.mapped_product_id !== null,
        est_volume: r.est_volume,
        children: [],
      }
      byKw.set(r.expanded_keyword, node)
      if (r.depth === 0) root = node
    }
    for (const r of list) {
      if (r.depth === 0 || !r.parent_keyword) continue
      const parent = byKw.get(r.parent_keyword)
      const self = byKw.get(r.expanded_keyword)
      if (parent && self) parent.children.push(self)
    }
    if (root) roots.push(root)
  }
  // 시드 알파벳·소스 순
  roots.sort((a, b) => a.keyword.localeCompare(b.keyword) || a.source.localeCompare(b.source))
  return roots
}

function countGaps(node: TreeNode): { total: number; gaps: number } {
  let total = 1
  let gaps = node.mapped ? 0 : 1
  for (const c of node.children) {
    const s = countGaps(c)
    total += s.total
    gaps += s.gaps
  }
  return { total, gaps }
}

function TreeBranch({ node }: { node: TreeNode }) {
  const isGap = !node.mapped && node.depth > 0
  return (
    <li className="my-1">
      <div className="flex items-center gap-2 text-sm">
        <span
          className={
            isGap
              ? 'text-red-600 font-medium'
              : node.mapped
                ? 'text-gray-700'
                : 'text-gray-900 font-medium'
          }
        >
          {node.keyword}
        </span>
        <span className="text-[10px] text-gray-400">d{node.depth}</span>
        {node.mapped && <span className="text-[10px] text-green-600">매칭</span>}
        {isGap && (
          <>
            <span className="text-[10px] text-red-500">공백</span>
            <PromoteButton keyword={node.keyword} source={node.source} />
          </>
        )}
      </div>
      {node.children.length > 0 && (
        <ul className="ml-5 border-l border-gray-200 pl-3">
          {node.children
            .slice()
            .sort((a, b) => a.keyword.localeCompare(b.keyword))
            .map((c) => (
              <TreeBranch key={`${c.source}::${c.keyword}`} node={c} />
            ))}
        </ul>
      )}
    </li>
  )
}

export default async function KeywordTreePage() {
  const rows = await fetchData()
  const trees = buildTree(rows)
  const totalRows = rows.length
  const totalGaps = rows.filter((r) => r.mapped_product_id === null && r.depth > 0).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">키워드 확장 트리</h1>
          <p className="text-sm text-gray-500 mt-1">
            자동완성 BFS 로 펼친 long-tail 키워드. 빨간색 = 현재 풀에 없는 <b>공백 후보</b>.
          </p>
          <p className="text-xs text-gray-400 mt-1">
            노드 {totalRows.toLocaleString()} · 공백 {totalGaps.toLocaleString()} · 트리 {trees.length}
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 대시보드
        </Link>
      </header>

      {trees.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 확장 데이터 없음</p>
          <p className="text-sm mt-2">
            <code className="px-1 bg-gray-100 rounded">/api/cron/expand-keywords</code> 실행 후
            나타납니다.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {trees.map((t) => {
            const { total, gaps } = countGaps(t)
            return (
              <section
                key={`${t.source}::${t.keyword}`}
                className="rounded border border-gray-200 p-4 bg-white"
              >
                <header className="flex items-baseline justify-between mb-2">
                  <div className="font-semibold text-gray-900">
                    {t.keyword}{' '}
                    <span className="text-[10px] text-gray-400 font-normal">{t.source}</span>
                  </div>
                  <div className="text-xs text-gray-500">
                    노드 {total} · 공백 <span className="text-red-600">{gaps}</span>
                  </div>
                </header>
                <ul className="text-sm">
                  {t.children
                    .slice()
                    .sort((a, b) => a.keyword.localeCompare(b.keyword))
                    .map((c) => (
                      <TreeBranch key={`${c.source}::${c.keyword}`} node={c} />
                    ))}
                </ul>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
