/**
 * 스카우트 마진 검증 — 쿠팡 후보 상품을 도매꾹에서 소싱 가능한지 + 로켓그로스 마진이 남는지.
 *
 *   ① 쿠팡 후보(scout_products, 판매가·리뷰) 선정
 *   ② 상품명 → 도매꾹 getItemList 검색 → 유사 상품 매칭(제목 유사도) → getItemView 로 공급가·MOQ·과세·해외출고
 *   ③ 마진 = 쿠팡판매가 − 도매꾹공급가 − (판매수수료 + 로켓그로스 물류비)×1.1(VAT) − 박스500
 *   ④ 흑자 후보만 리포트
 *
 * 로켓그로스 물류비(입출고+배송, 쿠팡 공식 2026): 극소형 1950 / 소형 2200 / 중형 3350 (원/개)
 * 판매수수료: 카테고리별 5.5~10.8%(판매자배송과 동일) — 기본 10.8% 보수적, --commission 로 조정
 *
 * 사용: node scripts/scout-margin.mjs --session <id> --limit 15 [--commission 0.108] [--box 500] [--tier 소형]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(__dirname, '..')
const env = Object.fromEntries(
  readFileSync(path.join(REPO, '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }),
)
const DKEY = env.DOMEGGOOK_API_KEY, DBASE = 'https://domeggook.com/ssl/api/'
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const args = process.argv.slice(2)
const getArg = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)) || (args.includes(`--${k}`) ? `--${k}=${args[args.indexOf(`--${k}`) + 1]}` : null); return a ? a.split('=').slice(1).join('=') : d }
const SID = getArg('session', 'e0b4fbcd-177d-43d4-9631-e3b450cc94de')
const LIMIT = parseInt(getArg('limit', '15'))
const COMMISSION = parseFloat(getArg('commission', '0.108'))  // 판매수수료율(기본 10.8%)
const BOX = parseInt(getArg('box', '500'))
const TIER = getArg('tier', 'auto')                            // 극소형|소형|중형|auto
const RG_LOGI = { 극소형: 1950, 소형: 2200, 중형: 3350, 대형1: 3575 }
const VAT = 1.1
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 제목 유사도(자카드, 2-gram+토큰) — 도매꾹 매칭 정확도
const norm = (s) => (s || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/[^0-9a-z가-힣]+/gi, ' ').toLowerCase().trim()
function sim(a, b) {
  const ta = new Set(norm(a).split(/\s+/).filter((x) => x.length >= 2))
  const tb = new Set(norm(b).split(/\s+/).filter((x) => x.length >= 2))
  if (!ta.size || !tb.size) return 0
  let inter = 0; for (const t of ta) if (tb.has(t)) inter++
  return inter / Math.min(ta.size, tb.size)
}
// 쿠팡 상품명 → 도매꾹 검색 키워드(브랜드·옵션·마케팅·규격 노이즈 제거, 핵심 명사 1~2개)
const NOISE = /^(당일발송|무료배송|정품|국민템|신상|프리미엄|대용량|초강력|사은품|랜덤발송|랜덤|인증|동물용의약외품|의약외품|국내생산|국내제조|본사정품|1\+1|증정|특가|세트|혼합색상|리모콘|건전지|리필|본체)$/
const SPEC = /^\d+(\.\d+)?(cm|mm|m|l|ml|g|kg|호|종|p|개|개입|인|인용|구|단|매|병|캡|w|형)?$/i
const COLOR = /^(화이트|블랙|그레이|그레이지|네이비|베이지|핑크|블루|레드|그린|옐로우?|퍼플|브라운|아이보리|카키|실버|골드|민트|투명|반투명|랜덤|크림|차콜|챠콜|월넛)$/
function toKeyword(name) {
  let s = (name || '').split(',')[0]                       // 옵션 앞부분
  s = s.replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')     // 괄호류 제거
  s = s.replace(/\b\d+(\.\d+)?(cm|mm|m|L|ml|g|kg|호|종|p|개입|개|인용|인|구|단|매|병|W)\b/gi, ' ') // 규격 제거
  s = s.replace(/[+/]/g, ' ')
  const toks = s.split(/\s+/).filter((t) => /[가-힣]/.test(t) && t.length >= 2 && !NOISE.test(t) && !SPEC.test(t) && !COLOR.test(t) && !/^\d/.test(t))
  // 첫 토큰(대개 브랜드) 버리고, 뒤쪽 제품명사 2개 (제품 유형이 대개 이름 끝쪽)
  const core = toks.length > 1 ? toks.slice(1) : toks
  return core.slice(-2).join(' ').trim() || toks.slice(-2).join(' ').trim()
}
// 사이즈 티어 자동 추정(가격·이름 기반 대략치)
function guessTier(name, price) {
  if (/선반|테이블|우산꽂이|바구니|박스|정리함|행거|트롤리|의자|매트|타프|차광/.test(name || '')) return '중형'
  if (price >= 15000) return '중형'
  return '소형'
}

// getItemList 는 item 별로 price·unitQty(MOQ)·deli.fromOversea 를 이미 제공 → 상세조회 없이 국내 필터 가능
async function domeSearch(kw) {
  try {
    const r = await fetch(`${DBASE}?ver=4.1&mode=getItemList&aid=${DKEY}&market=dome&om=json&kw=${encodeURIComponent(kw)}&sz=40&pg=1`)
    const j = JSON.parse(await r.text())
    const items = (j?.domeggook?.list?.item) ?? []
    return items.map((it) => ({
      no: it.no, title: it.title || '',
      price: parseInt(it.price) || null,
      moq: parseInt(it.unitQty) || 1,
      oversea: String(it.deli?.fromOversea) === 'true',
      url: `https://domeggook.com/${it.no}`,
    }))
  } catch { return [] }
}

// 후보 로드(상품 단위 dedup, 목록 행)
async function loadCandidates() {
  const rows = []
  for (let f = 0; ; f += 1000) {
    const { data } = await sb.from('jimscanner_scout_products').select('product_id,name,price,review_count,url')
      .eq('session_id', SID).is('detail_collected_at', null).range(f, f + 999)
    rows.push(...(data ?? [])); if (!data || data.length < 1000) break
  }
  const BRAND = /탐사|유한|홈키파|홈스타|코멧|에너자이저|닥터지|LG|삼성|3M|옥시|다우니|피죤|스카트|크리넥스|한샘|락앤락|모나미/
  const best = {}
  for (const r of rows) {
    if (!r.name || /이름 미수집/.test(r.name)) continue
    if (!(r.review_count >= 100 && r.review_count <= 2000)) continue
    if (!(r.price >= 5000 && r.price <= 30000)) continue
    if (BRAND.test(r.name)) continue
    const p = best[r.product_id]; if (!p || r.review_count > p.review_count) best[r.product_id] = r
  }
  return Object.values(best).sort((a, b) => b.review_count - a.review_count)
}

const cands = await loadCandidates()
// 수요 범위 고르게 LIMIT개
const step = Math.max(1, Math.floor(cands.length / LIMIT))
const picks = []; for (let i = 0; i < cands.length && picks.length < LIMIT; i += step) picks.push(cands[i])

console.log(`후보 ${picks.length}건 도매꾹 소싱·마진 검증 (수수료 ${(COMMISSION * 100).toFixed(1)}% · 박스 ${BOX}원 · VAT 반영)\n`)
const results = []
for (const c of picks) {
  const kw = toKeyword(c.name)
  const list = await domeSearch(kw)
  await sleep(250)
  // 제목 유사도 + 유효가(>=300)만. 국내(fromOversea=false) 우선.
  const scored = list.map((it) => ({ ...it, s: sim(c.name, it.title) })).filter((it) => it.s >= 0.3 && it.price >= 300)
  const pick = (arr) => arr.sort((a, b) => (b.s - a.s) || (a.price - b.price))[0] || null  // 유사도 높은 것, 동률이면 저가
  const mk = (m) => m && { no: m.no, title: (m.title || '').slice(0, 38), supply: m.price, moq: m.moq, oversea: m.oversea, s: Math.round(m.s * 100), url: m.url }
  const bestDom = mk(pick(scored.filter((it) => !it.oversea)))
  const bestOversea = mk(pick(scored.filter((it) => it.oversea)))
  const bestMatch = bestDom || bestOversea   // 국내 우선, 없으면 해외(참고)
  const tier = TIER === 'auto' ? guessTier(c.name, c.price) : TIER
  const logi = RG_LOGI[tier] ?? RG_LOGI['소형']
  let margin = null, rate = null
  if (bestMatch) {
    const fees = (c.price * COMMISSION + logi) * VAT
    margin = Math.round(c.price - bestMatch.supply - fees - BOX)
    rate = Math.round((margin / c.price) * 100)
  }
  results.push({ ...c, kw, tier, logi, match: bestMatch, margin, rate })
  const tag = !bestMatch ? '✗매칭없음'
    : `${bestMatch.oversea ? '해외' : '국내'} ${margin > 0 ? `흑자 +${margin.toLocaleString()}(${rate}%)` : `적자 ${margin.toLocaleString()}`}`
  console.log(`[${tag}] ${c.name.slice(0, 30)} | 쿠팡 ${c.price.toLocaleString()}${bestMatch ? ` | 도매 ${bestMatch.supply.toLocaleString()}(sim${bestMatch.s})` : ` | kw="${kw}"`}`)
}

// 리포트 저장
const dir = path.join(REPO, 'data', 'scout', 'reports'); mkdirSync(dir, { recursive: true })
const domOk = results.filter((r) => r.match && !r.match.oversea && r.margin > 0).sort((a, b) => b.margin - a.margin)
const oversOk = results.filter((r) => r.match && r.match.oversea && r.margin > 0).sort((a, b) => b.margin - a.margin)
const row = (r) => `| ${r.margin > 0 ? '+' : ''}${r.margin.toLocaleString()} | ${r.rate}% | ${r.price.toLocaleString()} | ${r.match.supply.toLocaleString()} | ${r.logi}(${r.tier}) | ${r.review_count} | ${(r.name || '').slice(0, 32).replace(/\|/g, '/')} | ${r.match.url} |`
const md = `# 도매꾹 소싱·로켓그로스 마진 검증 (${new Date().toISOString().slice(0, 10)})

- 수수료 ${(COMMISSION * 100).toFixed(1)}% · 로켓그로스 물류비(입출고+배송) 티어별 · 박스 ${BOX}원 · 부가세 반영
- 마진 = 쿠팡판매가 − 도매꾹공급가 − (판매수수료 + 물류비)×1.1 − 박스
- 검증 ${results.length}건: 국내흑자 ${domOk.length} / 해외흑자 ${oversOk.length} / 미매칭 ${results.filter((r) => !r.match).length}
- ⚠ **로켓그로스는 국내 입고 필요** → 해외출고 매칭은 RG 부적합(판매자배송/직접수입 시 참고용)

## 국내 소싱 흑자 (로켓그로스 가능)
| 마진 | 율 | 쿠팡가 | 도매가 | 물류 | 리뷰 | 상품명 | 도매꾹 |
|---|---|---|---|---|---|---|---|
${domOk.map(row).join('\n') || '| (없음 — 이 카테고리는 국내 도매 공급이 희소) |'}

## 해외출고 매칭 (직접 수입/판매자배송 시 참고)
| 마진 | 율 | 쿠팡가 | 도매가 | 물류 | 리뷰 | 상품명 | 도매꾹 |
|---|---|---|---|---|---|---|---|
${oversOk.map(row).join('\n')}

## 미매칭(참고)
${results.filter((r) => !r.match).map((r) => `- ${(r.name || '').slice(0, 34)} | kw="${r.kw}"`).join('\n')}
`
writeFileSync(path.join(dir, `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}-마진검증.md`), md, 'utf8')
console.log(`\n국내흑자 ${domOk.length} / 해외흑자 ${oversOk.length} / ${results.length}건 → data/scout/reports/*-마진검증.md`)
