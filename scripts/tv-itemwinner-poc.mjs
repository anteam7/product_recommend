/**
 * PoC: TV홈쇼핑 편성 브랜드상품 → 최저가(소싱가) → 쿠팡 아이템위너 마진 스크리너.
 * 전략(전자책 Ch8): 홈쇼핑에서 미리 방영되는 브랜드 상품을 최저가에 떼어(위탁) 쿠팡 아이템위너로 매칭.
 *   핵심 경제성 = 쿠팡 현재가 P − 네이버 최저가(소싱가) S − 쿠팡수수료 P×fee  > 0  (가격 '갭'이 있는 상품만 흑자)
 *
 * 사용:
 *   node --env-file=.env.local scripts/tv-itemwinner-poc.mjs                 # 최근 TV편성 상품 일괄 스크린
 *   node --env-file=.env.local scripts/tv-itemwinner-poc.mjs --kw="테팔 인텐시브 프라이팬" --coupang=29900
 *   옵션: --days=14 --limit=25 --fee=0.108
 *
 * 쿠팡가: 크롬을 9222로 띄워두면 CDP(사람처럼 검색)로 자동 조회, 없으면 네이버 최저가만 보여주고 쿠팡가는 수동 입력(--coupang) 대상.
 * 이건 발굴/판정 PoC다. 실제 아이템위너 '붙음' 여부는 Wing 등록 1건으로 별도 검증해야 한다(카탈로그 매칭=브랜드·모델·바코드).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { coupangMedianViaCDP } from './lib/market-price.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const NID = env.NAVER_OPENAPI_CLIENT_ID, NSEC = env.NAVER_OPENAPI_CLIENT_SECRET

const args = process.argv.slice(2)
const getArg = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const DAYS = parseInt(getArg('days', '14'))
const LIMIT = parseInt(getArg('limit', '25'))
const FEE = parseFloat(getArg('fee', '0.108'))
const SINGLE = getArg('kw', '')
const COUPANG_MANUAL = parseInt(getArg('coupang', '')) || null

// 편성 필러(상품 아님) 제거 + 상품명 정리
const FILLER = /(베스트|앵콜|재방|다시보는|인기상품|히트상품|심야|편성|특집|상생|중소기업|아이러브)/
function cleanTv(s) {
  let t = (s || '').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim()
  t = t.split('/')[0].trim() // "A/B/C" 구성 나열 → 첫 상품
  return t
}
function looksProduct(s) { return s.length >= 4 && !FILLER.test(s) }

// 제목 유사도(같은 상품끼리 비교용 정합화) — bigram
const norm = (s) => (s || '').toLowerCase().replace(/[^가-힣a-z0-9]+/g, '')
function bigrams(s) { const t = norm(s); const g = new Set(); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g }
function sim(a, b) { const A = bigrams(a), B = bigrams(b); if (!A.size || !B.size) return 0; let c = 0; for (const x of A) if (B.has(x)) c++; return 2 * c / (A.size + B.size) }
const ANCHOR = 0.25 // TV상품명↔검색결과 제목 유사도 하한(악세서리·오매칭 제거)

// 네이버 쇼핑: TV상품명과 '같은 상품'들 중 최저가(소싱가) + 판매처
async function naverSourcing(name) {
  const r = await fetch(`https://openapi.naver.com/v1/search/shop.json?display=40&sort=asc&query=${encodeURIComponent(name)}`, { headers: { 'X-Naver-Client-Id': NID, 'X-Naver-Client-Secret': NSEC } })
  if (r.status !== 200) return null
  const j = await r.json()
  const items = (j.items || []).map((it) => { const title = (it.title || '').replace(/<[^>]+>/g, ''); return { price: parseInt(it.lprice) || 0, mall: it.mallName, title, s: sim(name, title) } }).filter((x) => x.price > 0)
  const same = items.filter((x) => x.s >= ANCHOR)
  const pool = (same.length ? same : items).sort((a, b) => a.price - b.price)
  if (!pool.length) return null
  return { low: pool[0].price, lowMall: pool[0].mall, anchored: same.length > 0, n: same.length, total: j.total }
}

// 쿠팡: TV상품명과 가장 유사한 상품(=아이템위너로 붙을 동일상품)의 현재가
function coupangAnchor(items, name) {
  let best = null, bs = ANCHOR
  for (const it of items || []) { const s = sim(name, it.title || ''); if (it.price > 0 && s >= bs) { bs = s; best = it.price } }
  return best
}

function verdict(P, S) {
  if (!P || !S) return null
  const fee = Math.round(P * FEE)
  const net = P - S - fee
  return { coupang: P, source: S, fee, net, rate: Math.round((net / P) * 1000) / 10 }
}

async function screenOne(kw, cdpUp) {
  const name = cleanTv(kw)
  const nv = await naverSourcing(name)
  if (!nv) { console.log(`  · "${name}" 네이버 결과 없음`); return null }
  let P = COUPANG_MANUAL
  if (!P && cdpUp) { const c = await coupangMedianViaCDP(name); P = coupangAnchor(c?.items, name) }
  const v = verdict(P, nv.low)
  const tag = v ? (v.net > 0 ? '✅' : '❌') : '🔎'
  const anc = nv.anchored ? `같은상품 ${nv.n}` : '⚠오매칭가능'
  const mline = v ? `쿠팡 ${P.toLocaleString()} − 소싱 ${nv.low.toLocaleString()} − 수수료 ${v.fee.toLocaleString()} = ${v.net > 0 ? '+' : ''}${v.net.toLocaleString()} (${v.rate}%)`
    : `네이버최저(소싱) ${nv.low.toLocaleString()} (${nv.lowMall}) · 쿠팡가 확인필요`
  console.log(`  ${tag} "${name}" | ${mline} | ${anc}`)
  return { name, source_low: nv.low, source_mall: nv.lowMall, anchored: nv.anchored, ...(v || {}) }
}

async function main() {
  if (!NID || !NSEC) { console.error('NAVER_OPENAPI 키 없음'); process.exit(1) }
  console.log(`=== TV 아이템위너 PoC 스크리너 (수수료 ${FEE * 100}%) ===`)
  const cdpUp = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false)
  console.log(cdpUp ? '쿠팡 CDP 사용(자동 쿠팡가)' : '쿠팡 CDP 미가동 → 네이버 최저가만(쿠팡가는 --coupang 수동 or 크롬 9222)')

  if (SINGLE) { await screenOne(SINGLE, cdpUp); return }

  const since = new Date(Date.now() - DAYS * 864e5).toISOString()
  const { data } = await sb.from('jimscanner_trends_keywords').select('keyword').eq('source', 'naver_tvtime').gte('collected_at', since).limit(300)
  const seen = new Set(), names = []
  for (const r of data || []) { const n = cleanTv(r.keyword); if (looksProduct(n) && !seen.has(n)) { seen.add(n); names.push(n) } }
  console.log(`TV 편성 상품(필러 제외) ${names.length}개 중 상위 ${Math.min(LIMIT, names.length)} 스크린\n`)
  const rows = []
  for (const n of names.slice(0, LIMIT)) { const r = await screenOne(n, cdpUp); if (r) rows.push(r) }
  const profitable = rows.filter((r) => r.net > 0)
  console.log(`\n=== 스크린 ${rows.length} | 흑자 ${profitable.length} | 쿠팡가미확인 ${rows.filter((r) => r.net == null).length} ===`)
  if (!cdpUp && !COUPANG_MANUAL) console.log('※ 쿠팡가 미확인이라 흑자판정 보류 — 크롬 9222 띄우거나 후보별 --coupang 으로 확인')
}
main().catch((e) => { console.error('PoC 오류:', e instanceof Error ? e.stack : e); process.exit(1) })
