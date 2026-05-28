#!/usr/bin/env node
/**
 * SKU Spec-Attribute Whitespace Matrix builder.
 *
 *   1. ggsan 카탈로그 title 에서 (volume / size / color / material / feature)
 *      attr 들을 룰베이스로 추출 → jimscanner_sku_spec_attrs UPSERT.
 *      (LLM 보강은 후속 PR — 우선 룰 기반 MVP)
 *   2. jimscanner_trends_keywords + jimscanner_market_raw 의 keyword/title 에서
 *      같은 modifier 사전으로 토큰화 → jimscanner_modifier_demand 카운트 UPSERT.
 *
 * 호출 (로컬, scripts/run-crons.mjs 가 매일 1회 spawn):
 *   node --env-file=.env.local scripts/build-spec-whitespace.mjs
 *
 * Vercel cron 으론 안 돌림 — Hobby plan 한도 + 로컬 cron 정책.
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
})

// ──────────────────────────────────────────
// 카테고리 룰북 — title 키워드 → 정규화 카테고리.
// 최소 셋으로 시작. 후속 PR 에서 LLM 분류 결과 (jimscanner_trends_products.category_mid)
// 를 끌어쓰도록 확장.
const CATEGORY_RULES = [
  { cat: 'water_bottle', cat_top: 'living', kws: ['보온병', '텀블러', '물병', '워터보틀'] },
  { cat: 'tumbler',       cat_top: 'living', kws: ['텀블러', '머그'] },
  { cat: 'omega3',        cat_top: 'health', kws: ['오메가3', '오메가 3', 'omega3'] },
  { cat: 'probiotics',    cat_top: 'health', kws: ['유산균', '프로바이오틱'] },
  { cat: 'collagen',      cat_top: 'health', kws: ['콜라겐'] },
  { cat: 'storage',       cat_top: 'living', kws: ['수납', '정리함', '바스켓'] },
  { cat: 'kitchen_tool',  cat_top: 'living', kws: ['주방', '도마', '칼', '냄비'] },
  { cat: 'air_purifier',  cat_top: 'digital', kws: ['공기청정기'] },
  { cat: 'humidifier',    cat_top: 'digital', kws: ['가습기'] },
  { cat: 'fan',           cat_top: 'digital', kws: ['선풍기', '서큘레이터'] },
]

// 사양 차원 룰북 — 한국 위탁몰 카탈로그 빈번 패턴.
const DIM_RULES = [
  {
    dim: 'volume',
    // 100ml ~ 9999ml, 0.5L ~ 9L 등
    rx: [/\b(\d{2,4})\s*(?:ml|ML|밀리리터)\b/g, /\b(\d(?:\.\d)?)\s*(?:l|L|리터)\b/gi],
    normalize: (m) => {
      const num = parseFloat(m[1])
      if (m[0].toLowerCase().includes('l') && !m[0].toLowerCase().includes('ml')) {
        return `${Math.round(num * 1000)}ml`
      }
      return `${Math.round(num)}ml`
    },
  },
  {
    dim: 'size',
    rx: [/\b(\d{2,4})\s*g\b/gi, /\b(\d{2,4})\s*kg\b/gi, /\b(\d{2,3})\s*인치\b/g],
    normalize: (m) => m[0].replace(/\s+/g, '').toLowerCase(),
  },
  {
    dim: 'color',
    rx: [],
    dict: [
      '블랙', '화이트', '핑크', '레드', '블루', '네이비', '그린', '옐로우', '오렌지',
      '퍼플', '그레이', '실버', '골드', '아이보리', '베이지', '브라운', '민트',
      '코랄', '라벤더', '카키',
    ],
  },
  {
    dim: 'material',
    rx: [],
    dict: [
      '스테인리스', '스텐', '플라스틱', '유리', '실리콘', '나무', '목재', '대나무',
      '세라믹', '도자기', '면', '폴리에스터', '가죽', '천연', '인견', '리넨',
    ],
  },
  {
    dim: 'feature',
    rx: [],
    dict: [
      '보온', '보냉', '진공', '무선', '충전식', '접이식', '휴대용', '미니', '대용량',
      '저소음', '강력', '항균', '친환경', '에코', '슬림', '경량', '튼튼한', '심플',
      '북유럽', '빈티지', '레트로', '한정판',
    ],
  },
]

function classifyCategory(title) {
  const t = (title || '').toLowerCase()
  for (const c of CATEGORY_RULES) {
    if (c.kws.some((k) => t.includes(k.toLowerCase()))) return c
  }
  return null
}

function extractAttrs(text) {
  const result = []
  const t = text || ''
  for (const dim of DIM_RULES) {
    for (const rx of dim.rx) {
      rx.lastIndex = 0
      let m
      while ((m = rx.exec(t)) !== null) {
        const val = dim.normalize ? dim.normalize(m) : m[0]
        if (val) result.push({ dim: dim.dim, value: val })
        if (rx.lastIndex === m.index) rx.lastIndex++
      }
    }
    if (dim.dict) {
      for (const w of dim.dict) {
        if (t.includes(w)) result.push({ dim: dim.dim, value: w })
      }
    }
  }
  return result
}

// ──────────────────────────────────────────
async function buildSkuAttrs() {
  console.log('[1/2] ggsan SKU spec attribute extraction…')
  // 모든 ggsan 카탈로그 (활성)
  const { data: products, error } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title, cate_label')
    .eq('status', 'active')
    .limit(20000)
  if (error) throw error
  console.log(`  loaded ${products?.length ?? 0} ggsan products`)

  const rows = []
  for (const p of products ?? []) {
    const cat = classifyCategory(p.title)
    if (!cat) continue
    const attrs = extractAttrs(p.title)
    if (attrs.length === 0) continue
    const seen = new Set()
    for (const a of attrs) {
      const key = `${a.dim}::${a.value}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({
        sku_id: p.goods_no,
        sku_source: 'ggsan',
        category: cat.cat,
        category_top: cat.cat_top,
        attr_dim: a.dim,
        attr_value: a.value,
        confidence: 0.8,
        extracted_by: 'rule',
      })
    }
  }
  console.log(`  extracted ${rows.length} (sku × attr) rows`)

  // 청크 UPSERT
  const CHUNK = 500
  let upserted = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const { error: upErr } = await sb
      .from('jimscanner_sku_spec_attrs')
      .upsert(chunk, { onConflict: 'sku_source,sku_id,attr_dim,attr_value' })
    if (upErr) {
      console.error('  upsert error:', upErr.message)
      break
    }
    upserted += chunk.length
  }
  console.log(`  upserted ${upserted} rows`)
  return upserted
}

async function buildModifierDemand() {
  console.log('[2/2] keyword modifier demand count…')
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()

  const [kwRes, mrRes] = await Promise.all([
    sb
      .from('jimscanner_trends_keywords')
      .select('keyword, source, collected_at')
      .gte('collected_at', since)
      .limit(50000),
    sb
      .from('jimscanner_market_raw')
      .select('title, query, source, captured_at')
      .gte('captured_at', since)
      .limit(50000),
  ])

  const corpus = []
  for (const r of kwRes.data ?? []) {
    if (r.keyword) corpus.push({ text: r.keyword, source: r.source })
  }
  for (const r of mrRes.data ?? []) {
    if (r.query) corpus.push({ text: r.query, source: r.source })
    if (r.title) corpus.push({ text: r.title, source: r.source })
  }
  console.log(`  corpus size: ${corpus.length}`)

  // 카테고리 룰에 해당하는 키워드만 카운트.
  const bucket = new Map() // key = `${cat}::${dim}::${val}` → { freq, sources, samples }

  for (const c of corpus) {
    const cat = classifyCategory(c.text)
    if (!cat) continue
    const attrs = extractAttrs(c.text)
    if (attrs.length === 0) continue
    const localSeen = new Set()
    for (const a of attrs) {
      const k = `${cat.cat}::${a.dim}::${a.value}`
      if (localSeen.has(k)) continue
      localSeen.add(k)
      let v = bucket.get(k)
      if (!v) {
        v = { category: cat.cat, attr_dim: a.dim, attr_value: a.value, freq: 0, sources: new Set(), samples: new Set() }
        bucket.set(k, v)
      }
      v.freq++
      if (c.source) v.sources.add(c.source)
      if (v.samples.size < 5) v.samples.add(c.text.slice(0, 80))
    }
  }

  const rows = [...bucket.values()].map((v) => ({
    category: v.category,
    attr_dim: v.attr_dim,
    attr_value: v.attr_value,
    search_freq: v.freq,
    source_count: v.sources.size,
    example_keywords: [...v.samples],
    last_seen_at: new Date().toISOString(),
    computed_at: new Date().toISOString(),
  }))
  console.log(`  computed ${rows.length} (category × dim × value) rows`)

  const CHUNK = 500
  let upserted = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const { error } = await sb
      .from('jimscanner_modifier_demand')
      .upsert(chunk, { onConflict: 'category,attr_dim,attr_value' })
    if (error) {
      console.error('  upsert error:', error.message)
      break
    }
    upserted += chunk.length
  }
  console.log(`  upserted ${upserted} rows`)
  return upserted
}

async function main() {
  const t0 = Date.now()
  const skuRows = await buildSkuAttrs()
  const demandRows = await buildModifierDemand()
  console.log(`\nDone in ${Date.now() - t0}ms  · sku_attrs=${skuRows}  modifier_demand=${demandRows}`)
}

main().catch((e) => {
  console.error('FATAL:', e?.message || e)
  process.exit(1)
})
