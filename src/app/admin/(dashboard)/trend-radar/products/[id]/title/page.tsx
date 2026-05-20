import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import TitleOptimizerClient from './TitleOptimizerClient'

export const dynamic = 'force-dynamic'

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  brand: string | null
  description: string | null
  intent_label: string | null
}

interface CandidateRow {
  id: string
  batch_id: string
  title: string
  score: number
  covered_keywords: string[]
  covered_volume: number
  char_len: number
  blocked_terms: string[]
  notes: string | null
  llm_model: string | null
  generated_at: string
}

interface PinnedRow {
  candidate_id: string | null
  title: string
  char_len: number
  covered_keywords: string[]
  pinned_by: string | null
  pinned_at: string
}

async function fetchData(id: string) {
  const sb = createAdminClient()

  const { data: product, error: prodErr } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, category_mid, brand, description, intent_label')
    .eq('id', id)
    .single()
  if (prodErr || !product) return null

  // 새 테이블 → as any
  const { data: candRaw } = await (sb as any)
    .from('jimscanner_listing_title_candidates')
    .select(
      'id, batch_id, title, score, covered_keywords, covered_volume, char_len, blocked_terms, notes, llm_model, generated_at',
    )
    .eq('product_id', id)
    .order('generated_at', { ascending: false })
    .limit(24)

  const { data: pinnedRaw } = await (sb as any)
    .from('jimscanner_listing_title_pinned')
    .select('candidate_id, title, char_len, covered_keywords, pinned_by, pinned_at')
    .eq('product_id', id)
    .maybeSingle()

  return {
    product: product as ProductRow,
    candidates: (candRaw ?? []) as CandidateRow[],
    pinned: (pinnedRaw ?? null) as PinnedRow | null,
  }
}

export default async function TitleOptimizerPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const data = await fetchData(id)
  if (!data) notFound()
  const { product, candidates, pinned } = data

  // 최신 batch 만 화면에 강조
  const latestBatch = candidates[0]?.batch_id
  const latest = candidates.filter((c) => c.batch_id === latestBatch)
  const older = candidates.filter((c) => c.batch_id !== latestBatch)

  return (
    <div className="space-y-6 p-6">
      <header>
        <Link
          href={`/admin/trend-radar/products/${id}`}
          className="text-sm text-gray-500 hover:text-black"
        >
          ← {product.canonical_name}
        </Link>
        <h1 className="text-2xl font-bold mt-1">리스팅 제목 옵티마이저</h1>
        <p className="text-sm text-gray-500 mt-1">
          50자 SEO 제목 후보 생성 · 카테고리 {product.category_top}
          {product.category_mid ? ` / ${product.category_mid}` : ''}
          {product.intent_label ? ` · intent ${product.intent_label}` : ''}
        </p>
      </header>

      {pinned && (
        <section className="rounded border border-emerald-300 bg-emerald-50 p-4">
          <div className="text-xs uppercase text-emerald-700 font-semibold">
            현재 선택된 제목
          </div>
          <div className="mt-1 text-lg font-semibold text-emerald-900">
            {pinned.title}
          </div>
          <div className="mt-1 text-xs text-emerald-700">
            {pinned.char_len}자 · 커버 {pinned.covered_keywords?.length ?? 0}개 키워드
            {pinned.pinned_by ? ` · ${pinned.pinned_by}` : ''}
            {pinned.pinned_at ? ` · ${pinned.pinned_at.slice(0, 19).replace('T', ' ')}` : ''}
          </div>
        </section>
      )}

      <TitleOptimizerClient
        productId={id}
        initialLatest={latest}
        initialOlder={older}
        initialPinnedCandidateId={pinned?.candidate_id ?? null}
      />
    </div>
  )
}
