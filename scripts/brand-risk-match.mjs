#!/usr/bin/env node
/**
 * brand-risk-match — 상표/캐릭터 IP 침해 사전 매칭 cron.
 *
 * 입력 소스:
 *   - jimscanner_trends_products.canonical_name + aliases (jsonb)
 *   - jimscanner_ggsan_products.title (위탁 후보)
 *   - (TODO) image OCR 텍스트 — Phase 2
 *
 * 매칭 방식:
 *   - token: 단어 경계 / 한글-라틴 혼합 substring 매칭 (기본)
 *   - regex: term 을 regex 로 사용 (사전에서 hit_pattern='regex' 인 것만)
 *   - fuzzy: pg_trgm similarity (보류 — Phase 2)
 *
 * 출력:
 *   - jimscanner_trends_brand_risk_hits 에 적재 (중복 hit 은 skip)
 *
 * 사용:
 *   node --env-file=.env.local scripts/brand-risk-match.mjs
 *   node --env-file=.env.local scripts/brand-risk-match.mjs --dry-run
 */

import { createClient } from '@supabase/supabase-js'

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SVC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPA_URL || !SVC_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요')
  process.exit(1)
}
const sb = createClient(SUPA_URL, SVC_KEY, { auth: { persistSession: false } })

const DRY = process.argv.includes('--dry-run')

function normalize(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function tokenHit(haystack, term) {
  const h = normalize(haystack)
  const t = normalize(term)
  if (!h || !t) return false
  // 한글은 단어경계가 약하므로 substring 매칭. 라틴 문자열은 \b 사용.
  if (/^[\x00-\x7f]+$/.test(t)) {
    const re = new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i')
    return re.test(h)
  }
  return h.includes(t)
}

function regexHit(haystack, pattern) {
  try {
    return new RegExp(pattern, 'i').test(String(haystack ?? ''))
  } catch {
    return false
  }
}

async function loadTerms() {
  const { data, error } = await sb
    .from('jimscanner_trends_brand_risk_terms')
    .select('id, term, owner_class, risk_level, hit_pattern, is_active')
    .eq('is_active', true)
  if (error) throw error
  return data ?? []
}

async function loadProducts() {
  const { data, error } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, aliases')
    .order('last_seen_at', { ascending: false })
    .limit(5000)
  if (error) throw error
  return data ?? []
}

async function loadGgsan() {
  const { data, error } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title')
    .limit(5000)
  if (error) return []
  return data ?? []
}

async function existingHitKeys() {
  // 같은 (product_id|goods_no, term_id, matched_field) 조합은 재삽입하지 않음.
  const set = new Set()
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('jimscanner_trends_brand_risk_hits')
      .select('product_id, ggsan_goods_no, term_id, matched_field')
      .range(from, from + PAGE - 1)
    if (error) break
    if (!data || data.length === 0) break
    for (const r of data) {
      const k = `${r.product_id ?? ''}|${r.ggsan_goods_no ?? ''}|${r.term_id}|${r.matched_field}`
      set.add(k)
    }
    if (data.length < PAGE) break
  }
  return set
}

function aliasStrings(aliases) {
  if (!aliases) return []
  if (Array.isArray(aliases)) {
    return aliases.map((a) => (typeof a === 'string' ? a : a?.alias ?? a?.text ?? '')).filter(Boolean)
  }
  if (typeof aliases === 'object') {
    return Object.values(aliases).flatMap((v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v : []))
  }
  return []
}

function evalTerm(term, text) {
  const kind = term.hit_pattern || 'token'
  if (!text) return null
  if (kind === 'regex') {
    if (regexHit(text, term.term)) return { match_kind: 'regex', matched_term: term.term }
  } else if (kind === 'token') {
    if (tokenHit(text, term.term)) return { match_kind: 'token', matched_term: term.term }
  }
  return null
}

async function main() {
  console.log(`[brand-risk-match] start ${DRY ? '(DRY)' : ''}`)
  const t0 = Date.now()
  const [terms, products, ggsan, existing] = await Promise.all([
    loadTerms(), loadProducts(), loadGgsan(), existingHitKeys(),
  ])
  console.log(`terms=${terms.length} products=${products.length} ggsan=${ggsan.length} existing_hits=${existing.size}`)

  const newHits = []

  // products: canonical_name + aliases 매칭
  for (const p of products) {
    const fields = [
      { field: 'canonical_name', text: p.canonical_name },
      ...aliasStrings(p.aliases).map((a) => ({ field: 'alias', text: a })),
    ]
    for (const term of terms) {
      let bestHit = null
      let bestField = null
      for (const f of fields) {
        const h = evalTerm(term, f.text)
        if (h) {
          if (!bestHit) { bestHit = h; bestField = f }
          if (f.field === 'canonical_name') { bestHit = h; bestField = f; break }
        }
      }
      if (!bestHit) continue
      const key = `${p.id}||${term.id}|${bestField.field}`
      if (existing.has(key)) continue
      newHits.push({
        product_id: p.id,
        ggsan_goods_no: null,
        term_id: term.id,
        matched_term: bestHit.matched_term,
        matched_alias: bestField.text,
        matched_field: bestField.field,
        match_kind: bestHit.match_kind,
        owner_class: term.owner_class,
        risk_level: term.risk_level,
      })
      existing.add(key)
    }
  }

  // ggsan 후보: title 매칭
  for (const g of ggsan) {
    for (const term of terms) {
      const h = evalTerm(term, g.title)
      if (!h) continue
      const key = `|${g.goods_no}|${term.id}|ggsan_title`
      if (existing.has(key)) continue
      newHits.push({
        product_id: null,
        ggsan_goods_no: g.goods_no,
        term_id: term.id,
        matched_term: h.matched_term,
        matched_alias: g.title,
        matched_field: 'ggsan_title',
        match_kind: h.match_kind,
        owner_class: term.owner_class,
        risk_level: term.risk_level,
      })
      existing.add(key)
    }
  }

  console.log(`new hits: ${newHits.length}`)
  if (DRY || newHits.length === 0) {
    console.log(`[brand-risk-match] done in ${Date.now() - t0}ms (no writes)`)
    return
  }

  // batch insert
  const CHUNK = 500
  let inserted = 0
  for (let i = 0; i < newHits.length; i += CHUNK) {
    const slice = newHits.slice(i, i + CHUNK)
    const { error } = await sb.from('jimscanner_trends_brand_risk_hits').insert(slice)
    if (error) {
      console.error(`insert chunk ${i}: ${error.message}`)
      continue
    }
    inserted += slice.length
  }
  console.log(`[brand-risk-match] inserted=${inserted} in ${Date.now() - t0}ms`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
