/**
 * 통합 아이템위너 스크리너 (전자책 Ch8): 홈쇼핑모아 방송상품 → 다중소스 소싱가 vs 쿠팡 판매가/후기.
 *
 *   ① hsmoa 방송상품(상품명 + 방송가) 수집
 *   ② 각 상품: 소싱가 후보 = min(방송가, 네이버 최저, 에누리 최저)  ← 같은 SKU(제목유사도)만
 *   ③ 쿠팡 아이템위너가 + 후기(판매검증)   ← 후기 많은=실제 팔리는 상품 우선
 *   ④ 마진 = 쿠팡가 − 소싱가 − 수수료. 흑자 & 후기충분 & 같은SKU = 진짜 후보.
 *
 * 사용:
 *   node --env-file=.env.local scripts/hsmoa-itemwinner.mjs                  # 기본
 *   ... --limit=8 --sleep=10000 --min-reviews=10 --fee=0.108
 *   ... --no-coupang        # 쿠팡 생략(네이버·에누리·방송가만)
 *
 * 쿠팡가는 워밍업 크롬(9222)으로 사람처럼 검색. launch-chrome-debug.cmd 로 띄우고 쿠팡 1회 접속 후 실행.
 * 에누리/hsmoa는 헤드리스(차단 없음). 쿠팡만 throttle 대상.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { openCoupangSession, openEnuriSession } from './lib/market-price.mjs'
import { fetchHsmoaProducts } from './lib/hsmoa.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }),
)
const NID = env.NAVER_OPENAPI_CLIENT_ID, NSEC = env.NAVER_OPENAPI_CLIENT_SECRET

const args = process.argv.slice(2)
const flag = (k) => args.includes(`--${k}`)
const getArg = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const LIMIT = parseInt(getArg('limit', '8'))
const SLEEP_MS = parseInt(getArg('sleep', '9000'))
const MIN_REVIEWS = parseInt(getArg('min-reviews', '10'))
const FEE = parseFloat(getArg('fee', '0.108'))
const USE_COUPANG = !flag('no-coupang')
const SAME_SKU = 0.5   // 소싱가 같은 SKU 매칭 하한
const REAL_MAX_RATE = 30 // 브랜드 아비트라지 마진 상한(초과=SKU 불일치 의심)

// 유사도(bigram)
const norm = (s) => (s || '').toLowerCase().replace(/[^가-힣a-z0-9]+/g, '')
function bigrams(s) { const t = norm(s); const g = new Set(); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g }
function sim(a, b) { const A = bigrams(a), B = bigrams(b); if (!A.size || !B.size) return 0; let c = 0; for (const x of A) if (B.has(x)) c++; return 2 * c / (A.size + B.size) }
const lowestSame = (items, name, key = 'price') => { const m = (items || []).filter((it) => it[key] > 0 && sim(name, it.title || '') >= SAME_SKU).map((it) => it[key]); return m.length ? Math.min(...m) : null }

// 네이버 최저가(같은 SKU) + 판매처
async function naverLow(name) {
  try {
    const r = await fetch(`https://openapi.naver.com/v1/search/shop.json?display=40&sort=asc&query=${encodeURIComponent(name)}`, { headers: { 'X-Naver-Client-Id': NID, 'X-Naver-Client-Secret': NSEC } })
    if (r.status !== 200) return null
    const j = await r.json()
    const items = (j.items || []).map((it) => ({ title: (it.title || '').replace(/<[^>]+>/g, ''), price: parseInt(it.lprice) || 0, mall: it.mallName }))
    const same = items.filter((it) => it.price > 0 && sim(name, it.title) >= SAME_SKU).sort((a, b) => a.price - b.price)
    return same.length ? { low: same[0].price, mall: same[0].mall } : null
  } catch { return null }
}

// 쿠팡 타깃: 같은상품 중 후기 많은(실제 팔리는) 것
function pickCoupangTarget(items, name) {
  const cand = (items || []).map((it) => ({ ...it, s: sim(name, it.title || '') })).filter((it) => it.price > 0 && it.s >= 0.25)
  if (!cand.length) return null
  cand.sort((a, b) => (b.reviews || 0) - (a.reviews || 0) || b.s - a.s)
  return cand[0]
}

async function main() {
  if (!NID || !NSEC) { console.error('NAVER_OPENAPI 키 없음'); process.exit(1) }
  console.log(`=== 통합 아이템위너 스크리너 (수수료 ${FEE * 100}% · 후기≥${MIN_REVIEWS}) ===`)
  console.log('① hsmoa 방송상품 수집…')
  const products = await fetchHsmoaProducts({ limit: 60 })
  console.log(`   ${products.length}개 수집. 상위 ${Math.min(LIMIT, products.length)} 스크린\n`)

  const cp = USE_COUPANG ? await openCoupangSession() : null
  if (USE_COUPANG && !cp) console.log('⚠ 쿠팡 세션 실패(미가동/차단) — 쿠팡가 없이 진행(소싱가만 비교)')
  const en = await openEnuriSession()
  if (!en) console.log('⚠ 에누리 세션 실패 — 네이버·방송가만')

  const rows = []
  const targets = products.slice(0, LIMIT)
  let blockStreak = 0
  try {
    for (let i = 0; i < targets.length; i++) {
      const p = targets[i]
      const [nv, enr] = await Promise.all([naverLow(p.name), en ? en.search(p.name) : null])
      const naverP = nv?.low ?? null
      const enuriP = en ? lowestSame(enr?.items, p.name) : null
      const sourcing = [['방송', p.price], ['네이버', naverP], ['에누리', enuriP]].filter(([, v]) => v > 0)
      const [srcLabel, srcLow] = sourcing.reduce((a, b) => (b[1] < a[1] ? b : a), sourcing[0] || [null, null])

      let target = null
      if (cp) { const c = await cp.search(p.name); if (!c) { if (++blockStreak >= 3) { console.log('\n⛔ 쿠팡 연속 미응답 3회 — 중단(잠시 쉬었다 재시도)'); break } } else { blockStreak = 0; target = pickCoupangTarget(c.items, p.name) } }
      const coupangP = target?.price ?? null
      const reviews = target?.reviews ?? null

      // 출력 라인: 4소스 가격
      const priceStr = `방송 ${p.price.toLocaleString()} / 네이버 ${naverP ? naverP.toLocaleString() : '-'} / 에누리 ${enuriP ? enuriP.toLocaleString() : '-'} / 쿠팡 ${coupangP ? coupangP.toLocaleString() : '-'}`
      let verdict = '', tag = '🔎'
      if (coupangP && srcLow) {
        const fee = Math.round(coupangP * FEE)
        const net = coupangP - srcLow - fee
        const rate = Math.round((net / coupangP) * 1000) / 10
        const skuDoubt = rate > REAL_MAX_RATE
        const weakDemand = (reviews || 0) < MIN_REVIEWS
        tag = net <= 0 ? '❌' : (skuDoubt || weakDemand) ? '⚠' : '✅'
        verdict = ` → 소싱 ${srcLow.toLocaleString()}(${srcLabel}) − 수수료 ${fee.toLocaleString()} = ${net > 0 ? '+' : ''}${net.toLocaleString()} (${rate}%) | 후기 ${reviews ?? '?'}${skuDoubt ? ' ⚠SKU' : ''}${weakDemand ? ' ⚠후기부족' : ''}`
        rows.push({ name: p.name, broadcast: p.price, naver: naverP, enuri: enuriP, coupang: coupangP, srcLow, srcLabel, net, rate, reviews, skuDoubt, weakDemand })
      }
      console.log(`  ${tag} ${p.name.slice(0, 26)} | ${priceStr}${verdict}`)
      if (cp && i < targets.length - 1) { const w = SLEEP_MS + Math.floor(Math.random() * 4000); console.log(`     … ${Math.round(w / 1000)}s 대기`); await new Promise((r) => setTimeout(r, w)) }
    }
  } finally {
    if (cp) await cp.close()
    if (en) await en.close()
  }

  const clean = rows.filter((r) => r.net > 0 && !r.skuDoubt && !r.weakDemand)
  console.log(`\n=== ✅흑자후보 ${clean.length} | ⚠보류 ${rows.filter((r) => r.net > 0 && (r.skuDoubt || r.weakDemand)).length} | ❌적자 ${rows.filter((r) => r.net <= 0).length} ===`)
  clean.sort((a, b) => b.rate - a.rate).forEach((r) => console.log(`  +${r.rate}% | 후기 ${r.reviews} | 소싱 ${r.srcLow.toLocaleString()}(${r.srcLabel}) → 쿠팡 ${r.coupang.toLocaleString()} | ${r.name.slice(0, 30)}`))
}
main().catch((e) => { console.error('오류:', e instanceof Error ? e.stack : e); process.exit(1) })
