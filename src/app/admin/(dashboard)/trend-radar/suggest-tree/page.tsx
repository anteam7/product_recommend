import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// suggest_demand_tree RPC (supabase/suggest_demand_tree_rpc.sql) — generated 타입 미반영,
// `npm run gen:types` 후 `as never` 캐스팅 제거.
interface DemandRow {
  seed: string
  suggestion: string
  sources: string[] | null
  occurrence_count: number
  last_seen: string
  matched_product_id: string | null
  matched_canonical: string | null
  competition_score: number | null
}

const DAYS_OPTIONS = [
  { v: 7, label: '7일' },
  { v: 30, label: '30일 (기본)' },
  { v: 90, label: '90일' },
] as const

// competition_score 높음 = 경쟁 약함 (opportunity matrix 와 동일 규약).
// 이 값 이상이면 "매칭됐지만 경쟁 약함" → 화이트스페이스 후보로 본다.
const WEAK_COMPETITION_THRESHOLD = 60
// 손자가지(완성어 변형) 이 정도 이상이면 "수요 두꺼운 가지".
const THICK_BRANCH_LEAVES = 3

async function fetchTree(days: number) {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('suggest_demand_tree' as never, {
    days_window: days,
    result_limit: 3000,
  } as never)
  if (error) return { rows: [] as DemandRow[], error: error.message }
  return { rows: (data ?? []) as DemandRow[], error: null as string | null }
}

function tokenize(s: string): string[] {
  return s.split(/\s+/).filter(Boolean)
}

// 완성어가 시드로 시작하면 시드 부분을 떼어내 "가지 경로"만 남긴다.
function branchPath(seed: string, suggestion: string): string[] {
  const sg = suggestion.trim()
  const sd = seed.trim()
  let rest = sg
  if (sd && sd !== '(기타)' && sg.toLowerCase().startsWith(sd.toLowerCase())) {
    rest = sg.slice(sd.length).trim()
  }
  return tokenize(rest)
}

interface Leaf extends DemandRow {
  isWhitespace: boolean // 미매칭 or 경쟁약함
  isUnmatched: boolean // 캐노니컬 상품 자체가 없음 (가장 강한 신호)
}
interface Branch {
  key: string // 가지 첫 토큰
  leaves: Leaf[]
  totalOccurrence: number
  whitespaceCount: number
}
interface SeedNode {
  seed: string
  branches: Branch[]
  leafCount: number
  whitespaceCount: number
  sources: Set<string>
}

function buildTree(rows: DemandRow[]): SeedNode[] {
  const bySeed = new Map<string, DemandRow[]>()
  for (const r of rows) {
    if (!r.suggestion) continue
    const arr = bySeed.get(r.seed) ?? []
    arr.push(r)
    bySeed.set(r.seed, arr)
  }

  const nodes: SeedNode[] = []
  for (const [seed, seedRows] of bySeed) {
    const branchMap = new Map<string, Leaf[]>()
    const sources = new Set<string>()
    for (const r of seedRows) {
      for (const s of r.sources ?? []) sources.add(s)
      const path = branchPath(seed, r.suggestion)
      const key = path[0] ?? '(시드 직접)'
      const isUnmatched = !r.matched_product_id
      const isWhitespace =
        isUnmatched ||
        (r.competition_score != null && r.competition_score >= WEAK_COMPETITION_THRESHOLD)
      const leaf: Leaf = { ...r, isWhitespace, isUnmatched }
      const arr = branchMap.get(key) ?? []
      arr.push(leaf)
      branchMap.set(key, arr)
    }

    const branches: Branch[] = [...branchMap.entries()]
      .map(([key, leaves]) => {
        leaves.sort((a, b) => a.suggestion.localeCompare(b.suggestion, 'ko'))
        return {
          key,
          leaves,
          totalOccurrence: leaves.reduce((s, l) => s + (l.occurrence_count || 0), 0),
          whitespaceCount: leaves.filter((l) => l.isWhitespace).length,
        }
      })
      // 두꺼운 + 화이트스페이스 많은 가지 우선
      .sort(
        (a, b) =>
          b.whitespaceCount - a.whitespaceCount ||
          b.leaves.length - a.leaves.length ||
          b.totalOccurrence - a.totalOccurrence,
      )

    const leafCount = branches.reduce((s, b) => s + b.leaves.length, 0)
    const whitespaceCount = branches.reduce((s, b) => s + b.whitespaceCount, 0)
    nodes.push({ seed, branches, leafCount, whitespaceCount, sources })
  }

  // 화이트스페이스가 많은 시드 우선
  nodes.sort(
    (a, b) => b.whitespaceCount - a.whitespaceCount || b.leafCount - a.leafCount,
  )
  return nodes
}

