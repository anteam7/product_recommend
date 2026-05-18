#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// 보완재 번들 후보 일배치
// ─────────────────────────────────────────────────────────────
// 동작:
//   1. anchor 후보 = 최신 final_score Top 30 (또는 --anchor=<id>)
//   2. 각 anchor 에 대해:
//      (a) 임베딩 코사인 0.55~0.80 구간의 다른 product 후보 (필드 미존재 시 skip)
//      (b) 동일 category_top + 다른 canonical_name
//      (c) 동일 intent_label 공유
//      (d) alias 풀에서 '같이|세트|추천' co-occurrence 검출
//   3. 가중합 score 산출, 묶음 마진/공급사/MOQ denorm 캐시
//   4. jimscanner_trends_bundle_candidates 에 upsert
//
// 사용:
//   node scripts/compute-bundle-candidates.mjs              # Top 30 앵커
//   node scripts/compute-bundle-candidates.mjs --anchor=ID  # 특정 앵커만
//   node scripts/compute-bundle-candidates.mjs --limit=10   # 앵커 수 제한
// ─────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const sb = createClient(url, key, { auth: { persistSession: false } })

// CLI args
const args = process.argv.slice(2).reduce((a, s) => {
  const m = s.match(/^--([^=]+)=(.*)$/)
  if (m) a[m[1]] = m[2]
  else if (s.startsWith('--')) a[s.slice(2)] = true
  return a
}, {})

const ANCHOR_LIMIT = Number(args.limit ?? 30)
const COMPLEMENT_TOP_N = 10

// ─── 가중치 (총합 1.0) ─────────────────────────────────────
const W = {
  embed: 0.40,      // 임베딩 0.55~0.80 구간 (없으면 0)
  category: 0.20,   // 동일 category_top
  persona: 0.20,    // 동일 intent_label
  cooccur: 0.20,    // 자동완성 co-occurrence
}

const COOCCUR_PATTERNS = ['같이', '세트', '추천', '함께']

// 임베딩 코사인 — embedding 컬럼이 존재할 때만 사용
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom > 0 ? dot / denom : 0
}

async function loadAnchors() {
  if (args.anchor) {
    const { data, error } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top, intent_label')
      .eq('id', args.anchor)
      .single()
    if (error || !data) throw new Error(`anchor not found: ${args.anchor}`)
    return [data]
  }

  // 최신 final_score Top N
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(2000)

  const latest = new Map()
  for (const s of scores ?? []) {
    if (!latest.has(s.product_id)) latest.set(s.product_id, s)
  }
  const top = [...latest.values()]
    .sort((a, b) => b.final_score - a.final_score)
    .slice(0, ANCHOR_LIMIT)

  if (top.length === 0) return []

  const { data: products } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, intent_label')
    .in('id', top.map((t) => t.product_id))

  return products ?? []
}

async function loadAllProducts() {
  // 후보 풀: 최근 lookup 가능 product 전부
  const { data, error } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, intent_label')
    .order('last_seen_at', { ascending: false })
    .limit(2000)
  if (error) throw error
  return data ?? []
}

async function loadAliases(productIds) {
  if (productIds.length === 0) return new Map()
  const { data } = await sb
    .from('jimscanner_trends_aliases')
    .select('product_id, alias')
    .in('product_id', productIds)
  const map = new Map()
  for (const a of data ?? []) {
    if (!map.has(a.product_id)) map.set(a.product_id, [])
    map.get(a.product_id).push(a.alias)
  }
  return map
}

async function loadEmbeddings(productIds) {
  // 임베딩 컬럼이 존재한다면 가져옴. 없으면 빈 맵.
  if (productIds.length === 0) return new Map()
  try {
    const { data, error } = await sb
      .from('jimscanner_trends_products')
      .select('id, embedding')
      .in('id', productIds)
    if (error) {
      console.warn(`[embedding] skip (컬럼 없음 또는 권한): ${error.message}`)
      return new Map()
    }
    const map = new Map()
    for (const r of data ?? []) {
      if (r.embedding) {
        // pgvector → string 또는 array 형식
        const vec = Array.isArray(r.embedding)
          ? r.embedding
          : typeof r.embedding === 'string'
            ? JSON.parse(r.embedding.replace(/^\(/, '[').replace(/\)$/, ']'))
            : null
        if (vec) map.set(r.id, vec)
      }
    }
    return map
  } catch (e) {
    console.warn(`[embedding] skip: ${e.message}`)
    return new Map()
  }
}

async function loadCheapestSupplier(productId) {
  const { data } = await sb
    .from('jimscanner_trends_supplier')
    .select('supplier_source, price_krw, moq')
    .eq('product_id', productId)
    .not('price_krw', 'is', null)
    .order('price_krw', { ascending: true })
    .limit(1)
  return data?.[0] ?? null
}

