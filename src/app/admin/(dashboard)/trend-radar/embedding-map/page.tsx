import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import EmbeddingMap, { type EmbPoint } from './EmbeddingMap'

export const dynamic = 'force-dynamic'

interface EmbRow {
  product_id: string
  vec_x: number
  vec_y: number
  vec_prev_x: number | null
  vec_prev_y: number | null
  cluster_id: number
  cluster_label: string | null
  cluster_momentum: number
  computed_at: string
}

async function fetchEmbeddings() {
  const sb = createAdminClient()

  // jimscanner_trends_embeddings 는 신규 마이그레이션 (trends_v4_embeddings.sql).
  // 코드는 마이그레이션 적용된 상태를 가정 — 적용 전엔 빈 결과 + 안내 노출.
  const { data: embData, error } = await (sb as any)
    .from('jimscanner_trends_embeddings')
    .select('product_id, vec_x, vec_y, vec_prev_x, vec_prev_y, cluster_id, cluster_label, cluster_momentum, computed_at')
    .order('cluster_id', { ascending: true })
    .limit(2000)

  if (error || !embData || embData.length === 0) {
    return { points: [] as EmbPoint[], computedAt: null as string | null, missing: !!error }
  }

  const embeds = embData as EmbRow[]
  const ids = embeds.map((e) => e.product_id)

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const prodById = new Map((prods ?? []).map((p: any) => [p.id, p]))

  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .in('product_id', ids)
    .order('computed_at', { ascending: false })
    .limit(5000)
  const scoreById = new Map<string, number>()
  for (const s of (scores ?? []) as any[]) {
    if (!scoreById.has(s.product_id)) scoreById.set(s.product_id, s.final_score)
  }

  const points: EmbPoint[] = embeds.map((e) => {
    const p = prodById.get(e.product_id) as any
    return {
      id: e.product_id,
      name: p?.canonical_name ?? '?',
      category: p?.category_top ?? 'all',
      cluster_id: e.cluster_id,
      cluster_label: e.cluster_label ?? '',
      cluster_momentum: Number(e.cluster_momentum ?? 0),
      final: scoreById.get(e.product_id) ?? 0,
      vec_x: Number(e.vec_x),
      vec_y: Number(e.vec_y),
      vec_prev_x: e.vec_prev_x == null ? null : Number(e.vec_prev_x),
      vec_prev_y: e.vec_prev_y == null ? null : Number(e.vec_prev_y),
    }
  })

  const computedAt = embeds.reduce<string | null>((acc, e) => (acc && acc > e.computed_at ? acc : e.computed_at), null)

  return { points, computedAt, missing: false }
}

export default async function EmbeddingMapPage() {
  const { points, computedAt, missing } = await fetchEmbeddings()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">트렌드 신호 임베딩 맵</h1>
          <p className="text-sm text-gray-500 mt-1">
            다차원 시그널(4점수 + 소스별 언급량 + 가격대 + supplier 다양성 + 카테고리) → 2D UMAP + HDBSCAN
            클러스터링. 묶음(니치) 단위 모멘텀 식별.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Link
            href="/admin/trend-radar"
            className="text-sm text-gray-700 hover:text-black underline"
          >
            ← 대시보드
          </Link>
          {computedAt && (
            <span className="text-xs text-gray-400">
              산출: {new Date(computedAt).toLocaleString('ko-KR')}
            </span>
          )}
        </div>
      </header>

      {points.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-3">
          <p className="text-base font-medium">아직 임베딩 좌표가 없습니다</p>
          <p className="text-sm">
            {missing
              ? '테이블이 아직 적용되지 않았습니다. supabase/trends_v4_embeddings.sql 마이그레이션 적용 후 산출 스크립트를 실행하세요.'
              : '주1회 산출 스크립트가 아직 실행되지 않았습니다.'}
          </p>
          <p className="text-xs text-gray-400 font-mono">
            python scripts/recompute-embeddings.py
          </p>
          <p className="text-xs text-gray-400">
            의존성:{' '}
            <code className="px-1 bg-gray-100 rounded">
              pip install supabase sentence-transformers umap-learn hdbscan numpy
            </code>
          </p>
        </div>
      ) : (
        <EmbeddingMap points={points} />
      )}
    </div>
  )
}
