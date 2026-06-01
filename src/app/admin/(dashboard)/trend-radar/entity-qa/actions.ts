'use server'

import { createAdminClient } from '@/lib/auth/admin-supabase'
import { revalidatePath } from 'next/cache'

// generated 타입에 신규 RPC/컬럼 미반영 — `npm run gen:types` 후 `as any` 캐스팅 제거 가능.
type Sb = ReturnType<typeof createAdminClient>

const PAGE = '/admin/trend-radar/entity-qa'

async function recount(sb: Sb, productId: string) {
  const { count } = await sb
    .from('jimscanner_trends_aliases')
    .select('id', { count: 'exact', head: true })
    .eq('product_id', productId)
  await sb
    .from('jimscanner_trends_products')
    .update({ alias_count: count ?? 0 } as never)
    .eq('id', productId)
}

// 병합: source 의 모든 별칭을 target 으로 재할당 → source product 삭제(cascade).
// 분열(under-merge)·흡수(absorb) 액션 공용.
export async function mergeProducts(sourceId: string, targetId: string) {
  if (!sourceId || !targetId || sourceId === targetId) {
    return { ok: false, error: '동일하거나 빈 product' }
  }
  const sb = createAdminClient()

  const { error: e1 } = await sb
    .from('jimscanner_trends_aliases')
    .update({ product_id: targetId } as never)
    .eq('product_id', sourceId)
  if (e1) return { ok: false, error: e1.message }

  await recount(sb, targetId)

  // source 삭제 → 잔여 scores/supplier 는 FK cascade 로 정리(다음 recompute 시 재산출).
  const { error: e2 } = await sb
    .from('jimscanner_trends_products')
    .delete()
    .eq('id', sourceId)
  if (e2) return { ok: false, error: e2.message }

  revalidatePath(PAGE)
  return { ok: true }
}

// 과병합(over-merge) 분리: product 안에서 다른 별칭들과 가장 이질적인 별칭 1건을
// 떼어내 새 product 로 승격. 서버에서 토큰 자카드를 계산해 원클릭 split.
export async function splitWorstAlias(productId: string) {
  const sb = createAdminClient()

  const { data: prod, error: pe } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, category_mid, brand')
    .eq('id', productId)
    .single()
  if (pe || !prod) return { ok: false, error: pe?.message ?? 'product 없음' }

  const { data: aliasRows, error: ae } = await sb
    .from('jimscanner_trends_aliases')
    .select('id, alias')
    .eq('product_id', productId)
  if (ae) return { ok: false, error: ae.message }
  const aliases = (aliasRows ?? []) as { id: string; alias: string }[]
  if (aliases.length < 2) return { ok: false, error: '별칭이 2건 미만 — 분리 불가' }

  const tokenize = (t: string) =>
    new Set(
      (t || '')
        .toLowerCase()
        .split(/[^0-9a-z가-힣]+/)
        .filter((w) => w.length >= 2),
    )
  const jaccard = (a: Set<string>, b: Set<string>) => {
    if (!a.size || !b.size) return 0
    let inter = 0
    for (const t of a) if (b.has(t)) inter++
    return inter / (a.size + b.size - inter)
  }

  const toks = aliases.map((a) => tokenize(a.alias))
  // 각 별칭의 다른 별칭들에 대한 평균 유사도 → 최저(가장 이질적)를 분리.
  let worstIdx = 0
  let worstAvg = Infinity
  for (let i = 0; i < aliases.length; i++) {
    let sum = 0
    for (let j = 0; j < aliases.length; j++) if (i !== j) sum += jaccard(toks[i], toks[j])
    const avg = sum / (aliases.length - 1)
    if (avg < worstAvg) {
      worstAvg = avg
      worstIdx = i
    }
  }
  const worst = aliases[worstIdx]
  const p = prod as {
    canonical_name: string
    category_top: string
    category_mid: string | null
    brand: string | null
  }

  const { data: newProd, error: ie } = await sb
    .from('jimscanner_trends_products')
    .insert({
      canonical_name: worst.alias.slice(0, 200),
      category_top: p.category_top,
      category_mid: p.category_mid,
      brand: p.brand,
      alias_count: 1,
    } as never)
    .select('id')
    .single()
  if (ie || !newProd) return { ok: false, error: ie?.message ?? '새 product 생성 실패' }
  const newId = (newProd as { id: string }).id

  const { error: ue } = await sb
    .from('jimscanner_trends_aliases')
    .update({ product_id: newId, classified_by: 'manual', confidence: 1.0 } as never)
    .eq('id', worst.id)
  if (ue) return { ok: false, error: ue.message }

  await recount(sb, productId)
  await recount(sb, newId)

  revalidatePath(PAGE)
  return { ok: true, newId, alias: worst.alias }
}
