#!/usr/bin/env node
/**
 * SERP 옵션변형 추출 — Variant Whitespace 보드 (2026-05-26)
 *
 * 입력 후보 (우선순위 순):
 *   1) jimscanner_trends_raw 에서 source IN ('naver_shopping_listing','coupang_serp')
 *      payload.items[].title 리스트
 *   2) (fallback) jimscanner_trends_keywords 에 적힌 키워드들 — 변형 추출 대상 키워드만 골라
 *      향후 외부 수집기와 페어링. 이번 버전은 raw payload 가 없으면 ggsan 카탈로그 title 을 sample
 *      소스로 사용해서 적어도 비어있지 않은 결과를 만든다.
 *
 * 정규식 기반 변형 축 파서:
 *   - capacity: 용량/캡슐수/정 (e.g. "30정", "60캡슐", "500ml", "1L")
 *   - pack:     팩수 (e.g. "2팩", "3개입", "x4")
 *   - size:     사이즈 (e.g. "S","M","L","XL","95","100", "270mm")
 *   - flavor:   맛·향 (e.g. "딸기맛","바닐라","오리지널")
 *   - color:    색상 (e.g. "블랙","화이트","베이지")
 *   - age:      연령대 (e.g. "성인용","어린이","유아용","시니어")
 *   - gender:   성별 (e.g. "남성","여성","공용")
 *
 * 호출:
 *   node --env-file=.env.local scripts/extract-serp-variants.mjs
 *   node --env-file=.env.local scripts/extract-serp-variants.mjs --keywords "오메가3,콜라겐"
 *   node --env-file=.env.local scripts/extract-serp-variants.mjs --dry
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

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry')
const KEYWORDS_FLAG = (() => {
  const i = argv.indexOf('--keywords')
  if (i < 0) return null
  return (argv[i + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
})()

// ────────────────────────────────────────────────────────────
// 1) 변형 축 정규식 파서
// ────────────────────────────────────────────────────────────

const AXES = {
  capacity: [
    /(\d+(?:\.\d+)?)\s*(ml|mL|ML)\b/g,
    /(\d+(?:\.\d+)?)\s*(l|L|리터)\b/g,
    /(\d+)\s*(g|G|kg|KG|그램)\b/g,
    /(\d+)\s*(캡슐|정|포|매|개입|봉)\b/g,
  ],
  pack: [
    /(\d+)\s*(팩|set|세트|박스|BOX)\b/gi,
    /[x×X]\s*(\d+)\b/g,
    /(\d+)\+(\d+)\b/g, // "2+1" 패턴
  ],
  size: [
    /\b(XS|S|M|L|XL|XXL|XXXL|2XL|3XL)\b/g,
    /\b(\d{3})\s*(?:mm|cm|호)\b/g, // 신발 270mm 등
    /\b(\d{2,3})\s*(?:사이즈|size)\b/gi,
  ],
  flavor: [
    /(딸기|바나나|초코|초콜릿|바닐라|민트|레몬|오렌지|복숭아|포도|블루베리|망고|커피|녹차|말차|콜라|사이다|오리지널|순한맛|매운맛)\s*(?:맛|향)?/g,
  ],
  color: [
    /(블랙|화이트|아이보리|베이지|그레이|네이비|레드|블루|그린|옐로우|핑크|퍼플|브라운|카키|골드|실버|버건디)/g,
    /\b(검정|하양|회색|남색|빨강|파랑|초록|노랑|분홍|보라|갈색|황금|은색)\b/g,
  ],
  age: [
    /(성인용|어린이용?|아동용?|유아용?|영유아|시니어|노인용|청소년)/g,
  ],
  gender: [
    /(남성용?|여성용?|공용|남녀공용|유니섹스|남자|여자)/g,
  ],
}

// 값 정규화 (display 용 라벨)
function normalize(axis, raw, match) {
  switch (axis) {
    case 'capacity': {
      // match[0] 전체. 숫자+단위 정리
      return String(match[0]).replace(/\s+/g, '').toLowerCase()
    }
    case 'pack': {
      if (match[0].includes('+')) return `${match[1]}+${match[2]}`
      const n = match[1] ?? match[0].replace(/\D/g, '')
      return `${n}팩`
    }
    case 'size': {
      const v = (match[1] ?? match[0]).toUpperCase()
      return v
    }
    case 'flavor':
    case 'color':
    case 'age':
    case 'gender': {
      return (match[1] ?? match[0]).trim()
    }
    default:
      return String(match[0]).trim()
  }
}

function extractAxes(title) {
  if (!title || typeof title !== 'string') return []
  const found = []
  for (const [axis, patterns] of Object.entries(AXES)) {
    for (const re of patterns) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(title)) !== null) {
        found.push({ axis, value: normalize(axis, title, m) })
        if (!re.global) break
      }
    }
  }
  // dedupe (같은 title 안에서 같은 (axis,value) 는 1번만 카운트)
  const seen = new Set()
  return found.filter((f) => {
    const k = `${f.axis}::${f.value}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// ────────────────────────────────────────────────────────────
// 2) 데이터 소스 로드
// ────────────────────────────────────────────────────────────

async function loadListingsByKeyword() {
  // raw payload 우선
  const { data: raws, error: rawErr } = await sb
    .from('jimscanner_trends_raw')
    .select('source, request_label, payload, collected_at')
    .in('source', ['naver_shopping_listing', 'coupang_serp', 'naver_search_listing'])
    .order('collected_at', { ascending: false })
    .limit(500)

  /** @type {Record<string, Array<{title: string, rank?: number, review?: number, price?: number}>>} */
  const byKeyword = {}

  if (!rawErr && raws && raws.length > 0) {
    for (const r of raws) {
      const kw = r.request_label || (r.payload?.keyword ?? null)
      if (!kw) continue
      if (KEYWORDS_FLAG && !KEYWORDS_FLAG.includes(kw)) continue
      const items = Array.isArray(r.payload?.items) ? r.payload.items : []
      if (!byKeyword[kw]) byKeyword[kw] = []
      let rank = 0
      for (const it of items) {
        rank += 1
        const title = it.title ?? it.name ?? it.productName
        if (!title) continue
        byKeyword[kw].push({
          title: String(title),
          rank: it.rank ?? rank,
          review: Number(it.review ?? it.reviewCount ?? 0) || 0,
          price: Number(it.price ?? it.lprice ?? 0) || 0,
        })
      }
    }
  }

  if (Object.keys(byKeyword).length === 0) {
    // Fallback: ggsan 카탈로그 title 을 키워드 시드로. 카테고리 라벨을 keyword 로 사용.
    console.error('[fallback] raw SERP payload 없음 → ggsan 카탈로그로 변형 분석 (검증용)')
    const { data: ggsan } = await sb
      .from('jimscanner_ggsan_products')
      .select('title, cate_label, price_krw')
      .not('cate_label', 'is', null)
      .limit(3000)
    for (const g of ggsan ?? []) {
      const kw = g.cate_label || 'unknown'
      if (KEYWORDS_FLAG && !KEYWORDS_FLAG.includes(kw)) continue
      if (!byKeyword[kw]) byKeyword[kw] = []
      byKeyword[kw].push({
        title: g.title,
        rank: byKeyword[kw].length + 1,
        review: 0,
        price: g.price_krw ?? 0,
      })
    }
  }

  return byKeyword
}

