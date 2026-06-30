/**
 * 도매매 DB(신규/인기/기획전) → 쿠팡 판매가 비교 → 마진 흑자 상품만 추리기.
 *
 *   ① domemedb 페이지 HTML에서 상품번호(domeggookGo(no)) 추출
 *   ② 번호 → 도매매 API getItemView → 상품명·공급가(위탁)·MOQ·해외여부
 *      (1개 위탁판매 기준: MOQ≥2·해외출고 제외)
 *   ③ 쿠팡 검색(세션 재사용) → 같은상품(후기 많은=실제 팔리는) 판매가 + 후기
 *   ④ 마진 = 쿠팡가 − 공급가 − 수수료 − 물류. 흑자 & 후기충분만 후보.
 *
 * 사용:
 *   node --env-file=.env.local scripts/domemedb-coupang-margin.mjs                 # 신규+인기
 *   ... --page=new|popular|both --limit=12 --sleep=10000 --min-reviews=10
 *   ... --no-coupang     # 공급가/상품만(쿠팡 생략)
 * 쿠팡: launch-chrome-debug.cmd 로 워밍업 크롬(9222) 띄우고 쿠팡 1회 접속 후 실행.
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
const DKEY = env.DOMEGGOOK_API_KEY
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const args = process.argv.slice(2)
const flag = (k) => args.includes(`--${k}`)
const getArg = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const PAGE = getArg('page', 'both')
const LIMIT = parseInt(getArg('limit', '12'))
const SLEEP_MS = parseInt(getArg('sleep', '9000'))
const MIN_REVIEWS = parseInt(getArg('min-reviews', '10'))
const FEE = parseFloat(getArg('fee', '0.108'))
const LOGI = parseInt(getArg('logi', '3000'))
const USE_COUPANG = !flag('no-coupang')
const SAVE = flag('save')                       // 흑자 후보 DB 저장 + run_state 갱신
const TARGET = parseInt(getArg('target', '0'))  // 흑자 N개 채우면 중단(0=off, LIMIT까지만)
const MARKET = getArg('market', 'coupang')      // coupang | naver (쿠팡 차단 시 네이버 시세로 흑자판정)
const NID = env.NAVER_OPENAPI_CLIENT_ID, NSEC = env.NAVER_OPENAPI_CLIENT_SECRET

async function setRunState(patch) { try { await sb.from('jimscanner_domemedb_run_state').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', 1) } catch { /* noop */ } }
async function saveCandidate(c) {
  try {
    await sb.from('jimscanner_domemedb_margin_candidates').upsert({
      supplier: 'domeme', supplier_goods_no: c.no, title: c.title, supply_price: c.supply,
      coupang_price: c.coupang, reviews: c.reviews ?? null, est_margin_krw: c.net, est_margin_rate: c.rate,
      market_source: c.market_source ?? 'coupang',
      page_source: c.source ?? null, moq: c.moq ?? null, detail_url: c.url, image_url: c.image ?? null,
      last_checked_at: new Date().toISOString(),
    }, { onConflict: 'supplier,supplier_goods_no' })
  } catch (e) { console.log('  (저장 오류:', e instanceof Error ? e.message : e, ')') }
}
// 이미 검사한 상품 기록(재실행 시 건너뛰어 누적 진행)
async function recordChecked(no, profitable) { try { await sb.from('jimscanner_domemedb_checked').upsert({ supplier_goods_no: no, profitable, checked_at: new Date().toISOString() }, { onConflict: 'supplier_goods_no' }) } catch { /* noop */ } }
async function loadCheckedSet() { try { const { data } = await sb.from('jimscanner_domemedb_checked').select('supplier_goods_no').limit(5000); return new Set((data || []).map((r) => r.supplier_goods_no)) } catch { return new Set() } }

