#!/usr/bin/env node
/**
 * Naver SERP raw payload 에서 product 별 thumbnail URL 을 추출하고,
 * CLIP/SigLIP API 로 임베딩을 만들어 jimscanner_trends_product_images 에 적재한다.
 *
 * 사용법:
 *   node --env-file=.env.local scripts/embed-product-images.mjs                # 신규만 (limit 100)
 *   node --env-file=.env.local scripts/embed-product-images.mjs --limit 500
 *   node --env-file=.env.local scripts/embed-product-images.mjs --rebuild      # 전체 재임베딩
 *
 * 환경변수:
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (필수)
 *   REPLICATE_API_TOKEN  (선택 — Replicate CLIP 호출)
 *   HF_API_TOKEN         (선택 — Hugging Face SigLIP 호출)
 *
 * 토큰이 없으면 dry-run 모드로 thumbnail URL 추출까지만 수행하고 embedding 컬럼은
 * NULL 로 둔다. 운영자가 추후 토큰 등록 후 동일 row 를 다시 처리.
 */

import { createClient } from '@supabase/supabase-js'

const args = process.argv.slice(2)
const REBUILD = args.includes('--rebuild')
const LIMIT = (() => {
  const i = args.indexOf('--limit')
  if (i >= 0 && args[i + 1]) return parseInt(args[i + 1], 10)
  return 100
})()

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN
const HF_TOKEN = process.env.HF_API_TOKEN
const HAS_EMBEDDER = Boolean(REPLICATE_TOKEN || HF_TOKEN)
const EMBED_MODEL = REPLICATE_TOKEN ? 'clip-vit-b-32' : HF_TOKEN ? 'siglip-so400m' : null

console.log(`[embed-product-images] mode=${HAS_EMBEDDER ? 'embed' : 'dry-run'} model=${EMBED_MODEL ?? 'none'} limit=${LIMIT} rebuild=${REBUILD}`)

// ─────────────────────────────────────────────────────────────
// 1) 최근 raw payload 에서 thumbnail URL 추출 → product_images upsert
// ─────────────────────────────────────────────────────────────
async function extractThumbnailsFromRaw() {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString()
  const { data: rawRows, error } = await sb
    .from('jimscanner_trends_raw')
    .select('source, payload, collected_at')
    .in('source', ['naver_shopping_serp', 'naver_shopping_related'])
    .gte('collected_at', since)
    .limit(2000)
  if (error) { console.warn('[raw fetch]', error.message); return [] }

  const candidates = []
  for (const row of rawRows ?? []) {
    const items = extractItems(row.payload)
    for (const it of items) {
      const title = (it.title || it.name || '').replace(/<[^>]+>/g, '').trim()
      const image = it.image || it.thumbnail || it.thumbUrl || it.imageUrl
      if (!title || !image) continue
      candidates.push({ alias: title.toLowerCase(), image, source: row.source })
    }
  }
  return candidates
}

function extractItems(payload) {
  if (!payload || typeof payload !== 'object') return []
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload.items)) return payload.items
  if (Array.isArray(payload.products)) return payload.products
  if (Array.isArray(payload.results)) return payload.results
  if (payload.data && Array.isArray(payload.data.items)) return payload.data.items
  return []
}

async function linkImagesToProducts(candidates) {
  if (candidates.length === 0) return 0
  // alias 텍스트로 product_id 매핑 (단순 join, alias 테이블 통해)
  const aliases = [...new Set(candidates.map((c) => c.alias))]
  const { data: aliasRows } = await sb
    .from('jimscanner_trends_aliases')
    .select('product_id, alias')
    .in('alias', aliases)
  const aliasMap = new Map((aliasRows ?? []).map((r) => [r.alias, r.product_id]))

  const rows = []
  const seen = new Set()
  for (const c of candidates) {
    const pid = aliasMap.get(c.alias)
    if (!pid) continue
    const key = `${pid}::${c.image}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({ product_id: pid, image_url: c.image, source: c.source })
  }
  if (rows.length === 0) return 0

  const { error } = await sb
    .from('jimscanner_trends_product_images')
    .upsert(rows, { onConflict: 'product_id,image_url', ignoreDuplicates: true })
  if (error) {
    console.warn('[upsert images]', error.message)
    return 0
  }
  console.log(`[extract] linked ${rows.length} (product, image) pairs from raw payload`)
  return rows.length
}

// ─────────────────────────────────────────────────────────────
// 2) embedding 미생성 row 처리
// ─────────────────────────────────────────────────────────────
async function embedPending() {
  const query = sb
    .from('jimscanner_trends_product_images')
    .select('id, image_url')
    .order('created_at', { ascending: true })
    .limit(LIMIT)
  if (!REBUILD) query.is('embedding', null)

  const { data: pending, error } = await query
  if (error) { console.error('[pending fetch]', error.message); return }
  if (!pending || pending.length === 0) { console.log('[embed] nothing pending'); return }

  console.log(`[embed] pending=${pending.length}`)
  if (!HAS_EMBEDDER) {
    console.log('[embed] no embedder token — skipping (rows remain with embedding=NULL)')
    return
  }

  let ok = 0, fail = 0
  for (const row of pending) {
    try {
      const vec = await embedImage(row.image_url)
      if (!vec || vec.length !== 512) throw new Error(`bad vector length=${vec?.length}`)
      const { error: upErr } = await sb
        .from('jimscanner_trends_product_images')
        .update({ embedding: vec, embedding_model: EMBED_MODEL, embedded_at: new Date().toISOString() })
        .eq('id', row.id)
      if (upErr) throw upErr
      ok++
    } catch (e) {
      fail++
      console.warn(`[embed fail] ${row.image_url}: ${e.message}`)
    }
  }
  console.log(`[embed] done ok=${ok} fail=${fail}`)
}

async function embedImage(imageUrl) {
  if (REPLICATE_TOKEN) {
    // Replicate CLIP B/32 image-embeddings — placeholder; 실제 호출은 모델 ID 확인 후 채울 것.
    const res = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        Authorization: `Token ${REPLICATE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // 실제 사용 시 version 해시 채우기.
        version: process.env.REPLICATE_CLIP_VERSION ?? 'TODO_set_REPLICATE_CLIP_VERSION',
        input: { image: imageUrl, mode: 'embedding' },
      }),
    })
    if (!res.ok) throw new Error(`replicate ${res.status}`)
    const json = await res.json()
    // polling 생략 — 동기 응답 모델 가정. 비동기면 prediction id polling 필요.
    return json?.output?.embedding ?? null
  }
  if (HF_TOKEN) {
    const res = await fetch('https://api-inference.huggingface.co/models/google/siglip-base-patch16-224', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${HF_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: imageUrl }),
    })
    if (!res.ok) throw new Error(`hf ${res.status}`)
    const json = await res.json()
    return Array.isArray(json) ? json : json?.embedding ?? null
  }
  return null
}

// ─────────────────────────────────────────────────────────────
const start = Date.now()
const candidates = await extractThumbnailsFromRaw()
await linkImagesToProducts(candidates)
await embedPending()
console.log(`[embed-product-images] done in ${Math.round((Date.now() - start) / 1000)}s`)
