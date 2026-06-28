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
import { openCoupangSession } from './lib/market-price.mjs'

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
const LIMIT = parseInt(getArg('limit', '10'))           // 쿠팡 차단방지: 기본 소수만
const SLEEP_MS = parseInt(getArg('sleep', '8000'))      // 쿠팡 검색 사이 기본 지연(ms) +0~4s 지터
const MIN_REVIEWS = parseInt(getArg('min-reviews', '10')) // 후기 N개 미만 = 판매검증 부족 → 보류(흑자후보 제외)
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

// 쿠팡 아이템위너 '타깃 상품' 선정 = TV상품명과 유사하면서 '실제 팔리는'(후기 많은) 상품 우선
function pickCoupangTarget(items, tvName) {
  const cand = (items || [])
    .map((it) => ({ price: it.price, title: it.title || '', reviews: it.reviews ?? 0, rating: it.rating ?? null, s: sim(tvName, it.title || '') }))
    .filter((it) => it.price > 0 && it.s >= 0.25)
  if (!cand.length) return null
  cand.sort((a, b) => (b.reviews || 0) - (a.reviews || 0) || b.s - a.s) // 후기수 우선(동률이면 유사도)
  return cand[0]
}

// 네이버에서 '그 타깃 상품'의 최저가(소싱가) — 타깃 제목으로 검색·엄격매칭(같은 SKU/수량)
const SAME_SKU = 0.5 // 타깃 제목 ↔ 네이버 결과 유사도 하한(수량/세트 다르면 탈락)
async function naverSourcingFor(targetTitle) {
  const q = (targetTitle || '').replace(/[\[\]]/g, ' ').slice(0, 60).trim()
  if (q.length < 4) return null
  const r = await fetch(`https://openapi.naver.com/v1/search/shop.json?display=40&sort=asc&query=${encodeURIComponent(q)}`, { headers: { 'X-Naver-Client-Id': NID, 'X-Naver-Client-Secret': NSEC } })
  if (r.status !== 200) return null
  const j = await r.json()
  const items = (j.items || []).map((it) => { const title = (it.title || '').replace(/<[^>]+>/g, ''); return { price: parseInt(it.lprice) || 0, mall: it.mallName, title, s: sim(targetTitle, title) } }).filter((x) => x.price > 0)
  const same = items.filter((x) => x.s >= SAME_SKU).sort((a, b) => a.price - b.price)
  if (!same.length) return null
  return { low: same[0].price, lowMall: same[0].mall, n: same.length }
}

function verdict(P, S) {
  if (!P || !S) return null
  const fee = Math.round(P * FEE)
  const net = P - S - fee
  return { coupang: P, source: S, fee, net, rate: Math.round((net / P) * 1000) / 10 }
}

const REAL_MAX_RATE = 30 // 브랜드 리테일 아비트라지 마진은 얇음 — 30% 초과 = SKU 불일치(다른 수량/세트) 의심
async function screenOne(kw, cpSession) {
  const name = cleanTv(kw)
  // 1) 쿠팡 타깃(아이템위너 대상) 선정 — 세션 페이지 재사용(검색란만 교체)
  let target = null
  if (COUPANG_MANUAL) target = { price: COUPANG_MANUAL, title: name, s: 1 }
  else if (cpSession) { const c = await cpSession.search(name); target = pickCoupangTarget(c?.items, name) }
  if (!target) { console.log(`  🔎 "${name}" 쿠팡 타깃 못찾음 (크롬 9222 or --coupang)`); return cpSession ? { blocked: true } : null }
  // 2) 그 타깃 상품의 네이버 최저가(소싱가)
  const src = await naverSourcingFor(target.title)
  if (!src) { console.log(`  · "${name}" → ${target.title.slice(0, 28)} | 네이버 같은상품 없음(소싱 불가)`); return null }
  const v = verdict(target.price, src.low)
  if (!v) { console.log(`  🔎 "${name}" → ${target.title.slice(0, 28)} | 가격 확인 불가`); return null }
  // 3) SKU 불일치 가드: 마진이 비현실적으로 높으면(>30%) 다른 SKU 의심
  const skuDoubt = v.rate > REAL_MAX_RATE
  const weakDemand = (target.reviews || 0) < MIN_REVIEWS // 후기 부족 = 판매검증 안 됨
  const tag = v.net <= 0 ? '❌' : (skuDoubt || weakDemand) ? '⚠' : '✅'
  const rv = `후기 ${target.reviews ?? '?'}${target.rating != null ? `·${target.rating}★` : ''}`
  const flags = `${skuDoubt ? ' ⚠SKU의심' : ''}${weakDemand ? ' ⚠후기부족' : ''}`
  console.log(`  ${tag} "${name}" → ${target.title.slice(0, 22)} | 쿠팡 ${target.price.toLocaleString()} − 소싱 ${src.low.toLocaleString()}(${src.lowMall}) − 수수료 ${v.fee.toLocaleString()} = ${v.net > 0 ? '+' : ''}${v.net.toLocaleString()} (${v.rate}%) | ${rv}${flags}`)
  return { name, target: target.title, coupang: target.price, source_low: src.low, source_mall: src.lowMall, naver_same: src.n, reviews: target.reviews ?? null, rating: target.rating ?? null, ...(v || {}), skuDoubt, weakDemand }
}

