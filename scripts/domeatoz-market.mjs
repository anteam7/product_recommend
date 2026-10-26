#!/usr/bin/env node
/**
 * 도매아토즈 상품의 쿠팡 시세(규격 일치) 조회 + 가격 판정 리포트 — docs/plan-domeatoz.md §2·P1
 *   node scripts/domeatoz-market.mjs [--limit=N] [--only=idx,…] [--recheck] [--dry] [--backend=aside|cdp|chrome] [--gap=60000(하한)] [--cooldown=20] [--max-cooldowns=12]
 *   결과: jimscanner_domeatoz_products.market_* + _workspace/domeatoz-select-<KST날짜>.md (DB 전체 기준으로 매번 다시 씀)
 *
 * 매칭(식품 규격): ① 상품명 핵심 단어(브랜드 제외) 2/3 이상이 쿠팡 제목에 포함 ② 규격 일치 —
 *   총량 = 첫 용량(ml·g, L·kg 환산) × 그 뒤 수량들의 곱(괄호 안 내역은 제외: "10g x 45T (15개입x3개)" = 450g).
 *   양쪽 다 용량이 있으면 총량 ±2%, 아니면 총 수량이 같아야 일치. 세트("+", "각N개")는 규격 비교 불가 → 검색 안 함(NO_MATCH).
 * 판정: lib/domeatoz-price.mjs decide() — 기준 시세 = 일치가 하위 25%(3건 이상) 또는 최저가, OK | STRUCTURAL | NO_MATCH.
 * 쿠팡 검색은 Aside CLI 로 1분에 1회 이하(60~68초 간격·재시도도 60초 뒤), 묶음 수 변형(… x 2개 / x 4개)은 끝 수량을 뗀 이름으로 한 번만 검색해 공유한다.
 * 연속 실패 3회 = 차단으로 보고 세션을 닫고 --cooldown 분 쉰 뒤 실패한 첫 상품부터 재개(최대 --max-cooldowns 회, 넘으면 중단 — 남은 건은 다음 실행에서 미조회로 다시 잡힘).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { openCoupangSession, median } from './lib/market-price.mjs'
import { decide, quantile, COUPANG_FEE, TARGET_MARGIN, MIN_MARGIN, MIN_ABS, MIN_P25_MATCHES } from './lib/domeatoz-price.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const env = Object.fromEntries(readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const TABLE = 'jimscanner_domeatoz_products'
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const has = (k) => process.argv.includes(`--${k}`)
const intArg = (k, d) => { const v = arg(k); if (v == null) return d; if (!/^\d+$/.test(v)) { console.error(`--${k} 는 0 이상 정수: ${v}`); process.exit(64) } return +v }
const DRY = has('dry'), RECHECK = has('recheck')
const LIMIT = intArg('limit', 0)
const GAP = Math.max(60000, intArg('gap', 60000)) // 검색 1분에 1회 이하(사장님 지시 2026-10-26)
const ONLY = new Set(arg('only', '').split(',').map((s) => s.trim()).filter(Boolean))
const KST = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '')
const WS = path.join(ROOT, '_workspace'); mkdirSync(WS, { recursive: true })
const OUT_MD = path.join(WS, `domeatoz-select-${KST}.md`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 식품 규격 시그니처 ──
const VOL = /(\d+(?:\.\d+)?)\s*(ml|mL|ML|g|G|kg|KG|Kg|l|L)(?![a-zA-Z])/
const VOL_G = new RegExp(VOL.source, 'g')
const CNT_G = /[x×*]\s*(\d+)|(\d+)\s*(?:개입|개|입|캔|병|매|팩|PET|pet|번들|롤|포|봉지|봉|박스|BOX|box|EA|ea|스틱|컵|통|T|P|p)(?![a-zA-Z가-힣])/g
function normVol(n, u) {
  let v = parseFloat(n); u = u.toLowerCase()
  if (u === 'l') { v *= 1000; u = 'ml' } else if (u === 'kg') { v *= 1000; u = 'g' }
  return { v, u }
}
function specOf(name) {
  const s = String(name || '')
  if (/\+|각\s*\d/.test(s)) return { set: true }
  const m = s.match(VOL)
  const vol = m ? normVol(m[1], m[2]) : null
  // 첫 용량 뒤(없으면 전체)에서 괄호 내역·다른 용량을 지우고 수량을 곱한다
  let rest = m ? s.slice(m.index + m[0].length) : s
  rest = rest.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/[()[\]]/g, ' ').replace(VOL_G, ' ')
  const cnts = [...rest.matchAll(CNT_G)].map((x) => +(x[1] || x[2])).filter((n) => n >= 1 && n < 2000)
  // 쿠팡 제목은 수량을 용량 앞 칸에 쓰기도 한다("상품명, 2개, 367.5g") — 용량 앞의 쉼표 칸 중 수량만 있는 칸(첫 칸=상품명 제외)도 곱한다
  if (m) for (const seg of s.slice(0, m.index).split(',').slice(1)) { const c = seg.trim().match(/^(\d+)\s*(?:개입|개|입|팩|박스|봉|병|캔|PET|EA)$/i); if (c && +c[1] >= 1 && +c[1] < 2000) cnts.push(+c[1]) }
  const count = cnts.reduce((a, b) => a * b, 1)
  return { set: false, vol, count, total: vol ? vol.v * count : null }
}
// 같은 상품의 묶음 수 변형("… 230g x 2개 / x 4개 / x 8개")은 한 번만 검색한다 — 끝의 묶음 수량만 뗀 이름
const baseOf = (name) => String(name).replace(/\s*[x×*]?\s*\d+\s*(?:개|박스|PET|팩|캔|병|봉|EA)\s*$/i, '').trim()
const brandless = (name) => {
  const toks = String(name).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').split(/[\s,/]+/).filter((w) => /[가-힣a-zA-Z]{2,}/.test(w) && !/\d/.test(w)).slice(0, 5)
  return toks.length >= 2 ? toks.slice(1) : toks
}
function titleMatches(ourName, ourSpec, title) {
  const toks = brandless(ourName)
  const flat = String(title).replace(/\s/g, '')
  const hit = toks.filter((w) => flat.includes(w)).length
  if (!toks.length || hit < Math.ceil((toks.length * 2) / 3)) return false // 3개 중 2개, 2개면 둘 다
  const t = specOf(title)
  if (t.set) return false
  if (ourSpec.vol && t.vol) return ourSpec.vol.u === t.vol.u && Math.abs(ourSpec.total - t.total) <= ourSpec.total * 0.02
  return ourSpec.count === t.count && ourSpec.count > 1
}
const queryOf = (name) => String(name).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50)

async function fetchAll(build) { const PAGE = 1000, out = []; for (let from = 0; ; from += PAGE) { const { data, error } = await build().range(from, from + PAGE - 1); if (error) throw new Error(error.message); out.push(...(data ?? [])); if ((data ?? []).length < PAGE) return out } }
const COLS = 'idx, supplier_code, supplier_name, name_clean, group_2, group_3, wholesale_price, delivery_price, status, auto_excluded_reason, register_excluded, market_low, market_p25, market_median, market_count, market_top3, market_checked_at'
const loadAll = () => fetchAll(() => sb.from(TABLE).select(COLS).eq('status', 'active').is('auto_excluded_reason', null).eq('register_excluded', false).order('idx'))

// 음료·생수는 로켓 경쟁이 가장 세서 뒤로 — 과자·가공식품·커피·차 먼저
const RANK = ['과자/간식', '가공식품', '즉석식품', '반찬/가정식', '축산']
const rank = (p) => { const i = RANK.indexOf(p.group_2); if (i >= 0) return i; return /커피|차류|코코아/.test(p.group_3 || '') ? 10 : 20 }
let targets = (await loadAll())
  .filter((p) => (ONLY.size ? ONLY.has(p.idx) : true))
  .filter((p) => RECHECK || ONLY.size || !p.market_checked_at)
  .sort((a, b) => rank(a) - rank(b) || baseOf(a.name_clean).localeCompare(baseOf(b.name_clean)) || Number(b.idx) - Number(a.idx))
if (LIMIT) targets = targets.slice(0, LIMIT)
const COOLDOWN_MIN = intArg('cooldown', 20), MAX_COOLDOWNS = intArg('max-cooldowns', 12)
console.log(`시세 조회 대상 ${targets.length}건(검색 ${new Set(targets.filter((p) => !specOf(p.name_clean).set).map((p) => queryOf(baseOf(p.name_clean)))).size}회) · 쿠팡 수수료 ${(COUPANG_FEE * 100).toFixed(1)}% · 목표 ${(TARGET_MARGIN * 100).toFixed(0)}% · 하한 ${(MIN_MARGIN * 100).toFixed(0)}%/${MIN_ABS}원 · 기준 시세 P25(일치 ${MIN_P25_MATCHES}건↑) · 간격 ${GAP / 1000}초~ · 차단 시 ${COOLDOWN_MIN}분 쉬고 재개(최대 ${MAX_COOLDOWNS}회)`)

const BACKEND = arg('backend', 'aside') // 사장님 지시(2026-10-26): 쿠팡은 Aside CLI 로
let session = null
async function openSession() {
  session = await openCoupangSession({ backend: BACKEND })
  if (session) console.log(`쿠팡 세션: ${session.backend} (${new Date().toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' })})`)
  return session
}
if (targets.some((p) => !specOf(p.name_clean).set) && !(await openSession())) { console.error('쿠팡 세션 불가 — 크롬 설치·차단 여부 확인(--backend=aside|cdp 로 바꿔 시도)'); process.exit(2) }
const cache = new Map() // 검색어 → 결과 items (묶음 변형 공유)
let i = 0, failStreak = 0, failStart = -1, failTotal = 0, dbFail = 0, searches = 0, cooldowns = 0
try {
  for (let ti = 0; ti < targets.length; ti++) {
    const p = targets[ti]
    const spec = specOf(p.name_clean)
    const q = queryOf(baseOf(p.name_clean))
    let matched = [], raw = [], failed = false, searched = false
    if (!spec.set) {
      if (cache.has(q)) raw = cache.get(q)
      else {
        let r = null
        for (let t = 1; t <= 2 && !r; t++) { r = await session.search(q); if (!r && t === 1) await sleep(GAP) } // 재시도도 검색 간격을 지킨다
        searched = true; searches++
        if (!r) failed = true
        else { raw = r.items || []; cache.set(q, raw) }
      }
      matched = raw.filter((it) => it.price > 0 && titleMatches(p.name_clean, spec, it.title))
    }
    if (failed) {
      if (failStreak++ === 0) failStart = ti // 이번 연속 실패의 첫 상품 — 휴식 뒤 여기부터 다시
      failTotal++
      console.log(`  ⚠ ${p.idx} 검색 실패/차단: ${q}`)
      if (failStreak >= 3) {
        // 차단: 세션을 닫고 쉬었다가 같은 상품부터 다시. 쉬는 횟수 상한이면 중단(남은 건은 다음 실행에서 미조회로 다시 잡힘)
        await session.close().catch(() => {}); session = null
        if (++cooldowns > MAX_COOLDOWNS) { console.log(`  ⚠ 차단 휴식 ${MAX_COOLDOWNS}회 초과 — 중단`); break }
        console.log(`  ⏸ 연속 실패 ${failStreak}회 — ${COOLDOWN_MIN}분 휴식(${cooldowns}/${MAX_COOLDOWNS}, 지금까지 검색 ${searches}회)`)
        await sleep(COOLDOWN_MIN * 60e3)
        failStreak = 0
        if (!(await openSession())) { console.log('  ⚠ 휴식 뒤에도 세션 불가 — 중단'); break }
        ti = failStart - 1 // 연속 실패의 첫 상품부터 다시(사이에 낀 세트 상품은 다시 지나가도 결과 동일)
      } else await sleep(GAP)
      continue
    }
    if (searched) failStreak = 0
    i++
    const prices = matched.map((m) => m.price)
    const d = decide(p.wholesale_price, p.delivery_price, prices)
    console.log(`  [${ti + 1}/${targets.length}] ${p.idx} ${p.name_clean.slice(0, 30).padEnd(30)} 원가 ${d.cost} 하한 ${d.floor} 목표 ${d.target} | 일치 ${prices.length}/${raw.length} 기준 ${d.ref ?? '-'} → ${d.verdict}${d.price ? ` ${d.price} (순이익 ${d.net}, ${(d.margin * 100).toFixed(1)}%)` : ''}${spec.set ? ' [세트]' : ''}${searched ? '' : ' (같은 검색 재사용)'}`)
    if (!DRY) {
      const top = matched.length ? matched.sort((a, b) => a.price - b.price).slice(0, 3).map((m) => ({ title: m.title, price: m.price, m: true })) : raw.slice(0, 3).map((m) => ({ title: m.title, price: m.price, m: false }))
      const { error } = await sb.from(TABLE).update({
        market_query: spec.set ? '(세트 — 규격 비교 불가)' : q, market_low: prices.length ? Math.min(...prices) : null,
        market_p25: prices.length >= MIN_P25_MATCHES ? quantile(prices, 0.25) : null, market_median: median(prices), market_count: prices.length,
        market_top3: top, market_checked_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq('idx', p.idx)
      if (error) { dbFail++; console.log(`  ✗ DB ${p.idx} ${error.message}`) }
    }
    if (searched) await sleep(GAP + Math.floor(Math.random() * 8000))
  }
} finally { if (session) await session.close() }

// ── 리포트: DB 전체(시세 조회 끝난 것) 기준 ──
const all = (await loadAll()).filter((p) => p.market_checked_at)
// 판정은 저장된 요약값으로 재현: P25 가 있으면 P25, 아니면 최저가(가격 1개를 넘기면 refPrice 가 그대로 쓴다)
const rows = all.map((p) => { const ref = p.market_p25 ?? p.market_low; return { ...p, d: decide(p.wholesale_price, p.delivery_price, ref ? [ref] : []) } })
const tally = rows.reduce((m, r) => { m[r.d.verdict] = (m[r.d.verdict] || 0) + 1; return m }, {})
const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\n/g, ' ')
const order = { OK: 0, STRUCTURAL: 1, NO_MATCH: 2, NO_COST: 3 }
const md = [`# 도매아토즈(삼일유통) 쿠팡 등록 선별 리포트 ${KST}`, '',
  `가정: 원가 = 도매가 + 배송비 3,000(주문 1건당) · 쿠팡 수수료 ${(COUPANG_FEE * 100).toFixed(1)}% · 목표 순마진 ${(TARGET_MARGIN * 100).toFixed(0)}% · 하한 ${(MIN_MARGIN * 100).toFixed(0)}% 또는 ${MIN_ABS}원 · 기준 시세 = 규격 일치가 하위 25%(${MIN_P25_MATCHES}건 이상, 미만이면 최저가) −1%`,
  `조회 ${rows.length}건 → ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' · ')} (OK = 등록 후보 · STRUCTURAL = 시세가 하한 아래 · NO_MATCH = 같은 규격 쿠팡 상품 못 찾음/세트)`, '',
  '| 판정 | idx | 상품 | 도매가 | 원가 | 하한 | 목표 | 일치 | 기준 시세 | 제안가 | 순이익 | 쿠팡 상위(일치=✓) |', '|---|---|---|---|---|---|---|---|---|---|---|---|']
for (const r of rows.sort((a, b) => order[a.d.verdict] - order[b.d.verdict] || (b.d.net || 0) - (a.d.net || 0))) {
  md.push(`| ${r.d.verdict} | ${r.idx} | ${cell(r.name_clean)} | ${r.wholesale_price} | ${r.d.cost} | ${r.d.floor} | ${r.d.target} | ${r.market_count ?? 0} | ${r.d.ref ?? '-'} | ${r.d.price ?? '-'} | ${r.d.net ?? '-'} | ${cell((r.market_top3 || []).map((t) => `${t.m ? '✓' : '·'}${t.price} ${String(t.title).slice(0, 28)}`).join(' / '))} |`)
}
writeFileSync(OUT_MD, md.join('\n'))
console.log(`\n이번 실행: ${i}건 조회${failTotal ? ` · 검색 실패 ${failTotal}` : ''}${dbFail ? ` · DB 실패 ${dbFail}` : ''}`)
console.log(`누적 판정(${rows.length}건): ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
console.log(`→ ${OUT_MD}`)
if (dbFail) process.exitCode = 1