// 네이버 쇼핑 시장가(같은 SKU 중앙값) + 비교상품수 — 쿠팡 없이 흑자 판정(차단 무관·빠름)
async function naverMarket(title) {
  try {
    const r = await fetch(`https://openapi.naver.com/v1/search/shop.json?display=40&sort=asc&query=${encodeURIComponent((title || '').slice(0, 60))}`, { headers: { 'X-Naver-Client-Id': NID, 'X-Naver-Client-Secret': NSEC } })
    if (r.status !== 200) return null
    const j = await r.json()
    const items = (j.items || []).map((it) => ({ price: parseInt(it.lprice) || 0, t: (it.title || '').replace(/<[^>]+>/g, '') })).filter((x) => x.price > 0)
    const same = items.filter((x) => sim(title, x.t) >= 0.4)
    if (same.length < 3) return null // 비교가능 상품 부족 = 시장 존재성 약함(판매검증 대체)
    const prices = same.map((x) => x.price).sort((a, b) => a - b)
    const arr = prices.slice(Math.floor(prices.length * 0.1), Math.ceil(prices.length * 0.9))
    const pool = arr.length ? arr : prices
    return { price: pool[Math.floor(pool.length / 2)], count: same.length }
  } catch { return null }
}

const PAGES = { new: 'itemNewDb', popular: 'itemPopular', event: 'itemEvent' }
const norm = (s) => (s || '').toLowerCase().replace(/[^가-힣a-z0-9]+/g, '')
function bigrams(s) { const t = norm(s); const g = new Set(); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g }
function sim(a, b) { const A = bigrams(a), B = bigrams(b); if (!A.size || !B.size) return 0; let c = 0; for (const x of A) if (B.has(x)) c++; return 2 * c / (A.size + B.size) }

const DBASE = 'https://domemedb.domeggook.com/index/item'
const extractNos = (html) => [...new Set([...html.matchAll(/domeggookGo\((\d{6,})\)/g)].map((m) => m[1]))]
const EVENT_EXPAND = !flag('no-expand')      // 기획전 '더보기'(카테고리 키워드별 추가상품) 펼침
const EVENT_MAX_CATS = parseInt(getArg('event-cats', '20'))

