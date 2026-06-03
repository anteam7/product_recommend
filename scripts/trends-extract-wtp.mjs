#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// 수요측 지불의사(WTP) 가격천장 추출 → jimscanner_trends_wtp 적재
// ─────────────────────────────────────────────────────────────
// 각 canonical 상품의 alias 텍스트(jimscanner_trends_aliases)와 키워드/방송
// 타이틀에서 가격수식어('가성비/저렴한/1만원대/프리미엄/명품/최저가')와 명시가
// ('N원', 'N만원대')를 regex 로 파싱해 WTP 밴드(low/mid/high)를 산출한다.
//
// naver_tvtime 편성 타이틀의 방송 판매가를 wtp_high 앵커로 결합.
//
// recompute 크론 스텝으로 호출 가능: node scripts/trends-extract-wtp.mjs
//   --limit N  처리 상품 수 제한 (기본 500)
//   --dry      DB 미적재, 콘솔 출력만
// canon: supabase/trends_wtp.sql · 공식: src/lib/coupang/price.ts
// ─────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      let v = l.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return [l.slice(0, i).trim(), v]
    }),
)

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const LIMIT = (() => {
  const i = args.indexOf('--limit')
  return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : 500
})()

// ─── 가격수식어 사전 (tier: value < mid < premium) ───
const MODIFIERS = [
  { re: /최저가|초저가|핫딜|땡처리|떨이/, tier: 'value', weight: 1.2 },
  { re: /가성비|저렴|싼|알뜰|실속|혜자/, tier: 'value', weight: 1.0 },
  { re: /중저가|보급형|입문/, tier: 'mid', weight: 0.8 },
  { re: /프리미엄|고급|하이엔드|명품|럭셔리|플래그십/, tier: 'premium', weight: 1.0 },
]