// ────────────────────────────────────────────────────────────
// 3) 집계 + z-score
// ────────────────────────────────────────────────────────────

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor((p / 100) * (sortedAsc.length - 1))))
  return sortedAsc[idx]
}

function aggregate(byKeyword) {
  const capturedAt = new Date().toISOString()
  /** @type {Array<any>} */
  const rows = []

  for (const [keyword, listings] of Object.entries(byKeyword)) {
    if (listings.length === 0) continue

    /** @type {Record<string, Record<string, {ranks: number[], reviews: number[], prices: number[]}>>} */
    const buckets = {}

    for (const l of listings) {
      const axes = extractAxes(l.title)
      for (const a of axes) {
        if (!buckets[a.axis]) buckets[a.axis] = {}
        if (!buckets[a.axis][a.value]) buckets[a.axis][a.value] = { ranks: [], reviews: [], prices: [] }
        const b = buckets[a.axis][a.value]
        if (l.rank) b.ranks.push(l.rank)
        if (l.review) b.reviews.push(l.review)
        if (l.price) b.prices.push(l.price)
      }
    }

    // axis 별로 mean·sd 계산 → z-score
    for (const [axis, values] of Object.entries(buckets)) {
      const counts = Object.values(values).map((v) => v.ranks.length || 1)
      const mean = counts.reduce((s, n) => s + n, 0) / counts.length
      const variance = counts.reduce((s, n) => s + (n - mean) ** 2, 0) / counts.length
      const sd = Math.sqrt(variance) || 1

      for (const [value, b] of Object.entries(values)) {
        const listingCount = b.ranks.length || 1
        const avgRank = b.ranks.length > 0 ? b.ranks.reduce((s, n) => s + n, 0) / b.ranks.length : null
        const reviewSum = b.reviews.reduce((s, n) => s + n, 0)
        const sortedPrices = [...b.prices].sort((a, b) => a - b)
        const z = (listingCount - mean) / sd
        rows.push({
          keyword,
          axis,
          value,
          listing_count: listingCount,
          avg_rank: avgRank,
          review_sum: reviewSum,
          price_p50: percentile(sortedPrices, 50),
          price_p10: percentile(sortedPrices, 10),
          price_p90: percentile(sortedPrices, 90),
          density_z: Number(z.toFixed(3)),
          captured_at: capturedAt,
        })
      }
    }
  }

  return rows
}

// ────────────────────────────────────────────────────────────
// 4) 메인
// ────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now()
  console.log('[serp-variants] loading listings…')
  const byKeyword = await loadListingsByKeyword()
  const keywords = Object.keys(byKeyword)
  console.log(`[serp-variants] ${keywords.length} keywords, ` +
    `${Object.values(byKeyword).reduce((s, l) => s + l.length, 0)} listings`)

  const rows = aggregate(byKeyword)
  console.log(`[serp-variants] ${rows.length} (keyword,axis,value) rows`)

  if (DRY) {
    console.log(JSON.stringify(rows.slice(0, 20), null, 2))
    console.log(`… and ${Math.max(0, rows.length - 20)} more`)
    return
  }

  if (rows.length === 0) {
    console.log('[serp-variants] nothing to insert')
    return
  }

  // chunked upsert (unique on keyword,axis,value,captured_at)
  const CHUNK = 500
  let inserted = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const { error } = await sb
      .from('jimscanner_serp_variants')
      .upsert(chunk, { onConflict: 'keyword,axis,value,captured_at' })
    if (error) {
      console.error('[serp-variants] upsert error:', error.message)
      process.exit(1)
    }
    inserted += chunk.length
  }
  console.log(`[serp-variants] inserted ${inserted} rows in ${Date.now() - t0}ms`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