// DB 페이지 → 상품번호. 기획전(event)은 '더보기'(supplyList.php?sw=키워드)까지 펼쳐 추가 수집.
async function fetchNos(pageKey) {
  const html = await fetch(`${DBASE}/${PAGES[pageKey]}.php`, { headers: { 'User-Agent': UA } }).then((r) => r.text())
  let nos = extractNos(html)
  if (pageKey === 'event' && EVENT_EXPAND) {
    const kws = [...new Set([...html.matchAll(/supplyList\.php\?[^"'\s]*?sw=([^"'&\s]+)/g)].map((m) => { try { return decodeURIComponent(m[1]) } catch { return m[1] } }))]
    for (const kw of kws.slice(0, EVENT_MAX_CATS)) {
      try {
        const h = await fetch(`${DBASE}/supplyList.php?sf=subject&enc=utf8&fromOversea=0&mode=search&sw=${encodeURIComponent(kw)}`, { headers: { 'User-Agent': UA } }).then((r) => r.text())
        nos.push(...extractNos(h))
      } catch { /* skip */ }
    }
    nos = [...new Set(nos)]
    console.log(`   (기획전 더보기 ${Math.min(kws.length, EVENT_MAX_CATS)}개 카테고리 펼침)`)
  }
  return nos
}

// 동시 실행 제한(도매매 API 보호 — 기획전 펼치면 수백개라 일괄 동시호출 위험)
async function mapLimit(arr, n, fn) {
  const out = []; let i = 0
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => { while (i < arr.length) { const idx = i++; out[idx] = await fn(arr[idx]) } }))
  return out
}

// 번호 → 상품 상세(공급가=위탁가)
async function itemView(no) {
  try {
    const d = await fetch(`https://domeggook.com/ssl/api/?ver=4.1&mode=getItemView&aid=${DKEY}&no=${no}&om=json`).then((r) => r.json()).then((j) => j?.domeggook)
    if (!d) return null
    return {
      no, title: d?.basis?.title || '', supply: parseInt(d?.price?.supply) || null,
      moq: parseInt(d?.qty?.domeMoq) || 1, oversea: String(d?.deli?.fromOversea).toLowerCase() === 'true',
      image: d?.thumb?.original || d?.thumb?.large || null, url: `https://domeme.domeggook.com/s/${no}`,
    }
  } catch { return null }
}

// 쿠팡 타깃: 같은상품 중 후기 많은 것
function pickCoupangTarget(items, name) {
  const cand = (items || []).map((it) => ({ ...it, s: sim(name, it.title || '') })).filter((it) => it.price > 0 && it.s >= 0.3)
  if (!cand.length) return null
  cand.sort((a, b) => (b.reviews || 0) - (a.reviews || 0) || b.s - a.s)
  return cand[0]
}

async function main() {
  if (!DKEY) { console.error('DOMEGGOOK_API_KEY 없음'); process.exit(1) }
  console.log(`=== 도매매 DB → 쿠팡 마진 (수수료 ${FEE * 100}% · 물류 ${LOGI} · 후기≥${MIN_REVIEWS}${TARGET > 0 ? ` · 목표 흑자 ${TARGET}` : ''}) ===`)
  // ① 상품번호 수집(+ 출처 페이지)
  const keys = (PAGE === 'both' || PAGE === 'all') ? ['new', 'popular', 'event'] : PAGE.split(',').filter((k) => PAGES[k])
  const sourceMap = new Map()
  for (const k of keys) { try { for (const no of await fetchNos(k)) if (!sourceMap.has(no)) sourceMap.set(no, k) } catch (e) { console.log(`(${k} 수집 오류: ${e instanceof Error ? e.message : e})`) } }
  const nos = [...sourceMap.keys()]
  console.log(`① ${keys.join('+')} 상품번호 ${nos.length}개`)
  // ② 상세 + 소싱기준 필터(MOQ 1, 국내)
  const details = (await mapLimit(nos, 12, itemView)).filter(Boolean)
  details.forEach((d) => { d.source = sourceMap.get(d.no) })
  let sellable = details.filter((d) => d.supply > 0 && d.moq <= 1 && !d.oversea)
  console.log(`② getItemView ${details.length} → 소싱가능(MOQ1·국내) ${sellable.length} (해외/MOQ≥2 ${details.length - sellable.length} 제외)`)
  if (SAVE) { const checked = await loadCheckedSet(); const b = sellable.length; sellable = sellable.filter((d) => !checked.has(d.no)); console.log(`   (이미 검사 ${b - sellable.length}개 건너뜀 → 신규 ${sellable.length}개)`) }
  if (!USE_COUPANG) { console.log('--no-coupang: 공급가만'); sellable.slice(0, 20).forEach((d) => console.log(`  공급 ${String(d.supply).toLocaleString().padStart(8)} | ${d.title.slice(0, 40)}`)); return }

  // ③ 시장가 마진. MARKET=coupang(세션+throttle·후기검증) | naver(API·차단무관·빠름·비교상품수≥3 검증). TARGET 흑자 채우면 중단.
  const cp = MARKET === 'coupang' ? await openCoupangSession() : null
  if (MARKET === 'coupang' && !cp) { console.log('⚠ 쿠팡 세션 실패(미가동/차단) — 크롬 9222 확인'); if (SAVE) await setRunState({ status: 'idle', message: '쿠팡 세션 실패(크롬 9222 확인)' }); return }
  if (MARKET === 'naver' && (!NID || !NSEC)) { console.log('⚠ NAVER_OPENAPI 키 없음'); if (SAVE) await setRunState({ status: 'idle', message: 'NAVER 키 없음' }); return }
  if (SAVE) await setRunState({ status: 'running', found: 0, screened: 0, target: TARGET || LIMIT, started_at: new Date().toISOString(), message: `시장가:${MARKET}` })
  const rows = []
  let blockStreak = 0, screened = 0, found = 0
  const maxScreen = TARGET > 0 ? sellable.length : Math.min(LIMIT, sellable.length)
  console.log(`③ ${MARKET} 시세 마진 (대상 ${sellable.length}, ${TARGET > 0 ? `흑자 ${TARGET} 도달시 중단` : `최대 ${maxScreen}`})\n`)
  try {
    for (let i = 0; i < sellable.length && screened < maxScreen; i++) {
      if (TARGET > 0 && found >= TARGET) { console.log(`\n🎯 흑자 ${TARGET}개 도달 — 중단`); break }
      const d = sellable[i]
      let mkt = null, blocked = false
      if (MARKET === 'naver') { mkt = await naverMarket(d.title) }
      else { const c = await cp.search(d.title); if (!c) blocked = true; else { const t = pickCoupangTarget(c.items, d.title); if (t) mkt = { price: t.price, reviews: t.reviews } } }
      screened++
      if (blocked) { if (++blockStreak >= 3) { console.log('\n⛔ 쿠팡 연속 미응답 3회 — 중단'); break }; continue }
      blockStreak = 0
      let profitable = false
      if (mkt && mkt.price > 0) {
        const fee = Math.round(mkt.price * FEE)
        const net = mkt.price - d.supply - fee - LOGI
        const rate = Math.round((net / mkt.price) * 1000) / 10
        const weak = MARKET === 'coupang' ? (mkt.reviews || 0) < MIN_REVIEWS : false
        const tag = net <= 0 ? '❌' : weak ? '⚠' : '✅'
        console.log(`  ${tag} ${d.title.slice(0, 26)} | 공급 ${d.supply.toLocaleString()} → ${MARKET} ${mkt.price.toLocaleString()} = ${net > 0 ? '+' : ''}${net.toLocaleString()} (${rate}%)${MARKET === 'coupang' ? ` | 후기 ${mkt.reviews ?? '?'}` : ''}${weak ? ' ⚠후기부족' : ''}`)
        const cand = { ...d, coupang: mkt.price, reviews: mkt.reviews ?? null, net, rate, weak, market_source: MARKET }
        rows.push(cand)
        if (net > 0 && !weak) { profitable = true; found++; if (SAVE) await saveCandidate(cand) }
      } else console.log(`  · ${d.title.slice(0, 30)} | ${MARKET} 비교상품 없음`)
      if (SAVE) { await recordChecked(d.no, profitable); await setRunState({ found, screened }) } // 검사완료 기록(재실행 시 건너뜀)
      const willContinue = (TARGET > 0 ? found < TARGET : screened < maxScreen) && i < sellable.length - 1
      if (willContinue) {
        if (MARKET === 'coupang') { const w = SLEEP_MS + Math.floor(Math.random() * 4000); console.log(`     … ${Math.round(w / 1000)}s 대기 (흑자 ${found}${TARGET > 0 ? '/' + TARGET : ''} · ${screened})`); await new Promise((r) => setTimeout(r, w)) }
        else { await new Promise((r) => setTimeout(r, 200)) }
      }
    }
  } finally { if (cp) await cp.close(); if (SAVE) await setRunState({ status: 'idle', found, screened, message: `완료(${MARKET}): 흑자 ${found}개 / ${screened} 스크린` }) }

  const clean = rows.filter((r) => r.net > 0 && !r.weak)
  console.log(`\n=== ✅흑자&판매검증 ${clean.length} | ⚠후기부족 ${rows.filter((r) => r.net > 0 && r.weak).length} | ❌적자 ${rows.filter((r) => r.net <= 0).length} | 스크린 ${screened}${SAVE ? ' · DB저장됨' : ''} ===`)
  clean.sort((a, b) => b.net - a.net).forEach((r) => console.log(`  +${r.net.toLocaleString()}원(${r.rate}%) | 후기 ${r.reviews} | 공급 ${r.supply.toLocaleString()} → 쿠팡 ${r.coupang.toLocaleString()} | ${r.title.slice(0, 32)} | ${r.url}`))
}
main().catch((e) => { console.error('오류:', e instanceof Error ? e.stack : e); process.exit(1) })
