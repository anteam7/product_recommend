/**
 * 등록 준비도(readiness) 산출 (cron).
 *
 * 흐름:
 *   1) jimscanner_trends_category_meta (쿠팡 메타 캐시) 로드
 *   2) jimscanner_trends_products 전체 + 각 product 의 supplier 콘텐츠 자산 집계
 *   3) computeReadiness 로 인증요구·필수속성·콘텐츠 자산 → readiness_score 산출
 *   4) jimscanner_trends_listing_readiness 에 새 row insert (시계열)
 *
 * 인증: CRON_SECRET (Authorization: Bearer ...)
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  computeReadiness,
  matchCategoryMeta,
  type CategoryMeta,
} from '@/lib/listing-readiness'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface SupplierRow {
  product_id: string
  url_image: string | null
  title: string | null
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // 신규 테이블 — generated types 부재로 any 캐스팅 (service-role)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any

  // 1) 카테고리 메타 캐시
  const { data: metaRows } = await sb
    .from('jimscanner_trends_category_meta')
    .select('display_category_code, name, notice_mandatory_count, attr_mandatory_count, cert_required, cert_names')
  const metas = (metaRows ?? []) as CategoryMeta[]

  // 2) 상품
  const { data: prodRows } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, category_mid')
  const products = (prodRows ?? []) as Array<{
    id: string
    canonical_name: string
    category_top: string | null
    category_mid: string | null
  }>

  if (products.length === 0) {
    return NextResponse.json({ ok: true, computed: 0, note: 'no products' })
  }

  // 3) supplier 콘텐츠 자산 집계 (product_id 별)
  const { data: supRows } = await sb
    .from('jimscanner_trends_supplier')
    .select('product_id, url_image, title')
  const byProduct = new Map<string, { count: number; withImage: number; withDetail: number }>()
  for (const s of (supRows ?? []) as SupplierRow[]) {
    const agg = byProduct.get(s.product_id) ?? { count: 0, withImage: 0, withDetail: 0 }
    agg.count += 1
    if (s.url_image && s.url_image.trim()) agg.withImage += 1
    if (s.title && s.title.trim().length >= 6) agg.withDetail += 1
    byProduct.set(s.product_id, agg)
  }

  // 4) 산출 + insert
  const computedAt = new Date().toISOString()
  const out: Array<Record<string, unknown>> = []
  for (const p of products) {
    const meta =
      matchCategoryMeta(p.category_mid ?? '', metas) ||
      matchCategoryMeta(p.canonical_name, metas)
    const agg = byProduct.get(p.id) ?? { count: 0, withImage: 0, withDetail: 0 }
    const r = computeReadiness({
      categoryTop: p.category_top,
      categoryMid: p.category_mid,
      canonicalName: p.canonical_name,
      meta,
      supplierCount: agg.count,
      supplierWithImage: agg.withImage,
      supplierWithDetail: agg.withDetail,
    })
    out.push({
      product_id: p.id,
      category_top: p.category_top,
      category_mid: p.category_mid,
      matched_category_code: r.matched_category_code,
      mandatory_attr_count: r.mandatory_attr_count,
      cert_required: r.cert_required,
      cert_type: r.cert_type,
      content_asset_score: r.content_asset_score,
      readiness_score: r.readiness_score,
      breakdown: r.breakdown,
      computed_at: computedAt,
    })
  }

  // 배치 insert (500 단위)
  let inserted = 0
  for (let i = 0; i < out.length; i += 500) {
    const chunk = out.slice(i, i + 500)
    const { error } = await sb.from('jimscanner_trends_listing_readiness').insert(chunk)
    if (!error) inserted += chunk.length
  }

  return NextResponse.json({
    ok: true,
    computed: out.length,
    inserted,
    metasLoaded: metas.length,
    executed_at: computedAt,
  })
}
