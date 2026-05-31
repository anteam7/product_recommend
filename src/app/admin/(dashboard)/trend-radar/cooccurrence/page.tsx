import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import CooccurrenceNetwork, { type NetEdge, type NetNode } from './CooccurrenceNetwork'

export const dynamic = 'force-dynamic'

interface CoocRow {
  product_a: string
  product_b: string
  doc_count: number
  source_breadth: number
  pmi: number
  last_seen: string
}

async function fetchData(): Promise<{ nodes: NetNode[]; edges: NetEdge[] }> {
  const sb = createAdminClient()

  // 1) 동시언급 쌍 — 강도(doc_count) 상위만
  const { data: coocData } = await (sb as any)
    .from('jimscanner_trends_cooccurrence')
    .select('product_a, product_b, doc_count, source_breadth, pmi, last_seen')
    .order('doc_count', { ascending: false })
    .limit(400)
  const cooc = (coocData ?? []) as CoocRow[]
  if (cooc.length === 0) return { nodes: [], edges: [] }

  // 2) 등장 product id 수집
  const ids = new Set<string>()
  for (const c of cooc) { ids.add(c.product_a); ids.add(c.product_b) }
  const idList = [...ids]

  // 3) 상품 메타
  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', idList)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  // 4) 최신 final_score (노드 크기)
  const { data: scoreData } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .in('product_id', idList)
    .order('computed_at', { ascending: false })
    .limit(4000)
  const finalById = new Map<string, number>()
  for (const s of (scoreData ?? []) as any[]) {
    if (!finalById.has(s.product_id)) finalById.set(s.product_id, Number(s.final_score) || 0)
  }

  // 5) 내가 소싱하는 상품 = supplier(도매) row 가 존재하는 product
  const { data: supData } = await sb
    .from('jimscanner_trends_supplier')
    .select('product_id')
    .in('product_id', idList)
  const sourced = new Set<string>((supData ?? []).map((s: any) => s.product_id))

  const nodes: NetNode[] = idList.map((id) => {
    const p = (byId.get(id) ?? {}) as any
    return {
      id,
      name: p.canonical_name ?? '?',
      category: p.category_top ?? 'all',
      final: finalById.get(id) ?? 0,
      sourced: sourced.has(id),
    }
  })

  const edges: NetEdge[] = cooc.map((c) => ({
    a: c.product_a,
    b: c.product_b,
    docCount: c.doc_count,
    breadth: c.source_breadth,
    pmi: c.pmi,
  }))

  return { nodes, edges }
}

export default async function CooccurrencePage() {
  const { nodes, edges } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">수요 공출현 네트워크</h1>
          <p className="text-sm text-gray-500 mt-1">
            한 글(뉴스·커뮤니티·트렌드) 안에서 함께 언급된 상품 쌍 · 노드=상품(크기=final_score) · 엣지=동시언급 강도(PMI 보정)
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {nodes.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 공출현 데이터 없음. <code>/api/cron/build-cooccurrence</code> 누적 후 다시 방문.
        </div>
      ) : (
        <CooccurrenceNetwork nodes={nodes} edges={edges} />
      )}
    </div>
  )
}
