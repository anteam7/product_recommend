import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import OpportunityTreemap, { type TNode, type CoverageEntry } from './OpportunityTreemap'

export const dynamic = 'force-dynamic'

interface ScoreRow {
  product_id: string
  trend_score: number
  competition_score: number
  final_score: number
  computed_at: string
}

interface ProdRow {
  id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
}

// 상품명 ↔ 내 카탈로그 매칭용 정규화 (공백/기호 제거)
function norm(s: string): string {
  return s.toLowerCase().replace(/[\s\-_/()[\]]+/g, '')
}

async function fetchData() {
  const sb = createAdminClient()

  // 최신 score (product_id 별 latest)
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, trend_score, competition_score, final_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(4000)

  const seen = new Set<string>()
  const latest: ScoreRow[] = []
  for (const s of (scores ?? []) as ScoreRow[]) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latest.push(s)
  }
  const byScore = new Map(latest.map((s) => [s.product_id, s]))

  const ids = latest.map((s) => s.product_id)
  if (ids.length === 0) return { roots: [] as TNode[], coverage: [] as CoverageEntry[] }

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, category_mid')
    .in('id', ids)

  // 내 쿠팡 카탈로그 등록 상품명 (커버리지 판정용)
  // 신규/캐스팅 테이블 — generated types 갱신 전까지 any 캐스팅
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sbAny = sb as any
  const { data: listings } = await sbAny
    .from('jimscanner_coupang_listings')
    .select('registered_title')
    .limit(2000)
  const catalogTitles = ((listings ?? []) as { registered_title: string | null }[])
    .map((l) => norm(l.registered_title ?? ''))
    .filter(Boolean)
  const isCovered = (name: string) => {
    const n = norm(name)
    if (n.length < 2) return false
    return catalogTitles.some((t) => t.includes(n) || n.includes(t))
  }

  // ── 계층 집계: category_top → category_mid → product(leaf)
  type MidAcc = { name: string; leaves: TNode[]; demand: number; oppSum: number; oppN: number }
  type TopAcc = {
    name: string
    mids: Map<string, MidAcc>
    demand: number
    oppSum: number
    oppN: number
    total: number
    covered: number
  }
  const tops = new Map<string, TopAcc>()

  for (const p of (prods ?? []) as ProdRow[]) {
    const s = byScore.get(p.id)
    if (!s) continue
    const topName = p.category_top || 'all'
    const midName = p.category_mid || '(미분류)'
    // 수요 규모 proxy = trend_score (없으면 1), 기회도 = final_score
    const demand = Math.max(s.trend_score ?? 0, 1)
    const opp = s.final_score ?? 0

    let top = tops.get(topName)
    if (!top) {
      top = { name: topName, mids: new Map(), demand: 0, oppSum: 0, oppN: 0, total: 0, covered: 0 }
      tops.set(topName, top)
    }
    let mid = top.mids.get(midName)
    if (!mid) {
      mid = { name: midName, leaves: [], demand: 0, oppSum: 0, oppN: 0 }
      top.mids.set(midName, mid)
    }
    mid.leaves.push({ id: p.id, name: p.canonical_name, value: demand, opp, isLeaf: true })
    mid.demand += demand
    mid.oppSum += opp
    mid.oppN += 1

    top.demand += demand
    top.oppSum += opp
    top.oppN += 1
    top.total += 1
    if (isCovered(p.canonical_name)) top.covered += 1
  }

  const roots: TNode[] = Array.from(tops.values())
    .map((top) => ({
      id: `top:${top.name}`,
      name: top.name,
      value: top.demand,
      opp: top.oppN ? top.oppSum / top.oppN : 0,
      isLeaf: false,
      children: Array.from(top.mids.values())
        .map((mid) => ({
          id: `mid:${top.name}:${mid.name}`,
          name: mid.name,
          value: mid.demand,
          opp: mid.oppN ? mid.oppSum / mid.oppN : 0,
          isLeaf: false,
          children: mid.leaves.sort((a, b) => b.value - a.value),
        }))
        .sort((a, b) => b.value - a.value),
    }))
    .sort((a, b) => b.value - a.value)

  const coverage: CoverageEntry[] = Array.from(tops.values())
    .map((t) => ({ top: t.name, total: t.total, covered: t.covered, value: t.demand }))
    .sort((a, b) => b.value - a.value)

  return { roots, coverage }
}

export default async function TreemapPage() {
  const { roots, coverage } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">기회 트리맵</h1>
          <p className="text-sm text-gray-500 mt-1">
            카테고리 계층(대분류 → 중분류 → 상품)으로 수요·기회를 면적·색에 압축 ·
            &lsquo;어느 덩어리를 칠지&rsquo;를 SKU 이전에 결정
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {roots.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 데이터 없음. cron 누적 후 다시 방문.
        </div>
      ) : (
        <OpportunityTreemap roots={roots} coverage={coverage} />
      )}
    </div>
  )
}