function detectCooccurrence(anchorAliases, compAliases) {
  // 'X 같이', 'X 세트' 등 — anchor alias 가 comp alias 에 등장 + 패턴 토큰 동반
  const hits = []
  const anchorTokens = (anchorAliases ?? []).flatMap((a) =>
    a.split(/\s+/).filter((t) => t.length >= 2),
  )
  for (const ca of compAliases ?? []) {
    for (const at of anchorTokens) {
      if (!ca.includes(at)) continue
      for (const pat of COOCCUR_PATTERNS) {
        if (ca.includes(pat)) {
          hits.push(ca)
          break
        }
      }
    }
  }
  return [...new Set(hits)].slice(0, 5)
}

function scoreComplement({ anchor, comp, anchorEmb, compEmb, anchorAliases, compAliases }) {
  const reasons = {}
  let total = 0

  // (a) 임베딩
  if (anchorEmb && compEmb) {
    const c = cosine(anchorEmb, compEmb)
    reasons.cosine = Number(c.toFixed(3))
    if (c >= 0.55 && c <= 0.80) {
      // 0.55~0.80 구간을 1 로 정규화 (가운데가 max)
      const center = 0.675
      const half = 0.125
      const norm = 1 - Math.abs(c - center) / half
      total += W.embed * norm
      reasons.embed_contrib = Number((W.embed * norm).toFixed(3))
    }
  }

  // (b) 동일 카테고리 + 다른 canonical_name
  if (
    anchor.category_top === comp.category_top &&
    anchor.canonical_name !== comp.canonical_name
  ) {
    reasons.category_match = true
    total += W.category
  }

  // (c) 페르소나 (intent_label) 공유
  if (
    anchor.intent_label &&
    comp.intent_label &&
    anchor.intent_label === comp.intent_label
  ) {
    reasons.persona_match = true
    total += W.persona
  }

  // (d) co-occurrence
  const cooccur = detectCooccurrence(anchorAliases, compAliases)
  if (cooccur.length > 0) {
    reasons.cooccurrence = cooccur
    // 매칭 개수에 따라 0~1
    const norm = Math.min(1, cooccur.length / 3)
    total += W.cooccur * norm
  }

  reasons.contrib = {
    embed: W.embed,
    category: W.category,
    persona: W.persona,
    cooccur: W.cooccur,
  }

  return { score: Number(total.toFixed(4)), reasons }
}

async function main() {
  console.log('🎁 보완재 번들 후보 산출 시작')
  const anchors = await loadAnchors()
  if (anchors.length === 0) {
    console.log('  앵커 후보 없음. 종료.')
    return
  }
  console.log(`  앵커 ${anchors.length}건`)

  const allProducts = await loadAllProducts()
  console.log(`  후보 풀: ${allProducts.length} product`)

  const allIds = [...new Set([...anchors.map((a) => a.id), ...allProducts.map((p) => p.id)])]
  const aliasMap = await loadAliases(allIds)
  const embMap = await loadEmbeddings(allIds)
  console.log(`  alias map: ${aliasMap.size}, embedding map: ${embMap.size}`)

  let totalInserted = 0
  for (const anchor of anchors) {
    const candidates = []
    for (const comp of allProducts) {
      if (comp.id === anchor.id) continue
      const { score, reasons } = scoreComplement({
        anchor,
        comp,
        anchorEmb: embMap.get(anchor.id),
        compEmb: embMap.get(comp.id),
        anchorAliases: aliasMap.get(anchor.id),
        compAliases: aliasMap.get(comp.id),
      })
      if (score > 0) candidates.push({ comp, score, reasons })
    }
    candidates.sort((a, b) => b.score - a.score)
    const top = candidates.slice(0, COMPLEMENT_TOP_N)

    if (top.length === 0) {
      console.log(`  · ${anchor.canonical_name}: 매칭 없음`)
      continue
    }

    // denorm: 최저 공급가 1건
    const rows = []
    for (const { comp, score, reasons } of top) {
      const cheapest = await loadCheapestSupplier(comp.id)
      rows.push({
        anchor_id: anchor.id,
        complement_id: comp.id,
        score,
        reasons,
        cheapest_supplier_source: cheapest?.supplier_source ?? null,
        cheapest_supplier_price_krw: cheapest?.price_krw ?? null,
        cheapest_supplier_moq: cheapest?.moq ?? null,
      })
    }

    // 기존 anchor row 삭제 후 일괄 insert (upsert 대안)
    const { error: delErr } = await sb
      .from('jimscanner_trends_bundle_candidates')
      .delete()
      .eq('anchor_id', anchor.id)
    if (delErr) {
      console.error(`  · ${anchor.canonical_name}: delete err = ${delErr.message}`)
      continue
    }
    const { error: insErr } = await sb
      .from('jimscanner_trends_bundle_candidates')
      .insert(rows)
    if (insErr) {
      console.error(`  · ${anchor.canonical_name}: insert err = ${insErr.message}`)
      continue
    }
    totalInserted += rows.length
    console.log(`  · ${anchor.canonical_name}: Top ${rows.length} 매칭 → 저장`)
  }

  console.log(`✅ 총 ${totalInserted}건 bundle candidate row 저장`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
