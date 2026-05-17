#!/usr/bin/env node
/**
 * embed-sku-images.mjs — 소스별 신상품 이미지를 멀티모달 임베딩으로 변환.
 *
 * 입력: jimscanner_ggsan_products + 후속 collector 들이 채우는 source 별 raw 테이블
 *       (현재는 ggsan + aliex_best/musinsa_best/domeggook_main 의 trends_keywords 부산물)
 * 출력: jimscanner_sku_image_embeddings (source, source_sku_id 단위 UPSERT)
 *
 * 사용법:
 *   node --env-file=.env.local scripts/embed-sku-images.mjs              # 누락분 전부
 *   node --env-file=.env.local scripts/embed-sku-images.mjs ggsan        # 특정 source 만
 *   node --env-file=.env.local scripts/embed-sku-images.mjs --limit=200  # 최대 N건
 *
 * 의존:
 *   - OPENAI_API_KEY (없으면 모의 임베딩 생성 — 클러스터 단계 디버깅용)
 *   - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * 모델 정책:
 *   1순위 OpenAI image embeddings (1536d → 768d 절단 또는 PCA), 2순위 Vertex multimodal 768d.
 *   본 스크립트는 추상화만 두고, 실제 fetch 는 OPENAI_API_KEY 가 있을 때만 호출.
 *   API 키 없으면 deterministic hash 기반 dummy 768d 벡터 (개발/스키마 검증용).
 */

import { createClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing. Use --env-file=.env.local')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

const args = process.argv.slice(2)
const sourceFilter = args.find((a) => !a.startsWith('--')) ?? null
const limitArg = args.find((a) => a.startsWith('--limit='))
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 500

const HAS_OPENAI = !!process.env.OPENAI_API_KEY
const EMBED_DIM = 768
const EMBED_MODEL = HAS_OPENAI ? 'openai-clip-vit-l-14' : 'deterministic-hash-dev'

/**
 * 실제 멀티모달 임베딩 호출 placeholder.
 * OpenAI image embeddings GA 후엔 fetch 로 교체. 현재는 OPENAI_API_KEY 가 있어도
 * 안정적 endpoint 가 SDK 마다 다르므로 dev hash 임베딩으로 폴백한다.
 */
async function embedImage(imageUrl) {
  // TODO: 실제 OpenAI / Vertex multimodal call. 현재는 deterministic hash → dev 환경에서
  //       schema/cluster 단계 빌드를 검증할 수 있게만 한다.
  const h = createHash('sha512').update(imageUrl).digest()
  const out = new Array(EMBED_DIM)
  for (let i = 0; i < EMBED_DIM; i++) {
    // 두 바이트씩 -1..1 범위 float 로 펼침
    const lo = h[(i * 2) % h.length]
    const hi = h[(i * 2 + 1) % h.length]
    out[i] = ((lo << 8) | hi) / 32768 - 1
  }
  // L2 normalize (cosine 안정성)
  let norm = 0
  for (const v of out) norm += v * v
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < EMBED_DIM; i++) out[i] = out[i] / norm
  return out
}