async function main() {
  if (!NID || !NSEC) { console.error('NAVER_OPENAPI 키 없음'); process.exit(1) }
  console.log(`=== TV 아이템위너 PoC 스크리너 (수수료 ${FEE * 100}%) ===`)
  const cdpUp = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false)
  const useCp = cdpUp && !COUPANG_MANUAL
  // 쿠팡 세션 1회 오픈 → 이후 검색은 같은 페이지 검색란만 교체(새 탭/메인 재진입 없음 → 재차단↓). 수동가면 불필요.
  const cp = useCp ? await openCoupangSession() : null
  console.log(cp ? '쿠팡 CDP 사용(페이지 재사용·검색란 교체)' : (COUPANG_MANUAL ? `쿠팡가 수동 ${COUPANG_MANUAL.toLocaleString()}원` : '쿠팡 CDP 미가동 → --coupang 수동 or 크롬 9222'))
  if (useCp && !cp) console.log('⚠ 쿠팡 세션 열기 실패(미가동/차단) — 잠시 쉬었다 그 프로필로 쿠팡 1회 정상접속 후 재시도')

  try {
    if (SINGLE) { await screenOne(SINGLE, cp); return }

    const since = new Date(Date.now() - DAYS * 864e5).toISOString()
    const { data } = await sb.from('jimscanner_trends_keywords').select('keyword').eq('source', 'naver_tvtime').gte('collected_at', since).limit(300)
    const seen = new Set(), names = []
    for (const r of data || []) { const n = cleanTv(r.keyword); if (looksProduct(n) && !seen.has(n)) { seen.add(n); names.push(n) } }
    console.log(`TV 편성 상품(필러 제외) ${names.length}개 중 상위 ${Math.min(LIMIT, names.length)} 스크린\n`)
    const rows = []
    const targets = names.slice(0, LIMIT)
    let blockStreak = 0
    for (let i = 0; i < targets.length; i++) {
      const r = await screenOne(targets[i], cp)
      if (r && r.blocked) {
        if (++blockStreak >= 3) { console.log('\n⛔ 쿠팡 연속 미응답 3회 — 재차단 의심. 중단(잠시 쉬었다 그 프로필로 쿠팡 1회 정상접속 후 재시도).'); break }
      } else { blockStreak = 0; if (r && !r.blocked) rows.push(r) }
      // 쿠팡 검색 사이 지연(+지터)으로 재차단 방지. 마지막 건 제외.
      if (cp && i < targets.length - 1) {
        const wait = SLEEP_MS + Math.floor(Math.random() * 4000)
        console.log(`     … ${Math.round(wait / 1000)}s 대기(차단방지)`)
        await new Promise((res) => setTimeout(res, wait))
      }
    }
    const clean = rows.filter((r) => r.net > 0 && !r.skuDoubt && !r.weakDemand)
    const flagged = rows.filter((r) => r.net > 0 && (r.skuDoubt || r.weakDemand))
    const loss = rows.filter((r) => r.net <= 0)
    console.log(`\n=== 스크린 ${rows.length} | ✅흑자후보 ${clean.length} | ⚠보류(SKU/후기) ${flagged.length} | ❌적자 ${loss.length} ===`)
    if (clean.length) {
      console.log(`\n── ✅ 흑자 후보 (후기≥${MIN_REVIEWS}, 마진순) ──`)
      clean.sort((a, b) => b.rate - a.rate).forEach((r) => console.log(`  +${r.rate}% | 후기 ${r.reviews}${r.rating != null ? `·${r.rating}★` : ''} | 쿠팡 ${r.coupang.toLocaleString()} / 소싱 ${r.source_low.toLocaleString()}(${r.source_mall}) | ${r.name} → ${r.target.slice(0, 26)}`))
    }
    if (!cp && !COUPANG_MANUAL) console.log('\n※ 쿠팡가 미확인 — 크롬 9222 띄우거나 --coupang 으로 확인')
  } finally {
    if (cp) await cp.close()
  }
}
main().catch((e) => { console.error('PoC 오류:', e instanceof Error ? e.stack : e); process.exit(1) })