function SourceBadge({ source }: { source: string }) {
  const isNaver = source.startsWith('naver')
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-mono leading-none ${
        isNaver ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'
      }`}
      title={source}
    >
      {isNaver ? 'N' : 'G'}
    </span>
  )
}

export default async function SuggestTreePage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>
}) {
  const sp = await searchParams
  const days = DAYS_OPTIONS.some((d) => String(d.v) === sp.days) ? Number(sp.days) : 30

  const { rows, error } = await fetchTree(days)
  const tree = buildTree(rows)

  const totalLeaves = tree.reduce((s, n) => s + n.leafCount, 0)
  const totalWhitespace = tree.reduce((s, n) => s + n.whitespaceCount, 0)
  const matchedCount = rows.filter((r) => r.matched_product_id).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">검색 자동완성 수요 트리</h1>
          <p className="text-sm text-gray-500 mt-1">
            실제 사용자가 친 자동완성 완성어를 시드 → 가지 → 손자가지로 펼침 ·{' '}
            <span className="text-amber-700 font-medium">노랑 = 니치 화이트스페이스</span>{' '}
            (캐노니컬 미발굴 or 경쟁 약함)
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="flex items-center gap-4 flex-wrap">
        <nav className="flex gap-2">
          {DAYS_OPTIONS.map((d) => (
            <Link
              key={d.v}
              href={`/admin/trend-radar/suggest-tree?days=${d.v}`}
              className={`px-3 py-1.5 text-sm rounded border ${
                days === d.v
                  ? 'border-black bg-black text-white font-semibold'
                  : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {d.label}
            </Link>
          ))}
        </nav>
        <div className="text-xs text-gray-500 flex gap-3">
          <span>시드 {tree.length}</span>
          <span>완성어 {totalLeaves}</span>
          <span>매칭 {matchedCount}</span>
          <span className="text-amber-700 font-semibold">화이트스페이스 {totalWhitespace}</span>
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-700">
          RPC 오류: {error}
          <div className="text-xs text-red-500 mt-1">
            supabase/suggest_demand_tree_rpc.sql 적용 여부 확인.
          </div>
        </div>
      )}

      {!error && tree.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 자동완성 데이터 없음. collect-google-suggest 크론 누적 후 다시 방문.
        </div>
      ) : (
        <div className="space-y-2">
          {tree.map((node) => (
            <details
              key={node.seed}
              open={node.whitespaceCount > 0}
              className="rounded border border-gray-200 overflow-hidden"
            >
              <summary className="cursor-pointer select-none px-4 py-3 bg-gray-50 hover:bg-gray-100 flex items-center justify-between gap-2">
                <span className="font-semibold text-sm flex items-center gap-2">
                  {node.seed}
                  <span className="flex gap-1">
                    {[...node.sources].sort().map((s) => (
                      <SourceBadge key={s} source={s} />
                    ))}
                  </span>
                </span>
                <span className="text-xs text-gray-500 flex gap-3">
                  <span>완성어 {node.leafCount}</span>
                  {node.whitespaceCount > 0 && (
                    <span className="text-amber-700 font-semibold">
                      화이트스페이스 {node.whitespaceCount}
                    </span>
                  )}
                </span>
              </summary>

              <div className="divide-y divide-gray-100">
                {node.branches.map((branch) => {
                  const thick = branch.leaves.length >= THICK_BRANCH_LEAVES
                  return (
                    <div key={branch.key} className="px-4 py-2">
                      <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
                        <span
                          className={`font-mono ${thick ? 'text-gray-900 font-semibold' : ''}`}
                        >
                          {node.seed === '(기타)' ? '' : `${node.seed} ▸ `}
                          {branch.key}
                        </span>
                        {thick && (
                          <span className="rounded bg-gray-900 text-white px-1.5 py-0.5 text-[10px]">
                            두꺼운 가지 {branch.leaves.length}
                          </span>
                        )}
                        {thick && branch.whitespaceCount === branch.leaves.length && (
                          <span className="rounded bg-amber-500 text-white px-1.5 py-0.5 text-[10px]">
                            🎯 통째 미발굴
                          </span>
                        )}
                      </div>
                      <div className="grid gap-0.5 pl-3 border-l-2 border-gray-100">
                        {branch.leaves.map((leaf) => (
                          <div
                            key={leaf.suggestion}
                            className={`flex items-center justify-between gap-2 rounded px-2 py-1 text-sm ${
                              leaf.isWhitespace ? 'bg-amber-50' : 'hover:bg-gray-50'
                            }`}
                          >
                            <span className="flex items-center gap-2 min-w-0">
                              <span className="truncate">{leaf.suggestion}</span>
                              <span className="flex gap-1 shrink-0">
                                {(leaf.sources ?? []).map((s) => (
                                  <SourceBadge key={s} source={s} />
                                ))}
                              </span>
                            </span>
                            <span className="flex items-center gap-2 shrink-0 text-xs">
                              {leaf.matched_product_id ? (
                                <Link
                                  href={`/admin/trend-radar/products/${leaf.matched_product_id}`}
                                  className="text-gray-600 hover:text-black underline max-w-[160px] truncate"
                                  title={leaf.matched_canonical ?? ''}
                                >
                                  {leaf.matched_canonical ?? '매칭'}
                                </Link>
                              ) : (
                                <span className="text-amber-700 font-medium">미발굴</span>
                              )}
                              {leaf.competition_score != null && (
                                <span
                                  className={`font-mono ${
                                    leaf.competition_score >= WEAK_COMPETITION_THRESHOLD
                                      ? 'text-amber-700 font-semibold'
                                      : 'text-gray-400'
                                  }`}
                                  title="competition_score (높음=경쟁약함)"
                                >
                                  C{Math.round(leaf.competition_score)}
                                </span>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            </details>
          ))}
        </div>
      )}

      <section className="rounded border border-dashed border-gray-300 p-4 text-xs text-gray-500">
        <strong className="text-gray-700">읽는 법:</strong> 시드(검색 prefix) → 가지(첫 수식어) →
        손자가지(완성어). 노란 줄은 ① 캐노니컬 상품이 아직 없거나(미발굴) ② 매칭은 됐지만
        competition_score ≥ {WEAK_COMPETITION_THRESHOLD}(경쟁 약함)인 롱테일 — 1인 셀러가 노릴
        화이트스페이스. 가지 전체가 미발굴이면 🎯. 소스 뱃지: G=google_suggest, N=naver.
      </section>
    </div>
  )
}