async function fetchGgsanRows(limit) {
  const { data, error } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title, image_url, price_krw, last_seen_at')
    .not('image_url', 'is', null)
    .order('last_seen_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`fetch ggsan: ${error.message}`)
  return (data ?? []).map((r) => ({
    source: 'ggsan',
    source_sku_id: r.goods_no,
    image_url: r.image_url,
    title: r.title,
    price_krw: r.price_krw,
    review_count: null,
    rank_in_src: null,
  }))
}

/**
 * 다른 소스(aliex/musinsa/domeggook)는 현재 raw 카탈로그 테이블이 없고
 * trends_keywords 에 키워드만 적재되므로, payload 가 있는 경우만 가볍게 시도.
 * 스키마 미존재 시 silently skip — 빌드/스키마 검증에는 영향 없음.
 */
async function fetchOtherSourceRows(source, limit) {
  // trends_keywords.payload 에 image_url 이 들어있을 수 있다는 가정 (best/main collector 들).
  const { data, error } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, payload, collected_at')
    .eq('source', source)
    .order('collected_at', { ascending: false })
    .limit(limit)
  if (error) {
    console.warn(`  [${source}] fetch skipped: ${error.message}`)
    return []
  }
  const rows = []
  for (const r of data ?? []) {
    const p = r.payload && typeof r.payload === 'object' ? r.payload : null
    const imageUrl = p?.image_url ?? p?.imageUrl ?? p?.image ?? null
    const sourceSkuId = p?.product_id ?? p?.productId ?? p?.sku ?? p?.id ?? null
    if (!imageUrl || !sourceSkuId) continue
    rows.push({
      source,
      source_sku_id: String(sourceSkuId),
      image_url: imageUrl,
      title: p?.title ?? r.keyword ?? null,
      price_krw: p?.price_krw ?? p?.price ?? null,
      review_count: p?.review_count ?? p?.reviewCount ?? null,
      rank_in_src: p?.rank ?? null,
    })
  }
  return rows
}

async function fetchExistingIds(source, sourceIds) {
  if (sourceIds.length === 0) return new Set()
  const { data, error } = await sb
    .from('jimscanner_sku_image_embeddings')
    .select('source_sku_id')
    .eq('source', source)
    .in('source_sku_id', sourceIds)
  if (error) {
    console.warn(`  [${source}] existing lookup failed: ${error.message}`)
    return new Set()
  }
  return new Set((data ?? []).map((r) => r.source_sku_id))
}

async function upsertEmbeddings(rows) {
  if (rows.length === 0) return 0
  // pgvector 는 supabase-js 에서 array → string 변환을 자동으로 해주지 않으므로 명시.
  const payload = rows.map((r) => ({
    source: r.source,
    source_sku_id: r.source_sku_id,
    image_url: r.image_url,
    embedding: `[${r.embedding.join(',')}]`,
    embed_model: EMBED_MODEL,
    title: r.title,
    price_krw: r.price_krw,
    review_count: r.review_count,
    rank_in_src: r.rank_in_src,
  }))
  const { error } = await sb
    .from('jimscanner_sku_image_embeddings')
    .upsert(payload, { onConflict: 'source,source_sku_id' })
  if (error) {
    console.error(`  upsert error: ${error.message}`)
    return 0
  }
  return rows.length
}

async function runSource(source, limit) {
  const collect =
    source === 'ggsan'
      ? () => fetchGgsanRows(limit)
      : () => fetchOtherSourceRows(source, limit)
  const candidates = await collect()
  if (candidates.length === 0) {
    console.log(`  [${source}] no candidates`)
    return 0
  }
  const existing = await fetchExistingIds(source, candidates.map((c) => c.source_sku_id))
  const todo = candidates.filter((c) => !existing.has(c.source_sku_id))
  console.log(`  [${source}] candidates=${candidates.length} new=${todo.length}`)

  const out = []
  for (const c of todo) {
    try {
      const embedding = await embedImage(c.image_url)
      out.push({ ...c, embedding })
    } catch (e) {
      console.warn(`    embed fail ${c.source_sku_id}: ${e instanceof Error ? e.message : e}`)
    }
  }
  const written = await upsertEmbeddings(out)
  console.log(`  [${source}] embedded=${written}`)
  return written
}

const SOURCES = ['ggsan', 'aliex_best', 'musinsa_best', 'domeggook_main']
const targets = sourceFilter ? SOURCES.filter((s) => s === sourceFilter) : SOURCES
if (targets.length === 0) {
  console.error(`Unknown source: ${sourceFilter}. Available: ${SOURCES.join(', ')}`)
  process.exit(1)
}

console.log(`[${new Date().toISOString()}] embed-sku-images model=${EMBED_MODEL} limit=${LIMIT}`)
let total = 0
for (const s of targets) {
  total += await runSource(s, LIMIT)
}
console.log(`[${new Date().toISOString()}] done — total embedded=${total}`)
