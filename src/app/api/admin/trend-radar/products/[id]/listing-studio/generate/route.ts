/**
 * Listing Studio — 핀 상품 SEO 상세페이지 1클릭 초안 생성.
 *
 * 입력: product_id (URL path)
 * 처리:
 *   1) jimscanner_trends_products + aliases + 최근 score + supplier rows 수집
 *   2) 컨텍스트로 (title_short, title_long, tags, detail_md, thumb_hook) 5종 초안 생성
 *      (현 버전은 rule_engine_v1 — 누적된 시그널을 결정론적 템플릿으로 조립.
 *       LLM 호출은 운영자가 ANTHROPIC_API_KEY 등록 후 후속 PR 에서 스왑.)
 *   3) jimscanner_listing_drafts 에 variant_idx 증가시켜 저장
 *   4) 매칭되는 jimscanner_trends_pins.listing_status='drafted' 로 갱신
 *
 * 반환: { ok, variantIdx, drafts: { kind: content_md }[] }
 */
import { NextResponse } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { buildListingDrafts } from '@/lib/listing-studio/generate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: productId } = await params

  const userSb = await createClient()
  const {
    data: { user },
  } = await userSb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  // 1) 컨텍스트 수집
  const [prodRes, aliasRes, scoreRes, supplierRes] = await Promise.all([
    admin.from('jimscanner_trends_products').select('*').eq('id', productId).single(),
    admin
      .from('jimscanner_trends_aliases')
      .select('alias, alias_type, source, confidence')
      .eq('product_id', productId)
      .order('confidence', { ascending: false })
      .limit(30),
    admin
      .from('jimscanner_trends_scores')
      .select('trend_score, commerce_score, supplier_score, competition_score, final_score, score_components, computed_at')
      .eq('product_id', productId)
      .order('computed_at', { ascending: false })
      .limit(1),
    admin
      .from('jimscanner_trends_supplier')
      .select('supplier_source, title, price_krw, moq, lead_time_days, url_image, supplier_url')
      .eq('product_id', productId)
      .order('collected_at', { ascending: false })
      .limit(10),
  ])

  if (prodRes.error || !prodRes.data) {
    return NextResponse.json({ error: 'product_not_found' }, { status: 404 })
  }

  const product = prodRes.data
  const aliases = aliasRes.data ?? []
  const latestScore = (scoreRes.data ?? [])[0] ?? null
  const suppliers = supplierRes.data ?? []

  // 2) 초안 조립
  const { drafts, snapshot } = buildListingDrafts({
    product,
    aliases,
    latestScore,
    suppliers,
  })

  // 3) 다음 variant_idx 계산
  const { data: lastVariant } = await (admin as any)
    .from('jimscanner_listing_drafts')
    .select('variant_idx')
    .eq('product_id', productId)
    .order('variant_idx', { ascending: false })
    .limit(1)
    .maybeSingle()
  const variantIdx = ((lastVariant?.variant_idx as number | undefined) ?? 0) + 1

  // 4) 5종 초안을 한 번에 insert
  const rows = drafts.map((d) => ({
    product_id: productId,
    variant_idx: variantIdx,
    kind: d.kind,
    content_md: d.content_md,
    score_payload_snapshot: snapshot,
    llm_model: 'rule_engine_v1',
  }))

  const { error: insErr } = await (admin as any).from('jimscanner_listing_drafts').insert(rows)
  if (insErr) {
    return NextResponse.json({ error: insErr.message }, { status: 500 })
  }

  // 5) 매칭 핀 listing_status 업데이트 (alias 와 keyword 일치 또는 listing_product_id 직결)
  const aliasKeywords = Array.from(
    new Set(
      [product.canonical_name, ...aliases.map((a) => a.alias)].filter(Boolean) as string[],
    ),
  )
  if (aliasKeywords.length > 0) {
    await (admin as any)
      .from('jimscanner_trends_pins')
      .update({ listing_status: 'drafted', listing_product_id: productId })
      .in('keyword', aliasKeywords)
  }
  await (admin as any)
    .from('jimscanner_trends_pins')
    .update({ listing_status: 'drafted' })
    .eq('listing_product_id', productId)

  return NextResponse.json({
    ok: true,
    variantIdx,
    drafts,
  })
}
