import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import NicheTree from './NicheTree'

export const dynamic = 'force-dynamic'

interface PivotRow {
  id: string
  parent_product_id: string
  pivot_axis: string
  pivot_value: string
  derived_query: string
  sub_competition: number | null
  sub_volume_est: number | null
  sub_intent: string | null
  score_delta: number | null
  details: any
  promoted_to_pin: boolean
  promoted_at: string | null
  classified_by: string | null
  computed_at: string
}

async function fetchData(productId: string) {
  const sb = createAdminClient()

  const { data: product, error: prodErr } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, category_mid, brand, intent_label, description, alias_count')
    .eq('id', productId)
    .maybeSingle()
  if (prodErr || !product) return null

  const { data: latestScore } = await sb
    .from('jimscanner_trends_scores')
    .select('final_score, trend_score, competition_score, commerce_score, supplier_score, computed_at')
    .eq('product_id', productId)
    .order('computed_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: pivots } = await sb
    .from('jimscanner_trends_niche_pivots' as any)
    .select('id, parent_product_id, pivot_axis, pivot_value, derived_query, sub_competition, sub_volume_est, sub_intent, score_delta, details, promoted_to_pin, promoted_at, classified_by, computed_at')
    .eq('parent_product_id', productId)
    .order('score_delta', { ascending: false, nullsFirst: false })

  return {
    product,
    latestScore,
    pivots: ((pivots as unknown) as PivotRow[]) ?? [],
  }
}

const AXIS_LABEL: Record<string, string> = {
  persona: '타겟 페르소나',
  usage_context: '사용 맥락',
  spec: '스펙축',
  channel: '채널',
  price_band: '가격대',
}

export default async function NicheDownPage({
  params,
}: {
  params: Promise<{ product_id: string }>
}) {
  const { product_id } = await params
  const data = await fetchData(product_id)
  if (!data) notFound()
  const { product, latestScore, pivots } = data

  // axis 별 그룹핑 — 트리: head → axis → leaf
  const byAxis = new Map<string, PivotRow[]>()
  for (const p of pivots) {
    const list = byAxis.get(p.pivot_axis) ?? []
    list.push(p)
    byAxis.set(p.pivot_axis, list)
  }
  for (const [k, list] of byAxis) {
    list.sort((a, b) => (b.score_delta ?? -999) - (a.score_delta ?? -999))
    byAxis.set(k, list)
  }

  const maxDelta = pivots.reduce<number | null>((m, p) => {
    if (p.score_delta == null) return m
    return m == null || p.score_delta > m ? p.score_delta : m
  }, null)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <Link
            href={`/admin/trend-radar/products/${product_id}`}
            className="text-sm text-gray-500 hover:text-black"
          >
            ← 상품 디테일
          </Link>
          <h1 className="text-2xl font-bold mt-1">Niche-Down: {product.canonical_name}</h1>
          <p className="text-sm text-gray-500 mt-1">
            head 키워드를 속성 피벗(타겟 페르소나 × 사용맥락 × 스펙축)으로 분기 → narrow-niche 쿼리 트리
          </p>
          <p className="text-xs text-gray-400 mt-1">
            카테고리: {product.category_top}
            {product.category_mid ? ` / ${product.category_mid}` : ''} · alias {product.alias_count}건
            {latestScore && (
              <>
                {' '}· parent final_score{' '}
                <span className="font-mono font-semibold text-black">{latestScore.final_score}</span>
              </>
            )}
          </p>
        </div>
      </header>

      {pivots.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 탐색된 피벗 없음</p>
          <p className="text-sm mt-2">
            로컬 WSL 에서{' '}
            <code className="px-1 bg-gray-100 rounded">
              node --env-file=.env.local scripts/niche-pivot-explore.mjs {product_id}
            </code>{' '}
            실행 → 5~8개 피벗 생성.
          </p>
        </div>
      ) : (
        <>
          {/* 트리: 부모 head → 축 → leaf */}
          <section className="space-y-4">
            <div className="rounded border-2 border-black p-4 bg-gray-50">
              <div className="text-xs text-gray-500 uppercase tracking-wide">parent head</div>
              <div className="text-lg font-bold">{product.canonical_name}</div>
              {latestScore && (
                <div className="text-xs text-gray-600 mt-1 font-mono">
                  final={latestScore.final_score} · trend={latestScore.trend_score} · comp={latestScore.competition_score}
                </div>
              )}
            </div>

            <NicheTree
              groups={[...byAxis.entries()].map(([axis, leaves]) => ({
                axis,
                axisLabel: AXIS_LABEL[axis] ?? axis,
                leaves: leaves.map((l) => ({
                  id: l.id,
                  pivot_value: l.pivot_value,
                  derived_query: l.derived_query,
                  sub_competition: l.sub_competition,
                  sub_volume_est: l.sub_volume_est,
                  sub_intent: l.sub_intent,
                  score_delta: l.score_delta,
                  promoted_to_pin: l.promoted_to_pin,
                  rationale: typeof l.details === 'object' && l.details ? (l.details.rationale ?? null) : null,
                  isBest: l.score_delta != null && maxDelta != null && l.score_delta === maxDelta,
                })),
              }))}
            />
          </section>

          <section className="text-xs text-gray-500 pt-4 border-t border-gray-100">
            총 {pivots.length}개 피벗 · {byAxis.size}개 축 · 최고 score_delta{' '}
            <span className="font-mono font-semibold">{maxDelta ?? '—'}</span> ·
            마지막 산출 {pivots[0]?.computed_at?.slice(0, 19).replace('T', ' ')}
          </section>
        </>
      )}
    </div>
  )
}