// ─── 명시가 추출: 'N만원대', 'N원', 'N만원' ───
function extractExplicitPrices(text) {
  const out = []
  // 'N만원대' → 밴드 [N0000, N9999]
  for (const m of text.matchAll(/(\d{1,3})\s*만\s*원\s*대/g)) {
    const man = parseInt(m[1], 10)
    out.push({ text: m[0], amount_low: man * 10000, amount_high: man * 10000 + 9999 })
  }
  // 'N만원' / 'N만 원' (단일가)
  for (const m of text.matchAll(/(\d{1,3})\s*만\s*원(?!\s*대)/g)) {
    const v = parseInt(m[1], 10) * 10000
    out.push({ text: m[0], amount_low: v, amount_high: v })
  }
  // 'NNNN원' (5천~50만 사이 현실가만)
  for (const m of text.matchAll(/(\d{4,7})\s*원/g)) {
    const v = parseInt(m[1], 10)
    if (v >= 3000 && v <= 500000) out.push({ text: m[0], amount_low: v, amount_high: v })
  }
  return out
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

// ─── 한 상품의 텍스트 모음 + 방송앵커 → WTP 밴드 ───
function computeWtp({ texts, tvAnchors }) {
  const modifiers = []
  const explicit = []
  for (const t of texts) {
    if (!t) continue
    for (const mod of MODIFIERS) {
      if (mod.re.test(t)) modifiers.push({ alias: t, tier: mod.tier, weight: mod.weight })
    }
    for (const p of extractExplicitPrices(t)) explicit.push({ ...p, source: 'keyword' })
  }

  const anchorPrices = tvAnchors.map((a) => a.price).filter((p) => typeof p === 'number' && p > 0)
  const explicitMids = explicit.map((e) => (e.amount_low + e.amount_high) / 2)

  // 앵커 우선: 방송가 + 명시가 결합
  const priceSignals = [...anchorPrices, ...explicitMids]

  let low = null
  let mid = null
  let high = null

  if (priceSignals.length > 0) {
    const sorted = [...priceSignals].sort((a, b) => a - b)
    low = sorted[0]
    high = sorted[sorted.length - 1]
    mid = sorted[Math.floor(sorted.length / 2)]
    // 단일 신호면 ±25% 밴드로 펼침
    if (low === high) {
      low = Math.round(low * 0.75)
      high = Math.round(high * 1.25)
    }
  }

  // 수식어 tier 로 밴드 보정 (명시가 없을 때 tier 만으로 추정)
  const tierBias = modifiers.reduce((acc, m) => acc + (m.tier === 'value' ? -1 : m.tier === 'premium' ? 1 : 0) * m.weight, 0)
  if (priceSignals.length === 0 && modifiers.length > 0) {
    // 명시가 전무 → tier 만으로 거친 추정 (셀러가 확인용). 보수적 기본 밴드.
    const base = 19900
    mid = clamp(Math.round(base * (1 + tierBias * 0.25)), 5000, 200000)
    low = Math.round(mid * 0.7)
    high = Math.round(mid * 1.4)
  } else if (priceSignals.length > 0 && tierBias !== 0) {
    // premium 화자 있으면 천장 상향, value 화자 있으면 바닥 하향
    if (tierBias > 0) high = Math.round(high * (1 + clamp(tierBias, 0, 3) * 0.08))
    if (tierBias < 0) low = Math.round(low * (1 + clamp(tierBias, -3, 0) * 0.06))
  }

  const sampleCount = modifiers.length + explicit.length + anchorPrices.length
  // 신뢰도: 방송앵커 있으면 +0.4, 명시가 개수, 표본 수 기반
  let confidence = 0
  if (anchorPrices.length > 0) confidence += 0.4
  confidence += Math.min(0.4, explicit.length * 0.1)
  confidence += Math.min(0.2, modifiers.length * 0.05)
  confidence = +clamp(confidence, 0, 1).toFixed(2)

  return {
    wtp_low: low != null ? Math.round(low) : null,
    wtp_mid: mid != null ? Math.round(mid) : null,
    wtp_high: high != null ? Math.round(high) : null,
    sample_count: sampleCount,
    confidence,
    evidence: { method: 'regex_v1', modifiers, explicit_prices: explicit, tv_anchors: tvAnchors },
  }
}

async function main() {
  const { data: products, error: pErr } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name')
    .order('last_seen_at', { ascending: false })
    .limit(LIMIT)
  if (pErr) throw pErr
  if (!products?.length) {
    console.log('상품 없음 — 종료')
    return
  }

  const ids = products.map((p) => p.id)
  const { data: aliases } = await sb
    .from('jimscanner_trends_aliases')
    .select('product_id, alias')
    .in('product_id', ids)
  const aliasByProduct = new Map()
  for (const a of aliases ?? []) {
    if (!aliasByProduct.has(a.product_id)) aliasByProduct.set(a.product_id, [])
    aliasByProduct.get(a.product_id).push(a.alias)
  }

  // TV 방송 앵커: naver_tvtime 편성 타이틀에서 가격 추출 (best-effort; 테이블 없으면 skip)
  const tvAnchorsByName = new Map()
  try {
    const { data: tv } = await sb
      .from('jimscanner_naver_tvtime')
      .select('title, price')
      .limit(5000)
    for (const t of tv ?? []) {
      const price = typeof t.price === 'number' ? t.price : null
      if (price == null) continue
      const key = (t.title ?? '').trim()
      if (!key) continue
      if (!tvAnchorsByName.has(key)) tvAnchorsByName.set(key, [])
      tvAnchorsByName.get(key).push({ title: key, price, source: 'naver_tvtime' })
    }
  } catch {
    // 테이블 미존재 — TV 앵커 없이 진행
  }

  const computedAt = new Date().toISOString()
  const rows = []
  for (const p of products) {
    const texts = [p.canonical_name, ...(aliasByProduct.get(p.id) ?? [])]
    // 상품명을 포함하는 방송 타이틀을 앵커로 (느슨한 substring 매칭)
    const tvAnchors = []
    const name = (p.canonical_name ?? '').trim()
    if (name.length >= 2) {
      for (const [title, anchors] of tvAnchorsByName) {
        if (title.includes(name) || name.includes(title)) tvAnchors.push(...anchors)
      }
    }
    const wtp = computeWtp({ texts, tvAnchors: tvAnchors.slice(0, 10) })
    if (wtp.wtp_mid == null && wtp.sample_count === 0) continue // 신호 전무 → skip
    rows.push({ product_id: p.id, computed_at: computedAt, ...wtp })
  }

  console.log(`상품 ${products.length}개 중 ${rows.length}개에서 WTP 신호 추출`)
  if (DRY) {
    console.dir(rows.slice(0, 8), { depth: 4 })
    console.log('--dry 모드 — DB 미적재')
    return
  }
  if (rows.length === 0) return

  // 청크 적재
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200)
    const { error } = await sb.from('jimscanner_trends_wtp').insert(chunk)
    if (error) throw error
  }
  console.log(`✅ jimscanner_trends_wtp 에 ${rows.length} row 적재 완료 (computed_at=${computedAt})`)
}

main().catch((e) => {
  console.error('WTP 추출 실패:', e.message || e)
  process.exit(1)
})
