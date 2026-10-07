/**
 * P0.5 쿠팡 시장성 스캔 — 화장품스토리 등록 후보를 쿠팡에서 검색해 같은 상품 리셀러(가격·후기)를 보고 verdict 를 매긴다.
 *   node scripts/cmtstory-market-scan.mjs [--limit=N] [--only=…] [--force] [--dry]
 * 전제: 워밍업된 사용자 크롬(CDP 9222) — scripts/launch-chrome-debug.cmd 로 띄우고 쿠팡 메인을 한 번 연 상태([[price_lookup_via_cdp]]).
 * 속도: 검색 간 6~10초(--delay=ms) + 결과 스크롤 흉내 + 15건마다 30~60초 휴식 — 2026-10-07 사용자 요청(빨리 돌리면 차단).
 *
 * verdict (jimscanner_cmtstory_products.market_verdict):
 *   OPEN    — 검색 결과에 같은 상품(제목 유사도 ≥ 0.55)이 없음 → 리셀러 경쟁 없음(또는 수요 없음), 우선 등록
 *   WIN     — 같은 상품이 있고 우리 1개 판매가 ≤ 최저가 → 아이템위너 가능
 *   LOSE    — 같은 상품이 더 싸게 있음 → 묶음으로만 승부하거나 보류
 *   UNKNOWN — 검색 실패/차단
 * market jsonb 에 {count, median, matched:[{title,price,reviews}], min_matched, our_price} 저장. --force 없으면 이미 본 상품은 건너뜀.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { openCoupangSession } from './lib/market-price.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const TABLE = 'jimscanner_cmtstory_products'
const args = process.argv.slice(2)
const argOf = k => args.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')
const DRY = args.includes('--dry'), FORCE = args.includes('--force')
const LIMIT = +(argOf('limit') || 0) || 0
const ONLY = (argOf('only') || '').split(',').map(s => s.trim()).filter(s => /^\d{1,12}$/.test(s))
const SIM_MIN = 0.55
const DELAY = Math.max(2000, +(argOf('delay') || 6000))
const sleep = ms => new Promise(s => setTimeout(s, ms))

// 제목 유사도 — 띄어쓰기·기호 무시 글자쌍(bigram) Dice 계수(K홀세일 수집기와 같은 방식). 브랜드명이 다르면 자연히 떨어진다.
const norm = s => String(s || '').toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/[^0-9a-z가-힣]/g, '')
const bigrams = s => { const n = norm(s); const m = new Map(); for (let i = 0; i < n.length - 1; i++) { const g = n.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1) } return m }
function similarity(a, b) {
  const A = bigrams(a), B = bigrams(b)
  let inter = 0, ta = 0, tb = 0
  for (const v of A.values()) ta += v
  for (const v of B.values()) tb += v
  for (const [g, v] of A) inter += Math.min(v, B.get(g) || 0)
  return ta && tb ? (2 * inter) / (ta + tb) : 0
}
// 검색어 — 상품명에서 용량·매수 토큰과 괄호를 빼면 쿠팡 검색이 더 잘 맞는다
const queryOf = t => String(t || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/(^|\s)\d+(\.\d+)?\s*(ml|g|kg|l|매|장|개입|입|p)(?![가-힣a-z])/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)

let q = sb.from(TABLE).select('goods_no, title_clean, sale_prices, market_checked_at, coupang_eligible').eq('coupang_eligible', true)
if (ONLY.length) q = q.in('goods_no', ONLY)
const { data: rows, error } = await q
if (error) { console.error(error.message); process.exit(1) }
let targets = (rows ?? []).filter(r => FORCE || !r.market_checked_at)
if (LIMIT) targets = targets.slice(0, LIMIT)
console.log(`대상 ${targets.length}건 (후보 ${rows.length}, 이미 확인 ${rows.length - (rows ?? []).filter(r => !r.market_checked_at).length})`)
if (!targets.length) process.exit(0)

const session = await openCoupangSession()
if (!session) { console.error('✗ 쿠팡 세션 없음 — scripts/launch-chrome-debug.cmd 로 디버그 크롬을 띄우고 쿠팡 메인을 한 번 연 뒤 다시 실행'); process.exit(1) }
const stats = { OPEN: 0, WIN: 0, LOSE: 0, UNKNOWN: 0 }
try {
  for (let i = 0; i < targets.length; i++) {
    const r = targets[i]
    const our = r.sale_prices?.['1']?.price ?? null
    const kw = queryOf(r.title_clean)
    const res = await session.search(kw, { scroll: true })   // 검색 후 휠로 내려갔다 올라오기(사람 흉내)
    let verdict = 'UNKNOWN', market = null
    if (res) {
      const matched = (res.items ?? []).filter(it => similarity(it.title, r.title_clean) >= SIM_MIN).sort((a, b) => a.price - b.price).slice(0, 8)
      const minMatched = matched.length ? matched[0].price : null
      verdict = !matched.length ? 'OPEN' : (our != null && our <= minMatched ? 'WIN' : 'LOSE')
      market = { query: kw, count: res.count, median: res.median, matched, min_matched: minMatched, our_price: our, top_reviews: Math.max(0, ...matched.map(m => m.reviews || 0)) }
    }
    stats[verdict]++
    console.log(`[${i + 1}/${targets.length}] ${verdict.padEnd(7)} ${r.goods_no} ${r.title_clean.slice(0, 30).padEnd(30)} 우리 ${our ?? '-'} | 검색 ${res?.count ?? '-'}건 중앙 ${res?.median ?? '-'} | 동일 ${market?.matched.length ?? '-'}건 최저 ${market?.min_matched ?? '-'} 후기 ${market?.top_reviews ?? '-'}`)
    if (!DRY) {
      const { error: uErr } = await sb.from(TABLE).update({ market, market_verdict: verdict, market_checked_at: new Date().toISOString() }).eq('goods_no', r.goods_no)
      if (uErr) console.log(`  ✗ 저장 실패 ${uErr.message}`)
    }
    if (verdict === 'UNKNOWN' && i >= 2 && stats.UNKNOWN >= 3 && stats.OPEN + stats.WIN + stats.LOSE === 0) { console.error('✗ 연속 검색 실패 — 쿠팡 차단 의심, 중단'); break }
    // 사람 속도로 — 기본 6~10초, 15건마다 30~60초 휴식(--delay=ms 로 기본 간격 조정). 빠르면 Akamai 차단(Access Denied)으로 세션째 막힌다.
    await sleep(DELAY + Math.random() * 4000)
    if ((i + 1) % 15 === 0 && i + 1 < targets.length) { const rest = 30000 + Math.random() * 30000; console.log(`  … 휴식 ${Math.round(rest / 1000)}초`); await sleep(rest) }
  }
} finally { await session.close() }
console.log(`\n=== OPEN ${stats.OPEN} · WIN ${stats.WIN} · LOSE ${stats.LOSE} · UNKNOWN ${stats.UNKNOWN} ===`)
