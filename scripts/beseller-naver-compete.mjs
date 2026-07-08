/**
 * 비셀러 ↔ 네이버 스마트스토어 가격경쟁력 태깅.
 *   node --env-file=.env.local scripts/beseller-naver-compete.mjs [--limit=N] [--sleep=300] [--cate=004] [--only-new] [--dry]
 *
 * 규칙(사용자 지정): 네이버는 그룹 최저옵션 가격을 노출 → 우리도 그룹 최저옵션(active·공급가 최저)으로 비교.
 *   검색어 = 최저옵션 제목(정제) → 네이버 쇼핑 OpenAPI → 동일SKU(bigram≥0.4) 최저 lprice
 *   margin_at_low = round(lprice × (1-FEE)) - 공급가  (식품 면세, 배송 중립)
 *   등급 strong≥25% / ok≥12% / weak≥0 / none. MSP < market_low 면 하향(못 맞춤).
 * 결과 → jimscanner_beseller_price_compare (group_key PK).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { naverShopMedian } from './lib/market-price.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const DRY = process.argv.includes('--dry')
const ONLY_NEW = process.argv.includes('--only-new')
const CATE = process.argv.find(a => a.startsWith('--cate='))?.split('=')[1] || null
const LIMIT = +(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || 0)
const SLEEP = +(process.argv.find(a => a.startsWith('--sleep='))?.split('=')[1] || 320)
const sleep = ms => new Promise(s => setTimeout(s, ms))

const FEE = 0.06  // 스마트스토어 매출연동 2% + 네이버페이 결제 ~3.6%
const GRADE = (rate, count, mspViolation) => {
  if (rate == null || rate < 0) return 'none'
  if (mspViolation) return rate >= 0 ? 'weak' : 'none'
  if (count >= 3 && rate >= 0.25) return 'strong'
  if (count >= 3 && rate >= 0.12) return 'ok'
  return 'weak'
}

// 검색어 정제: 마케팅 접두(100%/국내산 등 유지가 이득이나 노이즈 토큰만 제거), 대괄호 제거
function cleanQuery(title) {
  return String(title || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(정품|무료배송|당일발송|특가|세일|이벤트)\b/g, ' ')
    .replace(/\s+/g, ' ').trim()
}
// bigram 유사도 (same-SKU 판정)
const norm = s => String(s || '').toLowerCase().replace(/[^가-힣a-z0-9]/g, '')
function bigrams(s) { const t = norm(s); const g = new Set(); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g }
function sim(a, b) { const A = bigrams(a), B = bigrams(b); if (!A.size || !B.size) return 0; let n = 0; for (const x of A) if (B.has(x)) n++; return (2 * n) / (A.size + B.size) }
// 무게/수량 토큰 추출 (규격 일치 가점)
const specToken = s => (String(s || '').match(/\d+(?:\.\d+)?\s*(?:kg|g|ml|l|미|마리|포|입|개|봉|박스|구|과|병|통|팩)/i) || [])[0]?.replace(/\s/g, '').toLowerCase() || null

// ── 그룹별 최저옵션 로드 (active만, 공급가>0) ──
async function loadGroups() {
  const rows = []
  for (let off = 0; off < 50000; off += 1000) {
    let q = sb.from('jimscanner_beseller_products').select('branduid, title, group_key, cate_label, supply_price, min_sell_price, status').range(off, off + 999)
    const { data } = await q
    rows.push(...(data || []))
    if ((data || []).length < 1000) break
  }
  const groups = new Map()
  for (const r of rows) {
    if (r.status !== 'active' || !(r.supply_price > 0) || !r.group_key) continue
    if (CATE && r.cate_label && !r.cate_label.includes(CATE)) { /* cate 필터는 라벨포함(코드아님) */ }
    const cur = groups.get(r.group_key)
    if (!cur || r.supply_price < cur.supply_price) groups.set(r.group_key, r)
  }
  return [...groups.values()]
}

