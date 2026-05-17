import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import PortfolioBoard, { type Asset } from './PortfolioBoard'

export const dynamic = 'force-dynamic'

interface RpcRow {
  asset_key: string
  display_name: string
  category_top: string | null
  is_pinned: boolean
  final_score: number
  trend_score: number
  commerce_score: number
  supplier_score: number
  expected_margin_krw: number
  expected_demand: number
  demand_variance: number
  capital_required: number
  ggsan_goods_no: string | null
  ggsan_price_krw: number | null
  ggsan_title: string | null
}

async function fetchAssets(): Promise<Asset[]> {
  const sb = createAdminClient()

  // RPC 가 아직 DB 에 배포되지 않을 수 있어 폴백 경로 포함
  // (마이그레이션: supabase/portfolio_frontier_rpc.sql)
  const rpc = await sb.rpc('jimscanner_portfolio_frontier' as any, {
    budget: 1000000,
    top_k: 30,
    days_window: 30,
    moq: 10,
  } as any)

  if (!rpc.error && Array.isArray(rpc.data)) {
    return (rpc.data as RpcRow[]).map(toAsset)
  }

  // ── 폴백: RPC 미배포 시 JS 측에서 동일한 인풋 구성 ──
  const { data: latestRows } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, trend_score, commerce_score, supplier_score, final_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(2000)

  const seen = new Set<string>()
  const latestMap = new Map<string, RpcRow & { product_id: string }>()
  for (const s of (latestRows ?? []) as any[]) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latestMap.set(s.product_id, {
      asset_key: s.product_id,
      display_name: '',
      category_top: null,
      is_pinned: false,
      final_score: s.final_score,
      trend_score: s.trend_score,
      commerce_score: s.commerce_score,
      supplier_score: s.supplier_score,
      expected_margin_krw: s.final_score * 200,
      expected_demand: (s.trend_score + s.commerce_score) / 2,
      demand_variance: 64,
      capital_required: 500000,
      ggsan_goods_no: null,
      ggsan_price_krw: null,
      ggsan_title: null,
      product_id: s.product_id,
    })
  }
  const pids = [...latestMap.keys()]
  if (pids.length === 0) return []

  const top = [...latestMap.values()]
    .sort((a, b) => b.final_score - a.final_score)
    .slice(0, 30)

  const { data: products } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', top.map((t) => t.asset_key))

  const pmap = new Map((products ?? []).map((p: any) => [p.id, p]))

  // stddev — 모든 점수 row 모아 product 별 표준편차
  const { data: histRows } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .in('product_id', top.map((t) => t.asset_key))
    .order('computed_at', { ascending: false })
    .limit(5000)

  const hist: Record<string, number[]> = {}
  for (const r of (histRows ?? []) as any[]) {
    ;(hist[r.product_id] ??= []).push(r.final_score)
  }

  const { data: pins } = await sb.from('jimscanner_trends_pins').select('keyword')
  const pinSet = new Set((pins ?? []).map((p: any) => p.keyword.toLowerCase()))

  return top
    .map((t) => {
      const p: any = pmap.get(t.asset_key)
      const hs = hist[t.asset_key] ?? []
      const std = hs.length > 1 ? stddev(hs) : 8
      return {
        ...t,
        display_name: p?.canonical_name ?? t.asset_key.slice(0, 8),
        category_top: p?.category_top ?? null,
        is_pinned: p?.canonical_name ? pinSet.has(p.canonical_name.toLowerCase()) : false,
        demand_variance: std * std,
      }
    })
    .map(toAsset)
}

function stddev(xs: number[]) {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)
  return Math.sqrt(v)
}

function toAsset(r: RpcRow): Asset {
  return {
    key: r.asset_key,
    name: r.display_name || r.ggsan_title || r.asset_key.slice(0, 8),
    category: r.category_top ?? '—',
    pinned: !!r.is_pinned,
    finalScore: r.final_score ?? 0,
    expectedMargin: Math.max(0, r.expected_margin_krw ?? 0),
    expectedDemand: Math.max(0, Math.min(100, r.expected_demand ?? 0)),
    variance: Math.max(1, r.demand_variance ?? 64),
    capital: Math.max(10000, r.capital_required ?? 50000),
    ggsanGoodsNo: r.ggsan_goods_no,
    ggsanPriceKrw: r.ggsan_price_krw,
  }
}

export default async function PortfolioPage() {
  const assets = await fetchAssets()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">💰 핀 포트폴리오 프론티어</h1>
          <p className="text-sm text-gray-500 mt-1">
            제한된 자본으로 어떤 N개 조합을 동시에 진입할지 — Markowitz mean-variance optimizer.
            <br />
            기대 마진 vs 분산(리스크) 산점도 + 효율적 프론티어 곡선.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {assets.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">후보 없음</p>
          <p className="text-sm mt-2">
            jimscanner_trends_scores 가 비어 있거나 RPC 미배포 상태입니다.
            <br />
            <code className="ml-1 px-1 bg-gray-100 rounded text-xs">
              supabase/portfolio_frontier_rpc.sql
            </code>{' '}
            적용 후 다시 시도.
          </p>
        </div>
      ) : (
        <PortfolioBoard assets={assets} />
      )}
    </div>
  )
}
