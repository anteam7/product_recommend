/**
 * 스마트스토어 가격경쟁력 진단 — 352개 상품의 시장가 대비 포지션 등급화.
 *   상품명→핵심 키워드 추출 → ①쇼핑검색 API 상위 20개 가격분포 vs 우리 판매가(≈MSP 바닥)
 *   ②검색광고 키워드도구로 월간 검색량/경쟁도 → WIN/PAR/LOSE 등급 + 광고 후보 산출.
 *   결과: .tmp/naver-price-audit.json + 콘솔 요약
 *
 *   node --env-file=.env.local scripts/naver-price-compete.mjs [--limit=N]
 *
 * 등급: 우리 가격이 시장 분포의 하위 30% 이내=WIN / 30~70%=PAR / 초과=LOSE
 *       + 시장 중위가 < 우리 가격(=MSP 바닥)이면 structural=true (구조적 열위 — 광고 금지)
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'

const env = process.env
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const LIMIT = parseInt((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || '0') || 0
const sleep = (ms) => new Promise((s) => setTimeout(s, ms))

// ── 쇼핑검색 API ──
async function shopSearch(query) {
  const r = await fetch(`https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(query)}&display=20&sort=sim`, {
    headers: { 'X-Naver-Client-Id': env.NAVER_OPENAPI_CLIENT_ID, 'X-Naver-Client-Secret': env.NAVER_OPENAPI_CLIENT_SECRET },
  })
  if (!r.ok) return null
  return r.json()
}

// ── 검색광고 키워드도구 (5개씩 배치) ──
async function keywordVolumes(keywords) {
  const out = new Map()
  for (let i = 0; i < keywords.length; i += 5) {
    const batch = keywords.slice(i, i + 5)
    const ts = String(Date.now())
    const sig = crypto.createHmac('sha256', env.NAVER_AD_SECRET).update(`${ts}.GET./keywordstool`).digest('base64')
    try {
      const r = await fetch(`https://api.searchad.naver.com/keywordstool?hintKeywords=${encodeURIComponent(batch.join(','))}&showDetail=1`, {
        headers: { 'X-Timestamp': ts, 'X-API-KEY': env.NAVER_AD_API_KEY, 'X-Customer': env.NAVER_AD_CUSTOMER_ID, 'X-Signature': sig },
      })
      const j = await r.json()
      for (const k of j.keywordList ?? []) {
        const key = k.relKeyword.replace(/\s/g, '')
        if (batch.some((b) => b.replace(/\s/g, '') === key)) {
          const n = (v) => (v === '< 10' ? 5 : parseInt(v) || 0)
          out.set(key, { volume: n(k.monthlyPcQcCnt) + n(k.monthlyMobileQcCnt), comp: k.compIdx })
        }
      }
    } catch { /* 배치 실패는 skip */ }
    await sleep(300)
  }
  return out
}

// ── 상품명 → 핵심 키워드 (브랜드·규격 제거, 2토큰) ──
const UNIT_RE = /^\d|^x\d|mg|ml|kg|^g$|\d+(g|ml|mg|포|정|캡슐|병|매|박스|통|개|회분|개월분|스틱)|^x$|^\(|정$|^플러스$|^골드$|^프리미엄$|^뉴$|^더$|^리얼$|^유기농$|^국산$|^무료/i
function coreKeyword(name) {
  const toks = name.replace(/[()\[\],]/g, ' ').split(/\s+/).filter(Boolean)
  const core = toks.filter((t) => !UNIT_RE.test(t) && t.length >= 2)
  // 브랜드(첫 토큰)는 핵심성분 토큰이 2개 이상 남으면 제거
  const rest = core.length > 2 ? core.slice(1) : core
  return rest.slice(0, 2).join(' ') || toks.slice(0, 2).join(' ')
}

// ── 메인 ──
let q = sb.from('jimscanner_naver_listings').select('channel_product_no, name, sale_price').order('sale_price', { ascending: false })
if (LIMIT) q = q.limit(LIMIT)
const { data: rows, error } = await q
if (error) { console.error(error.message); process.exit(1) }
console.log(`진단 대상 ${rows.length}건\n`)

const results = []
for (const [i, row] of rows.entries()) {
  const kw = coreKeyword(row.name)
  const res = await shopSearch(kw)
  await sleep(120)
  const prices = (res?.items ?? []).map((it) => parseInt(it.lprice)).filter((p) => p >= 1000).sort((a, b) => a - b)
  if (prices.length < 5) {
    results.push({ no: row.channel_product_no, name: row.name, kw, grade: 'NO_MARKET', our: row.sale_price, total: res?.total ?? 0 })
    continue
  }
  const pct = prices.filter((p) => p <= row.sale_price).length / prices.length
  const median = prices[Math.floor(prices.length / 2)]
  const grade = pct <= 0.3 ? 'WIN' : pct <= 0.7 ? 'PAR' : 'LOSE'
  const structural = median < row.sale_price // 시장 중위가가 우리 바닥가보다 낮음
  results.push({ no: row.channel_product_no, name: row.name, kw, our: row.sale_price, marketLow: prices[0], median, pct: Math.round(pct * 100), grade, structural, total: res?.total ?? 0 })
  if ((i + 1) % 50 === 0) console.log(`  ...${i + 1}/${rows.length}`)
}

// 검색량: WIN+PAR 키워드만 (광고 후보 판단용)
const candKw = [...new Set(results.filter((r) => r.grade === 'WIN' || (r.grade === 'PAR' && !r.structural)).map((r) => r.kw.replace(/\s/g, '')))]
console.log(`\n검색량 조회: ${candKw.length}개 키워드`)
const vols = await keywordVolumes(candKw)
for (const r of results) { const v = vols.get(r.kw.replace(/\s/g, '')); if (v) { r.volume = v.volume; r.comp = v.comp } }

await fs.mkdir('.tmp', { recursive: true })
await fs.writeFile('.tmp/naver-price-audit.json', JSON.stringify(results, null, 1))

const by = (g) => results.filter((r) => r.grade === g).length
console.log(`\n━━ 등급 분포 ━━`)
console.log(`WIN ${by('WIN')} / PAR ${by('PAR')} / LOSE ${by('LOSE')} / NO_MARKET ${by('NO_MARKET')}`)
console.log(`구조적 열위(시장 중위가 < 우리 바닥가): ${results.filter((r) => r.structural).length}건`)
console.log(`\n━━ 광고 후보 TOP (WIN + 검색량순) ━━`)
results.filter((r) => r.grade === 'WIN' && (r.volume ?? 0) >= 1000)
  .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0)).slice(0, 15)
  .forEach((r) => console.log(`[${r.volume}/월·${r.comp}] ${r.kw} | 우리 ${r.our.toLocaleString()}원 (시장 하위 ${r.pct}%) | ${r.name.slice(0, 36)}`))
console.log(`\n저장: .tmp/naver-price-audit.json`)
