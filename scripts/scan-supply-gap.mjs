#!/usr/bin/env node
/**
 * 재입고 대란 레이더 — 공급실패(supply gap) 룰 스캐너 (로컬 전용, LLM 불필요).
 *
 * jimscanner_market_raw.title(커뮤니티/뉴스 발화) + 트렌드 키워드에서
 * '품절/재입고 언제/오픈런/대란/구할 데 없음/배송 2주' 같은 공급실패 렉시콘을
 * 룰로 추출해, 발화 강도(supply_gap)를 부여하고
 * jimscanner_supply_gap_signals 에 upsert 한다.
 *
 * canonical product alias 와 substring 매칭되면 product_id·keyword 연결,
 * 매칭된 product 는 최신 jimscanner_trends_scores.score_components.supply_gap 에 반영.
 *
 * 호출:
 *   node --env-file=.env.local scripts/scan-supply-gap.mjs
 *
 * 요구: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (env)
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

const RAW_FETCH_LIMIT = 4000
const LOOKBACK_DAYS = 30

// 공급실패 렉시콘 — [정규식, 가중치]. 강한 신호일수록 가중치↑.
// 정규식은 공백 변형(품 절 / 재 입고)도 일부 허용하도록 느슨하게.
const LEXICON = [
  [/품\s?절\s?대란|품귀(현상)?|없어서\s?못\s?(사|구|팔)/g, 3],
  [/오픈\s?런|광클|클릭\s?전쟁/g, 3],
  [/대란/g, 2],
  [/재\s?입고\s?(언제|문의|알림|문자|일정|예정)/g, 2.5],
  [/재\s?입고|재입고요?\??/g, 1.5],
  [/품\s?절(됐|되|이래|이라|상태|임박)?/g, 1.5],
  [/매진|솔드\s?아웃|sold\s?out/gi, 1.5],
  [/구할\s?(데|곳|수)\s?(가\s?)?없|구하기?\s?(힘들|어렵|빡)/g, 2.5],
  [/배송\s?(\d+\s?주|지연|밀려|한\s?달|언제)/g, 1.5],
  [/입고\s?(대기|지연|문의|예정)/g, 1.5],
  [/웃돈|프리미엄\s?붙|되팔|리셀|중고가?\s?(가\s?)?더\s?비싸/g, 2],
  [/그\s?가격(에|으로)?\s?(파는\s?)?(데|곳)\s?(가\s?)?없/g, 2.5],
]

const STRONG_HINT = /(품절|재입고|오픈런|대란|품귀|매진|sold|구할|입고|웃돈|리셀|되팔)/i

function scoreTitle(title) {
  if (!title || !STRONG_HINT.test(title)) return null
  let sum = 0
  const terms = new Set()
  for (const [re, w] of LEXICON) {
    re.lastIndex = 0
    const m = title.match(re)
    if (m && m.length) {
      sum += w * Math.min(m.length, 2) // 중복 적중은 2회까지만 가산
      for (const t of m) terms.add(t.replace(/\s+/g, ' ').trim())
    }
  }
  if (sum <= 0) return null
  return { supply_gap: Math.round(sum * 100) / 100, matched_terms: [...terms].slice(0, 8) }
}

// alias 텍스트가 title 에 substring 으로 들어가면 매칭. 가장 긴(구체적) alias 우선.
function matchProduct(title, aliasList) {
  let best = null
  for (const a of aliasList) {
    if (a.alias.length < 2) continue
    if (title.includes(a.alias)) {
      if (!best || a.alias.length > best.alias.length) best = a
    }
  }
  return best
}

async function main() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString()

  // 1) 후보 alias 로드 (product 매칭용)
  const { data: aliases, error: aliasErr } = await sb
    .from('jimscanner_trends_aliases')
    .select('alias, product_id')
    .limit(20000)
  if (aliasErr) console.warn('alias load warn:', aliasErr.message)
  const aliasList = (aliases ?? []).filter((a) => a.alias && a.product_id)

  // 2) market_raw 발화 스캔
  const { data: raws, error: rawErr } = await sb
    .from('jimscanner_market_raw')
    .select('id, source, source_url, title, captured_at')
    .gte('captured_at', since)
    .order('captured_at', { ascending: false })
    .limit(RAW_FETCH_LIMIT)
  if (rawErr) {
    console.error('market_raw load error:', rawErr.message)
    process.exit(1)
  }

  const signals = []
  const productGap = new Map() // product_id -> 합산 gap
  let scanned = 0

  for (const r of raws ?? []) {
    scanned++
    const scored = scoreTitle(r.title)
    if (!scored) continue
    const m = matchProduct(r.title, aliasList)
    const productId = m?.product_id ?? null
    const keyword = m ? null : null // canonical_name 은 별도 조회 — 아래서 채움
    signals.push({
      raw_id: r.id,
      source: r.source,
      source_url: r.source_url,
      snippet: (r.title || '').slice(0, 500),
      matched_terms: scored.matched_terms,
      supply_gap: scored.supply_gap,
      product_id: productId,
      keyword,
      captured_at: r.captured_at,
    })
    if (productId) productGap.set(productId, (productGap.get(productId) ?? 0) + scored.supply_gap)
  }

  // 3) 매칭된 product 의 canonical_name 으로 keyword 채우기
  const matchedIds = [...productGap.keys()]
  if (matchedIds.length) {
    const { data: prods } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name')
      .in('id', matchedIds)
    const nameById = new Map((prods ?? []).map((p) => [p.id, p.canonical_name]))
    for (const s of signals) {
      if (s.product_id) s.keyword = nameById.get(s.product_id) ?? null
    }
  }

  // 4) upsert (raw_id 충돌 시 갱신)
  let upserted = 0
  for (let i = 0; i < signals.length; i += 500) {
    const chunk = signals.slice(i, i + 500)
    const { error } = await sb
      .from('jimscanner_supply_gap_signals')
      .upsert(chunk, { onConflict: 'raw_id' })
    if (error) console.error('upsert error:', error.message)
    else upserted += chunk.length
  }

  // 5) 매칭된 product 의 최신 score row 에 score_components.supply_gap 반영
  let scorePatched = 0
  for (const [productId, gap] of productGap) {
    const { data: latest } = await sb
      .from('jimscanner_trends_scores')
      .select('id, score_components')
      .eq('product_id', productId)
      .order('computed_at', { ascending: false })
      .limit(1)
    const row = latest?.[0]
    if (!row) continue
    const comp = { ...(row.score_components ?? {}) }
    comp.supply_gap = Math.round(gap * 100) / 100
    const { error } = await sb
      .from('jimscanner_trends_scores')
      .update({ score_components: comp })
      .eq('id', row.id)
    if (!error) scorePatched++
  }

  console.log(
    `[scan-supply-gap] scanned=${scanned} signals=${signals.length} upserted=${upserted} ` +
      `matchedProducts=${matchedIds.length} scorePatched=${scorePatched}`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
