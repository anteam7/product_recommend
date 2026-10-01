/**
 * upickb2b (Cafe24 위탁 도매몰) 상품 수집 → jimscanner_upickb2b_products upsert.
 *   node --env-file=.env.local scripts/upickb2b-collect.mjs [--cates=24,25,92] [--limit=N] [--dry]
 *
 * fetch+쿠키 로그인(ggsan-prep-goods.mjs 패턴). 상세 th/td 테이블에서
 * 회원가(매입가)·최저판매가(단품/수량별)·판매가능플랫폼·자체상품코드·이미지 캡처.
 * "모든마켓 판매가능"만 쿠팡 등록 후보(coupang_allowed) — 쿠팡 금지 상품은 수집하되 플래그.
 * content_hash 로 변동(가격·MSP·재고)만 감지해 last_changed_at 갱신.
 *
 * 다음 단계(P2): coupang-register-batch-v2 류가 coupang_allowed=true 를 source='upickb2b' 로 등록.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { makeSession, cafe24Login } from './lib/supplier-stock.mjs'
import { fetchUpickDetail, saveUpickProduct } from './lib/upick-catalog.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const BASE = env.UPICKB2B_BASE_URL || 'https://upickb2b.com'

const DRY = process.argv.includes('--dry')
const CATES = (process.argv.find(a => a.startsWith('--cates='))?.split('=')[1] || '24,25,92').split(',').map(s => s.trim()).filter(Boolean)
const LIMIT = +(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || 0)
// --only=4046,4112 : 카테고리 스캔 없이 지정 상품 상세만 재수집(품절·타 카테고리 포함). cate_no 는 기존 값 유지.
const ONLY = (process.argv.find(a => a.startsWith('--only='))?.split('=')[1] || '').split(',').map(s => s.trim()).filter(Boolean)
const CATE_LABELS = { '24': '건강기능식품', '25': '건강관련식품', '92': '건강식품(환액즙)' }
const sleep = ms => new Promise(s => setTimeout(s, ms))

// ── fetch + 쿠키 ──
// ⚠ Cafe24 AuthSSL(2026-08 경) 이후 평문 POST 로그인은 403 → 2026-08-05 부터 이 수집기가 조용히 멈춰
//   매입가·MSP 변동이 쿠팡가에 반영되지 않았다. 헤드리스 크롬 로그인→쿠키 이식(supplier-stock 공용)만 유효.
const session = makeSession()
const fx = (url, init = {}) => session.fx(url, { ...init, headers: { Accept: 'text/html,application/xhtml+xml', ...(init.headers || {}) } })
const login = () => cafe24Login(session, { base: BASE, user: env.UPICKB2B_USER, pass: env.UPICKB2B_PASS, label: '유픽B2B' })

async function listCategory(cateNo) {
  const items = []; const seen = new Set()
  for (let page = 1; page <= 30; page++) {
    const r = await fx(`${BASE}/category/x/${cateNo}/?page=${page}`)
    if (!r.ok) break
    let html = await r.text()
    // 메인 상품 리스트만 — 페이지네이션 이후(추천/최근 본 상품) 제거
    const cut = html.search(/class="[^"]*ec-base-paginate/)
    if (cut > 0) html = html.slice(0, cut)
    // 상품 블록 단위로 분리해 품절 아이콘(ico_product_soldout / alt="품절") 여부 판정
    const blocks = [...html.matchAll(/id=["']anchorBoxId_(\d+)["']([\s\S]*?)(?=id=["']anchorBoxId_|$)/g)]
    const fresh = []
    for (const b of blocks) {
      if (seen.has(b[1])) continue
      seen.add(b[1])
      fresh.push({ id: b[1], soldout: /ico_product_soldout|alt=["']품절["']/i.test(b[2]) })
    }
    if (!fresh.length) break
    items.push(...fresh)
    await sleep(250)
  }
  return items
}

// ── main ──
await login(); console.log(`✓ upickb2b login${DRY ? ' [DRY]' : ''}`)
let total = 0, changed = 0, excluded = 0
for (const cate of ONLY.length ? [null] : CATES) {
  let ids
  if (cate == null) {
    ids = ONLY
    console.log(`\n[--only] 지정 ${ids.length}개`)
  } else {
    const items = await listCategory(cate)
    const soldoutCount = items.filter(x => x.soldout).length
    ids = items.filter(x => !x.soldout).map(x => x.id)   // 품절 상품은 수집 제외
    if (LIMIT) ids = ids.slice(0, LIMIT)
    console.log(`\n[cate ${cate} ${CATE_LABELS[cate] || ''}] 판매중 ${ids.length}개 (품절 ${soldoutCount}개 제외)`)
  }
  for (let i = 0; i < ids.length; i++) {
    try {
      const d = await fetchUpickDetail(fx, BASE, ids[i])
      if (!d || !d.title) { console.log(`  ✗ ${ids[i]} detail/제목 파싱 실패`); await sleep(200); continue }
      if (cate != null) { d.cate_no = cate; d.cate_label = CATE_LABELS[cate] || null }
      if (!d.coupang_allowed) excluded++
      const flag = !d.coupang_allowed ? '🚫쿠팡금지' : (d.all_markets_ok ? '✅모든마켓' : '🟡일부')
      console.log(`  ${flag} ${d.product_no} ${(d.title || '').slice(0, 26).padEnd(26)} 회원가 ${d.member_price_krw || '-'} / MSP ${d.min_sell_price_krw || '-'}${d.tiered_msp ? '(수량별)' : ''} opt:${d.has_option ? d.options.length : 0} img:${d.images.length}`)
      if (!DRY && await saveUpickProduct(sb, d)) changed++
      total++
      await sleep(300)
    } catch (e) { console.log(`  ✗ ${ids[i]} ${e.message}`) }
  }
}
console.log(`\n=== 수집 ${total}건 (변동 ${changed} / 쿠팡금지 ${excluded}건 제외대상) ${DRY ? '[DRY — DB 미기록]' : ''} ===`)