const reps = await loadGroups()
let targets = reps
if (CATE) targets = targets.filter(r => (r.cate_label || '') === CATE || (r.cate_label || '').includes(CATE))
if (ONLY_NEW) {
  const { data: done } = await sb.from('jimscanner_beseller_price_compare').select('group_key')
  const set = new Set((done || []).map(d => d.group_key))
  targets = targets.filter(r => !set.has(r.group_key))
}
if (LIMIT) targets = targets.slice(0, LIMIT)
console.log(`대상 그룹 ${targets.length}개 (전체 ${reps.length}) ${DRY ? '[DRY]' : ''}\n`)

let strong = 0, ok = 0, weak = 0, none = 0, fail = 0
for (const r of targets) {
  try {
    const query = cleanQuery(r.title)
    const res = await naverShopMedian(query, { display: 40 })
    const ourSpec = specToken(r.title)
    // 동일 SKU: 이름 유사도 + (규격 있으면) 규격 일치
    let matches = (res.items || []).filter(it => {
      const s = sim(r.title, it.title)
      if (s < 0.40) return false
      if (ourSpec) { const t = specToken(it.title); if (t && t !== ourSpec) return false }
      return true
    })
    let lowConf = false
    if (matches.length < 3) { // 매칭 부족 → 이름유사도만으로 완화(저신뢰)
      const relaxed = (res.items || []).filter(it => sim(r.title, it.title) >= 0.30)
      if (relaxed.length >= matches.length) { matches = relaxed; lowConf = true }
    }
    const prices = matches.map(m => m.price).filter(n => n > 0).sort((a, b) => a - b)
    const count = prices.length
    const market_min = prices[0] ?? null
    // 경쟁 기준가 = 하위 20분위(절대 최저 셀러 아닌 "경쟁 가격대"). 표본 적으면 최저가.
    const market_low = count >= 5 ? prices[Math.floor(count * 0.20)] : market_min
    let margin_at_low = null, margin_rate = null, mspViolation = false
    if (market_low) {
      margin_at_low = Math.round(market_low * (1 - FEE)) - r.supply_price
      margin_rate = +(margin_at_low / market_low).toFixed(3)
      if (r.min_sell_price > 0 && market_low < r.min_sell_price) mspViolation = true
    }
    const grade = market_low ? GRADE(margin_rate, count, mspViolation) : 'none'
    const lowMall = matches.find(m => m.price === market_low)
    const row = {
      group_key: r.group_key, rep_branduid: r.branduid, rep_title: r.title, cate_label: r.cate_label,
      our_supply: r.supply_price, market_low, market_mall: lowMall?.mall || null, market_count: count,
      margin_at_low, margin_rate, grade, query, low_confidence: lowConf || mspViolation, checked_at: new Date().toISOString(),
    }
    const icon = { strong: '🏆', ok: '✅', weak: '🟡', none: '·' }[grade]
    console.log(`  ${icon} ${grade.padEnd(6)} ${r.title.slice(0, 30).padEnd(30)} 공급 ${r.supply_price} vs 네이버 ${market_low ?? '-'} (${count}) 마진 ${margin_rate != null ? (margin_rate * 100).toFixed(0) + '%' : '-'}${lowConf ? ' ~저신뢰' : ''}${mspViolation ? ' MSP위반' : ''}`)
    if (!DRY) { const { error } = await sb.from('jimscanner_beseller_price_compare').upsert(row, { onConflict: 'group_key' }); if (error) console.log(`     upsert ERR: ${error.message}`) }
    grade === 'strong' ? strong++ : grade === 'ok' ? ok++ : grade === 'weak' ? weak++ : none++
    await sleep(SLEEP)
  } catch (e) { fail++; if (fail <= 5) console.log(`  ✗ ${r.group_key}: ${e.message}`); await sleep(SLEEP) }
}
console.log(`\n=== 완료 === 🏆강력 ${strong} / ✅경쟁 ${ok} / 🟡약함 ${weak} / none ${none} / 실패 ${fail} ${DRY ? '[DRY]' : ''}`)
