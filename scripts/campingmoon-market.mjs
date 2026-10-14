#!/usr/bin/env node
/**
 * 캠핑문 상품의 쿠팡 시세 비교(Aside CLI 브라우저) + 가격 판정 리포트 — docs/plan-campingmoon.md §2.3·P1
 *   node scripts/campingmoon-market.mjs [--cates=155,32,12] [--limit=N] [--only=4385,…] [--recheck] [--dry] [--backend=aside|cdp]
 *   결과: jimscanner_campingmoon_products.market_*(최저·중앙·매칭 수·상위 3건) + _workspace/campingmoon-select-<KST날짜>.md
 *
 * 검색어: ① "캠핑문 <정제 상품명 앞 6토큰>" ② 모델코드가 있으면 "캠핑문 <모델코드>". 매칭 = 토큰 오버랩 계수(교집합/작은 집합, coupang-pricewatch sim 과 동일) ≥ 0.4
 *         또는 모델코드(5자 이상) 포함. 매칭 최저가가 market_low. 매칭 0 이면 NO_MATCH(목표가로 등록, pricewatch 스윕 대상).
 * 판정: lib/campingmoon-price.mjs decide() — 1개/2개/3개 묶음별 floor·target·ceiling → OK | STRUCTURAL | NO_MATCH. 1개가 STRUCTURAL 이고 묶음이 OK 면 묶음 전략.
 * 이름 매칭의 한계(SKU 불일치)는 리포트의 상위 3건 제목으로 사람이 확인한다.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { openCoupangSession } from './lib/market-price.mjs'
import { decide, pickPack, DISCOUNT_BASE, COUPANG_FEE, TARGET_MARGIN, MIN_MARGIN, MIN_ABS } from './lib/campingmoon-price.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const env = Object.fromEntries(readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const has = (k) => process.argv.includes(`--${k}`)
const DRY = has('dry'), RECHECK = has('recheck')
const LIMIT = parseInt(arg('limit', '0'), 10) || 0
const CATES = arg('cates', '').split(',').map((s) => s.trim()).filter(Boolean)
const ONLY = new Set(arg('only', '').split(',').map((s) => s.trim()).filter(Boolean))
const KST = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '')
const WS = path.join(ROOT, '_workspace'); mkdirSync(WS, { recursive: true })
const OUT_MD = path.join(WS, `campingmoon-select-${KST}.md`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const norm = (s) => (s || '').replace(/[^0-9a-z가-힣]+/gi, ' ').toLowerCase().trim()
function sim(a, b) {
  const ta = new Set(norm(a).split(/\s+/).filter((x) => x.length >= 2)), tb = new Set(norm(b).split(/\s+/).filter((x) => x.length >= 2))
  if (!ta.size || !tb.size) return 0
  let i = 0; for (const t of ta) if (tb.has(t)) i++
  return i / Math.min(ta.size, tb.size)
}
const median = (arr) => { const a = arr.filter((n) => n > 0).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null }
const kwOf = (p) => `캠핑문 ${p.name_clean.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ')}`.slice(0, 40)

async function fetchAll(build) { const PAGE = 1000, out = []; for (let from = 0; ; from += PAGE) { const { data, error } = await build().range(from, from + PAGE - 1); if (error) throw new Error(error.message); out.push(...(data ?? [])); if ((data ?? []).length < PAGE) return out } }

// 대상: 판매 가능(상품 품절 아님·판매중 옵션 1개 이상)·제외 아님. 우선순위: 캠핑문 자사브랜드(155) → 화로/연료(32계열) → 테이블/의자(12계열) → 나머지
const PRIORITY = ['155', '90', '89', '87', '92', '175', '179', '49', '47', '50', '52', '51', '7', '53', '84', '61', '81', '74', '75', '70', '73']
const rank = (p) => { const i = PRIORITY.findIndex((c) => (p.cate_nos || []).includes(c)); return i < 0 ? 99 : i }
const products = (await fetchAll(() => sb.from('jimscanner_campingmoon_products').select('product_no, name_clean, model_code, cate_nos, sale_price, soldout, register_excluded, market_low, market_checked_at, kc_suspect').eq('status', 'active').order('product_no')))
  .filter((p) => !p.soldout && !p.register_excluded && p.sale_price > 0)
  .filter((p) => (ONLY.size ? ONLY.has(p.product_no) : true) && (CATES.length ? CATES.some((c) => (p.cate_nos || []).includes(c)) : true))
  .filter((p) => RECHECK || ONLY.size || !p.market_checked_at)
const items = await fetchAll(() => sb.from('jimscanner_campingmoon_items').select('product_no, item_code, option_value, option_price, add_price, is_selling').eq('status', 'active').order('item_code'))
const itemsBy = new Map(); for (const it of items) { if (!itemsBy.has(it.product_no)) itemsBy.set(it.product_no, []); itemsBy.get(it.product_no).push(it) }
let targets = products.filter((p) => (itemsBy.get(p.product_no) || []).some((i) => i.is_selling)).sort((a, b) => rank(a) - rank(b) || Number(a.product_no) - Number(b.product_no))
if (LIMIT) targets = targets.slice(0, LIMIT)
console.log(`대상 ${targets.length}건 (판매가능·미조회${RECHECK ? '·재조회 포함' : ''}) · 할인기준 ${DISCOUNT_BASE} · 쿠팡 수수료 ${(COUPANG_FEE * 100).toFixed(1)}% · 목표 ${(TARGET_MARGIN * 100).toFixed(0)}% · 하한 ${(MIN_MARGIN * 100).toFixed(0)}%/${MIN_ABS}원`)
if (!targets.length) process.exit(0)

const session = await openCoupangSession({ backend: arg('backend', 'auto') })
if (!session) { console.error('쿠팡 세션 불가(aside/cdp) — Aside 브라우저 실행·쿠팡 탭 확인'); process.exit(2) }
const rows = []
let i = 0, dbFail = 0, blocked = 0
try {
for (const p of targets) {
  i++
  const kws = [kwOf(p), ...(p.model_code ? [`캠핑문 ${p.model_code}`] : [])]
  const found = new Map()
  let failed = false
  for (const kw of kws) {
    let r = null
    try { r = await session.search(kw) } catch (e) { console.log(`  ⚠ ${p.product_no} 검색 예외: ${String(e.message).slice(0, 100)}`) }
    if (!r) { blocked++; failed = true; console.log(`  ⚠ ${p.product_no} 검색 실패/차단: ${kw} — DB 갱신 건너뜀(다음 실행에서 재조회)`); break }
    for (const it of r.items || []) {
      const s = Math.max(sim(p.name_clean, it.title), p.model_code && p.model_code.length >= 5 && String(it.title).toUpperCase().includes(p.model_code.toUpperCase()) ? 0.9 : 0)
      if (s >= 0.4 && it.price > 0) { const k = `${it.title}|${it.price}`; if (!found.has(k)) found.set(k, { ...it, sim: +s.toFixed(2) }) }
    }
    await sleep(800)
  }
  const matched = [...found.values()].sort((a, b) => b.sim - a.sim || a.price - b.price)
  const prices = matched.map((m) => m.price)
  const low = prices.length ? Math.min(...prices) : null
  const sel = (itemsBy.get(p.product_no) || []).filter((x) => x.is_selling)
  const basePrice = sel.length ? Math.min(...sel.map((x) => x.option_price || p.sale_price + (x.add_price || 0))) : p.sale_price
  const verdicts = decide(basePrice, low)
  const pick = pickPack(verdicts)
  const row = { ...p, kw: kws[0], market_low: low, market_median: median(prices), market_count: prices.length, top3: matched.slice(0, 3), basePrice, verdicts, pick, optCount: sel.length }
  rows.push(row)
  const v1 = verdicts[0]
  console.log(`  [${i}/${targets.length}] ${p.product_no} ${p.name_clean.slice(0, 28).padEnd(28)} 캠핑문 ${basePrice} cost ${v1.cost} floor ${v1.floor} target ${v1.target} | 시세 ${low ?? '-'}(${prices.length}) → ${pick ? `${pick.n}개 ${pick.price} (${pick.verdict}, 순이익 ${pick.net})` : 'STRUCTURAL'}`)
  if (!DRY && !failed) { // 검색 실패/차단 건은 market_checked_at 을 남기지 않아 다음 실행에서 다시 잡힌다
    const { error } = await sb.from('jimscanner_campingmoon_products').update({ market_low: low, market_median: median(prices), market_count: prices.length, market_top3: matched.slice(0, 3).map((m) => ({ title: m.title, price: m.price, sim: m.sim })), market_checked_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('product_no', p.product_no)
    if (error) { dbFail++; console.log(`  ✗ DB ${p.product_no} ${error.message}`) }
  }
  if (blocked >= 5) { console.log('  ⚠ 검색 실패 누적 5회 — 차단으로 보고 중단(실패 건·나머지는 다음 실행에서 미조회로 다시 잡힘)'); break }
}
} finally { await session.close() }
if (dbFail) process.exitCode = 1

const tally = rows.reduce((m, r) => { const k = r.pick ? (r.pick.n === 1 ? r.pick.verdict : `BUNDLE${r.pick.n}`) : 'STRUCTURAL'; m[k] = (m[k] || 0) + 1; return m }, {})
console.log(`\n판정: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' · ')}${blocked ? ` · 검색 실패 ${blocked}` : ''}${dbFail ? ` · DB 실패 ${dbFail}` : ''}`)
const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\n/g, ' ')
const md = [`# 캠핑문 등록 선별 리포트 ${KST}`, '',
  `가정: 할인 기준 **${DISCOUNT_BASE}**(${DISCOUNT_BASE === 'total' ? '(상품+배송비 3,000)×0.65' : '상품×0.65+배송비 3,000 — 보수안, 첫 주문으로 확정'}) · 쿠팡 수수료 ${(COUPANG_FEE * 100).toFixed(1)}% · 목표 순마진 ${TARGET_MARGIN * 100}% · 하한 ${MIN_MARGIN * 100}% 또는 ${MIN_ABS}원 · 시세 대비 −1%`,
  `판정: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' · ')} (OK=1개 등록 · BUNDLEn=n개 묶음으로 등록 · NO_MATCH=시세 매칭 없음, 목표가 등록 · STRUCTURAL=시세가 하한 아래, 보류)`, '',
  '| 판정 | no | 상품 | 옵션 수 | 캠핑문가 | 원가(1개) | 하한 | 목표 | 시세 최저(매칭) | 제안 | 순이익 | 매칭 상위 |', '|---|---|---|---|---|---|---|---|---|---|---|---|']
for (const r of rows.sort((a, b) => (a.pick ? 0 : 1) - (b.pick ? 0 : 1) || (b.pick?.net || 0) - (a.pick?.net || 0))) {
  const v1 = r.verdicts[0]
  md.push(`| ${r.pick ? (r.pick.n === 1 ? r.pick.verdict : `BUNDLE${r.pick.n}`) : 'STRUCTURAL'} | ${r.product_no} | ${cell(r.name_clean)}${r.kc_suspect ? ' ⚡KC?' : ''} | ${r.optCount} | ${r.basePrice} | ${v1.cost} | ${v1.floor} | ${v1.target} | ${r.market_low ?? '-'} (${r.market_count}) | ${r.pick ? `${r.pick.n}개 ${r.pick.price}` : '-'} | ${r.pick?.net ?? '-'} | ${cell(r.top3.map((t) => `${t.price} ${t.title.slice(0, 30)}(${t.sim})`).join(' / '))} |`)
}
writeFileSync(OUT_MD, md.join('\n'))
console.log(`→ ${OUT_MD}`)
