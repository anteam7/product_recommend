#!/usr/bin/env node
/**
 * Reverse-Economics Pin Gate — nightly RRS scanner.
 *
 * jimscanner_market_raw (source = naver_blog / naver_news / quasarzone_sale / external_review)
 * 에서 reverse intent 토큰의 카테고리 × 가격대 × 옵션복잡도 출현률을 집계해
 * Return Risk Score(RRS) 를 산출하고 jimscanner_return_risk 에 upsert.
 *
 * 호출:
 *   node --env-file=.env.local scripts/scan-return-mentions.mjs
 *
 * 요구사항:
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   - supabase/return_risk_view.sql 이 DB 에 적용된 상태
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

// Reverse intent 토큰 — 토큰별 intensity weight (반품 가능성 강도)
const REVERSE_TOKENS = [
  { token: '반품', weight: 1.0 },
  { token: '교환', weight: 0.8 },
  { token: '환불', weight: 1.0 },
  { token: '사이즈 안', weight: 0.9 }, // 사이즈 안 맞 / 안 맞아요
  { token: '안 맞', weight: 0.85 },
  { token: '오배송', weight: 0.95 },
  { token: '하자', weight: 1.0 },
  { token: '불량', weight: 0.95 },
  { token: '파손', weight: 0.9 },
  { token: '실망', weight: 0.4 },
]

// 카테고리 추론 — title/metadata 에 카테고리 명시 없으면 키워드 매칭
const CATEGORY_KEYWORDS = {
  health: ['오메가', '영양제', '비타민', '건기식', '프로바이오틱', '루테인', '글루코사민', '콜라겐', '유산균', '멜라토닌', '수면'],
  fashion: ['옷', '의류', '청바지', '셔츠', '원피스', '코트', '자켓', '바지', '치마', '가방', '신발', '스니커즈', '운동화', '구두', '모자'],
  beauty: ['화장품', '뷰티', '스킨', '로션', '크림', '마스크팩', '쿠션', '파운데이션', '립스틱', '향수', '에센스', '세럼'],
  digital: ['이어폰', '스피커', '충전기', '케이블', '키보드', '마우스', '모니터', '노트북', '태블릿', '아이폰', '갤럭시', '에어팟'],
  living: ['주방', '청소', '수납', '욕실', '침구', '커튼', '식기', '컵', '냄비', '가구', '소형가전'],
}

function inferCategory(text) {
  const lower = (text || '').toLowerCase()
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const kw of kws) {
      if (lower.includes(kw.toLowerCase())) return cat
    }
  }
  return 'other'
}

function inferPriceBand(metadata) {
  const priceRaw = metadata?.price ?? metadata?.price_krw ?? null
  const price = typeof priceRaw === 'number' ? priceRaw : parseInt(String(priceRaw || '').replace(/[^0-9]/g, ''), 10)
  if (!price || isNaN(price)) return 'unknown'
  if (price < 10000) return 'lt10k'
  if (price < 30000) return '10_30k'
  if (price < 50000) return '30_50k'
  if (price < 100000) return '50_100k'
  return 'gt100k'
}

function inferVariantComplexity(text, metadata) {
  // 옵션 키워드 출현 횟수로 추정 (사이즈 S/M/L, 색상, 용량 등)
  const lower = (text || '').toLowerCase()
  const sizeHits = (lower.match(/\b(xs|s|m|l|xl|xxl|95|100|105|110|220|230|240|250|260)\b/g) || []).length
  const colorHits = (lower.match(/(블랙|화이트|레드|블루|그레이|네이비|베이지|핑크|그린|옐로)/g) || []).length
  const variants = metadata?.variants ?? metadata?.options ?? null
  let count = sizeHits + colorHits
  if (Array.isArray(variants)) count += variants.length
  if (count <= 1) return 'simple'
  if (count <= 5) return 'medium'
  return 'complex'
}

function detectTokens(text) {
  const hits = []
  for (const { token, weight } of REVERSE_TOKENS) {
    if (text.includes(token)) hits.push({ token, weight })
  }
  return hits
}

async function fetchRaw(limit = 5000) {
  // 최근 60일치 reverse intent 모수
  const cutoff = new Date(Date.now() - 60 * 86400000).toISOString()
  const { data, error } = await sb
    .from('jimscanner_market_raw')
    .select('id, source, title, query, metadata, captured_at')
    .in('source', ['naver_blog', 'naver_news', 'quasarzone_sale', 'external_review'])
    .gte('captured_at', cutoff)
    .order('captured_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data ?? []
}

function buildCells(rows) {
  // (category, price_band, variant_complexity) 별 집계
  const cells = new Map()
  for (const r of rows) {
    const fullText = [r.title, r.query, r.metadata?.description, r.metadata?.content]
      .filter(Boolean)
      .join(' ')
    const category = inferCategory(fullText)
    const priceBand = inferPriceBand(r.metadata || {})
    const complexity = inferVariantComplexity(fullText, r.metadata || {})
    const key = `${category}|${priceBand}|${complexity}`
    if (!cells.has(key)) {
      cells.set(key, {
        category,
        price_band: priceBand,
        variant_complexity: complexity,
        sample_size: 0,
        mention_count: 0,
        intensity_sum: 0,
        token_counter: new Map(),
      })
    }
    const cell = cells.get(key)
    cell.sample_size += 1
    const hits = detectTokens(fullText)
    if (hits.length > 0) {
      cell.mention_count += 1
      let intensity = 0
      for (const { token, weight } of hits) {
        intensity = Math.max(intensity, weight) // 동일 row 내 가장 강한 weight
        cell.token_counter.set(token, (cell.token_counter.get(token) || 0) + 1)
      }
      cell.intensity_sum += intensity
    }
  }
  return cells
}

function finalizeCells(cells) {
  const out = []
  for (const cell of cells.values()) {
    if (cell.price_band === 'unknown') continue
    if (cell.sample_size < 3) continue // 잡음 컷
    const mentionRate = cell.mention_count / cell.sample_size
    const avgIntensity = cell.mention_count > 0 ? cell.intensity_sum / cell.mention_count : 0
    const rrs = Math.min(1, mentionRate * avgIntensity * 1.2) // 1.2 = 외부 텍스트 → 실제 반품률 보정 계수
    const topTokens = [...cell.token_counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([t]) => t)
    out.push({
      category: cell.category,
      price_band: cell.price_band,
      variant_complexity: cell.variant_complexity,
      mention_count: cell.mention_count,
      sample_size: cell.sample_size,
      mention_rate: Number(mentionRate.toFixed(4)),
      rrs: Number(rrs.toFixed(4)),
      top_tokens: topTokens,
      refreshed_at: new Date().toISOString(),
    })
  }
  return out
}

async function upsertCells(cells) {
  if (cells.length === 0) {
    console.log('적재할 셀 없음 (sample_size < 3)')
    return
  }
  const { error } = await sb
    .from('jimscanner_return_risk')
    .upsert(cells, { onConflict: 'category,price_band,variant_complexity' })
  if (error) throw error
  console.log(`✓ upsert ${cells.length} cells`)
}

async function main() {
  console.log('[scan-return-mentions] start')
  const rows = await fetchRaw(5000)
  console.log(`fetched raw rows: ${rows.length}`)
  const cells = buildCells(rows)
  const finalized = finalizeCells(cells)
  console.log(`finalized cells: ${finalized.length}`)
  // Top 5 RRS 출력
  const top = [...finalized].sort((a, b) => b.rrs - a.rrs).slice(0, 5)
  for (const c of top) {
    console.log(
      `  ${c.category} / ${c.price_band} / ${c.variant_complexity}: RRS=${c.rrs} rate=${c.mention_rate} (${c.mention_count}/${c.sample_size}) tokens=[${c.top_tokens.join(', ')}]`,
    )
  }
  await upsertCells(finalized)
  console.log('[scan-return-mentions] done')
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
