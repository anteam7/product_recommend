#!/usr/bin/env node
/**
 * 상품 패밀리(제품군) 추출기 — 룰 기반 v1 (2026-05-15).
 *
 * jimscanner_trends_products 의 canonical_name 1:1 row 들을
 * "본체(core) + 변형/액세서리(accessory)" 단위로 묶어
 * jimscanner_trends_product_families 에 root product family 를 만든다.
 *
 * Phase 1 룰 (LLM 없이):
 *   1) canonical_name 에서 액세서리 토큰을 떼어내고 base name 추출
 *      e.g. "샤오미 미밴드 10 스트랩" → base "샤오미 미밴드 10", role=accessory
 *      e.g. "샤오미 미밴드 10"        → base "샤오미 미밴드 10", role=core
 *   2) (base name, category_top) 로 family upsert
 *   3) product.family_id, product.variant_role 갱신
 *   4) family.variant_count / accessory_count / lead_variant_id 갱신
 *
 * Phase 2 (후속, 본 스크립트 범위 외):
 *   Gemma 호출로 base name 정규화 + brand 추출 보강.
 *
 * 호출:
 *   node --env-file=.env.local scripts/extract-product-families.mjs
 *   node --env-file=.env.local scripts/extract-product-families.mjs --dry-run
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

const DRY_RUN = process.argv.includes('--dry-run')

// 액세서리/변형 토큰 — 어휘는 운영 중 점진 보강.
// 매칭 시 양쪽 공백 또는 단어 경계로 인식 (한글 특성상 공백 분리 우선).
const ACCESSORY_TOKENS = [
  '스트랩', '밴드줄', '교체밴드',
  '필름', '보호필름', '강화유리', '강화필름',
  '케이스', '커버', '범퍼케이스', '파우치',
  '충전기', '충전케이블', '충전독', '충전 거치대', '거치대',
  '어댑터', '젠더',
  '리필', '교체용',
  '거치 홀더', '홀더',
  '액세서리', '악세사리',
]
const BUNDLE_TOKENS = ['세트', '묶음', '번들', '+증정', '2개입', '3개입']

// 잘 알려진 한국 시장 브랜드 prefix — 토큰 첫 단어가 매칭되면 brand 로.
const KNOWN_BRANDS = [
  '샤오미', '미밴드', '애플', '아이폰', '갤럭시', '삼성', '엘지', 'LG',
  '소니', '닌텐도', '다이슨', '필립스', '브라운', '오랄비',
  '나이키', '아디다스', '아식스', '뉴발란스',
  '닥터자르트', '메디힐', '이니스프리', '미샤',
]

function stripAccessory(name) {
  // 가장 긴 토큰부터 시도.
  const sorted = [...ACCESSORY_TOKENS].sort((a, b) => b.length - a.length)
  for (const tok of sorted) {
    // 공백 + 토큰 (끝), 또는 토큰 (끝)
    const re = new RegExp(`(^|\\s)${escapeRegex(tok)}\\s*$`, 'u')
    if (re.test(name)) {
      const base = name.replace(re, '').trim()
      if (base.length >= 2) return { base, role: 'accessory', strippedToken: tok }
    }
  }
  return null
}

function detectBundle(name) {
  for (const tok of BUNDLE_TOKENS) {
    if (name.includes(tok)) return tok
  }
  return null
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function detectBrand(name) {
  const tokens = name.split(/\s+/u)
  if (tokens.length === 0) return null
  for (const t of tokens.slice(0, 2)) {
    if (KNOWN_BRANDS.includes(t)) return t
  }
  return null
}

function classifyProduct(p) {
  const name = (p.canonical_name || '').trim()
  if (!name) return null

  const acc = stripAccessory(name)
  if (acc) {
    return {
      base: acc.base,
      role: 'accessory',
      brand: detectBrand(acc.base) ?? p.brand ?? null,
    }
  }
  const bundleTok = detectBundle(name)
  if (bundleTok) {
    // 묶음/세트 — base 는 토큰을 떼고 사용, 매핑 안 되면 자기 자신.
    const base = name.replace(new RegExp(escapeRegex(bundleTok), 'gu'), '').replace(/\s+/g, ' ').trim()
    return {
      base: base || name,
      role: 'bundle',
      brand: detectBrand(base || name) ?? p.brand ?? null,
    }
  }
  return {
    base: name,
    role: 'core',
    brand: detectBrand(name) ?? p.brand ?? null,
  }
}

async function fetchProducts() {
  const all = []
  let from = 0
  const PAGE = 500
  while (true) {
    const { data, error } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top, category_mid, brand, family_id, variant_role')
      .order('updated_at', { ascending: false })
      .range(from, from + PAGE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }
  return all
}

async function upsertFamily({ rootName, categoryTop, brand, accessoryToken }) {
  // 기존 family 조회
  const { data: existing } = await sb
    .from('jimscanner_trends_product_families')
    .select('id, normalized_aliases')
    .eq('root_name', rootName)
    .eq('category_top', categoryTop)
    .maybeSingle()

  if (existing?.id) {
    const aliases = existing.normalized_aliases ?? {}
    if (accessoryToken) {
      const tokens = new Set(aliases.accessory_tokens ?? [])
      tokens.add(accessoryToken)
      aliases.accessory_tokens = [...tokens]
      if (!DRY_RUN) {
        await sb
          .from('jimscanner_trends_product_families')
          .update({ normalized_aliases: aliases, last_seen_at: new Date().toISOString() })
          .eq('id', existing.id)
      }
    }
    return existing.id
  }

  const normalized_aliases = {
    core: [rootName],
    accessory_tokens: accessoryToken ? [accessoryToken] : [],
  }

  if (DRY_RUN) return null
  const { data, error } = await sb
    .from('jimscanner_trends_product_families')
    .insert({
      root_name: rootName,
      root_brand: brand,
      category_top: categoryTop,
      normalized_aliases,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

async function main() {
  const products = await fetchProducts()
  console.log(`Loaded ${products.length} products`)

  let mapped = 0
  let accCount = 0
  let coreCount = 0
  let bundleCount = 0
  const familyVariantCounts = new Map() // familyId -> { variant, accessory, core }

  for (const p of products) {
    const cls = classifyProduct(p)
    if (!cls) continue
    const fid = await upsertFamily({
      rootName: cls.base,
      categoryTop: p.category_top,
      brand: cls.brand,
      accessoryToken: cls.role === 'accessory' ? cls.base.split(' ').pop() : null,
    })
    if (!fid && !DRY_RUN) continue

    if (cls.role === 'accessory') accCount++
    else if (cls.role === 'bundle') bundleCount++
    else coreCount++

    if (!DRY_RUN && fid) {
      const { error } = await sb
        .from('jimscanner_trends_products')
        .update({ family_id: fid, variant_role: cls.role })
        .eq('id', p.id)
      if (error) {
        console.warn('product update fail', p.id, error.message)
        continue
      }
      const c = familyVariantCounts.get(fid) ?? { variant: 0, accessory: 0, core: 0 }
      c.variant++
      if (cls.role === 'accessory') c.accessory++
      if (cls.role === 'core') c.core++
      familyVariantCounts.set(fid, c)
      mapped++
    }
  }

  // family cache 갱신
  if (!DRY_RUN) {
    for (const [fid, c] of familyVariantCounts) {
      await sb
        .from('jimscanner_trends_product_families')
        .update({
          variant_count: c.variant,
          accessory_count: c.accessory,
          last_aggregated_at: new Date().toISOString(),
        })
        .eq('id', fid)
    }
  }

  console.log(JSON.stringify({
    products: products.length,
    mapped,
    core: coreCount,
    accessory: accCount,
    bundle: bundleCount,
    families_touched: familyVariantCounts.size,
    dry_run: DRY_RUN,
  }, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
