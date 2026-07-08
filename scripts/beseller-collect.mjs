/**
 * 비셀러(beseller.net, Makeshop 도매몰) 상품 수집 → jimscanner_beseller_products upsert.
 *   node --env-file=.env.local scripts/beseller-collect.mjs [--mcode=001,002] [--limit=N] [--skip-existing] [--dry]
 *
 * 구조(2026-07-08 정찰: _beseller-probe / _beseller-detail-probe2 / _beseller-list-probe):
 *  - 로그인: /shop/member.html?type=login, input[name=id]/[name=passwd] (Makeshop)
 *  - 갤러리: /shop/shopbrand.html?type=N&xcode=006&mcode=<001~008>&viewtype=gallery
 *    지연 로딩(수 초) + 더보기(#MS_product_more_btn_area) 클릭당 +100개 → 개수 안정까지 반복
 *  - 상세: /shop/shopdetail.html?branduid=<uid> — 정보가 .infos--row 라벨/값으로 구조화
 *    (구성·공급가·구매등급·발주 마감시간·배송비·상품코드·택배사·소비기한·원산지·제주/도서배송·출고지·반품지·공급사 닉네임 …)
 *  - 변형 그룹핑: 상품명에서 수량(*N)·무게/용량/수량 토큰 제거 → group_key (예: 해녀성게250g*3 → 해녀성게)
 *  - content_hash 로 변동만 last_changed_at 갱신 (upickb2b-collect 패턴)
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const BASE = 'https://beseller.net'
const DRY = process.argv.includes('--dry')
const SKIP_EXISTING = process.argv.includes('--skip-existing')
const MCODES = (process.argv.find(a => a.startsWith('--mcode='))?.split('=')[1] || '').split(',').map(s => s.trim()).filter(Boolean)
const LIMIT = +(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || 0)
const sleep = ms => new Promise(s => setTimeout(s, ms))

// ── 변형 그룹핑: 수량/무게 토큰 제거 → group_key, 제거 토큰 → variant_label ──
const VARIANT_RE = [
  /\*\s*\d+\s*(개|팩|병|포|봉|박스|세트|묶음)?/g,                                     // *3, *5개
  /\d+(?:\.\d+)?\s*(?:kg|g|ml|l|리터|L)(?:\s*내외)?/gi,                               // 250g, 1.5kg, 500ml
  // 10미, 30포, 2마리 … ※ JS \b 는 한글 뒤에서 무동작 → 명시적 경계 lookahead 사용
  /\d+\s*(?:미|마리|팩|포|입|개|병|봉|박스|캔|스틱|매|알|구|과|수|장|봉지|통|판|세트|묶음|box)(?=[\s(),*/\-~+.]|$)/gi,
]
function splitVariant(title) {
  let base = String(title || '')
  const tokens = []
  for (const re of VARIANT_RE) { base = base.replace(re, (m) => { tokens.push(m.trim()); return ' ' }) }
  base = base.replace(/[[\](){}·,~ـ\-_/+]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
  return { group_key: base || String(title || '').toLowerCase(), variant_label: tokens.join(' ') || null }
}

const won = s => { const m = /([\d,]{3,})\s*원/.exec(s || ''); return m ? parseInt(m[1].replace(/,/g, '')) : null }
const hashOf = d => crypto.createHash('sha256').update(JSON.stringify([d.supply_price, d.min_sell_price, d.status, d.composition, d.title, d.thumb_url, d.order_deadline])).digest('hex').slice(0, 16)

// ── 브라우저 ──
async function openBrowser() {
  let chromium
  try { ({ chromium } = await import('playwright')) } catch { ({ chromium } = await import('playwright-core')) }
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const ctx = await browser.newContext()
  ctx.on('dialog', (d) => { try { d.accept().catch(() => {}) } catch { /* noop */ } })
  return { browser, page: await ctx.newPage() }
}
async function login(page) {
  await page.goto(`${BASE}/shop/member.html?type=login`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.fill('input[name=id]', env.BESELLER_USER)
  await page.fill('input[name=passwd]', env.BESELLER_PASS)
  await Promise.all([
    page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
    page.evaluate(() => { const f = document.querySelector('input[name=passwd]')?.form; if (f) (f.requestSubmit ? f.requestSubmit() : f.submit()) }),
  ])
  await sleep(1500)
  if (!(await page.evaluate(() => /로그아웃/.test(document.body.innerHTML)))) throw new Error('beseller 로그인 실패')
}

// ── 갤러리: 카테고리 발견 + 더보기 전개 + branduid/품절 수집 ──
async function discoverCategories(page) {
  await page.goto(`${BASE}/shop/shopbrand.html?type=Y&xcode=006&viewtype=gallery`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await sleep(3500)
  return page.evaluate(() => {
    const seen = new Map()
    for (const a of document.querySelectorAll('a[href*="xcode=006"][href*="mcode="]')) {
      const href = a.getAttribute('href') || ''
      if (/scode=/.test(href)) continue
      const m = /mcode=(\d+)/.exec(href)
      const t = (a.innerText || '').replace(/\s+/g, ' ').trim()
      if (m && t && !seen.has(m[1])) seen.set(m[1], t)
    }
    return [...seen.entries()]
  })
}
const countUids = (page) => page.evaluate(() => new Set([...document.querySelectorAll('a[href*="shopdetail"][href*="branduid"]')].map(a => (/branduid=(\d+)/.exec(a.href) || [])[1]).filter(Boolean)).size)
// 더보기 전개 — 클릭 후 개수 성장을 폴링(최대 10초)으로 확인. 2회 연속 무성장 시 종료.
// (고정 2.2초 대기는 로딩보다 짧아 100개에서 조기종료되던 버그 수정 — 2026-07-08 수산물 584개 실측)
async function expandAll(page) {
  let stale = 0
  for (let i = 0; i < 120 && stale < 2; i++) {
    const before = await countUids(page)
    const clicked = await page.evaluate(() => {
      const btn = document.querySelector('#MS_product_more_btn_area a, #MS_product_more_btn_area button')
      if (btn && btn.offsetParent !== null) { btn.click(); return true }
      return false
    })
    if (!clicked) break
    let grew = false
    for (let w = 0; w < 20; w++) { await sleep(500); if (await countUids(page) > before) { grew = true; break } }
    stale = grew ? 0 : stale + 1
  }
}
async function listCategory(page, mcode) {
  await page.goto(`${BASE}/shop/shopbrand.html?type=N&xcode=006&mcode=${mcode}&viewtype=gallery`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await sleep(4000)
  await expandAll(page)
  // 카드 수집: shopimages 썸네일을 가진 상품 카드만(헤더/영상버튼 잡음 제외)
  return page.evaluate(() => {
    const out = new Map()
    for (const a of document.querySelectorAll('a[href*="shopdetail"][href*="branduid"]')) {
      const m = /branduid=(\d+)/.exec(a.href)
      if (!m) continue
      let card = a.closest('li, [class*="item"]')
      if (!card) card = a.parentElement
      const img = card?.querySelector('img[src*="shopimages"]')
      const prevEntry = out.get(m[1]) || { branduid: m[1], thumb: null, soldout: false }
      if (img && !prevEntry.thumb) prevEntry.thumb = img.src
      if (card && (/품절|sold\s*out/i.test(card.innerHTML) || card.querySelector('img[src*="soldout"], [class*="soldout"]'))) prevEntry.soldout = true
      out.set(m[1], prevEntry)
    }
    // 썸네일 없는 항목(네비 잔음 등) 제거
    return [...out.values()].filter(x => x.thumb)
  })
}

// ── 상세 파싱 ──
async function fetchDetail(page, uid) {
  await page.goto(`${BASE}/shop/shopdetail.html?branduid=${uid}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('[class*="infos--row"]', { timeout: 8000 }).catch(() => {})
  await sleep(800)
  return page.evaluate(() => {
    const d = {}
    const tm = /\[(.+)\]/.exec(document.title)
    d.title = (tm ? tm[1] : (document.querySelector('.goods--title, h3')?.innerText || '')).replace(/\s+/g, ' ').trim() || null
    // infos--row → 라벨:값 맵 (라벨 = 첫 자식 텍스트, 값 = 전체 - 라벨)
    const info = {}
    for (const row of document.querySelectorAll('[class*="infos--row"]')) {
      const whole = (row.innerText || '').replace(/\s+/g, ' ').trim()
      const label = (row.querySelector('[class*="tit"], [class*="label"], dt, th, strong')?.innerText || whole.split(' ')[0] || '').replace(/\s+/g, ' ').trim()
      if (!label || !whole) continue
      const value = whole.startsWith(label) ? whole.slice(label.length).trim() : whole
      if (label.length < 25 && value && !(label in info)) info[label] = value.slice(0, 500)
    }
    d.info = info
    // 썸네일: 대표이미지(_represent) 우선
    d.thumb = document.querySelector('img[src*="_represent"]')?.src || null
    // 상세설명 이미지: shopimages 중 대표/디자인 제외
    d.detailImgs = [...new Set([...document.querySelectorAll('img')].map(i => i.src)
      .filter(u => /shopimages\//.test(u) && !/_represent|\/design\//.test(u)))].slice(0, 30)
    // 품절: 구매 버튼 부재 or 품절 마커
    const buyBtn = [...document.querySelectorAll('a, button')].some(b => /구매하기|장바구니/.test((b.innerText || '').trim()))
    d.soldout = !buyBtn || /품절|일시\s*품절|SOLD\s*OUT/i.test(document.querySelector('.goods--options, [class*="option"]')?.innerText || '')
    return d
  })
}

// info 맵 → 컬럼 매핑 (라벨 변형 허용)
function mapInfo(info) {
  const pick = (...keys) => { for (const k of Object.keys(info)) { if (keys.some(p => k.replace(/\s/g, '').includes(p))) return info[k] } return null }
  const supplyRaw = pick('공급가')
  return {
    supply_price: won(supplyRaw),
    tax_note: supplyRaw ? ((/\(([^)]*세[^)]*)\)/.exec(supplyRaw) || [])[1] || null) : null,
    min_sell_price: won(pick('최저판매가', '최저판매')),
    composition: pick('구성'),
    order_deadline: pick('발주마감', '마감시간'),
    shipping_note: pick('배송비', '배송안내'),
    extra_ship_fee: pick('추가배송'),
    blocked_channels: pick('판매불가', '판매금지'),
    carrier: pick('택배사'),
    expiry_text: pick('소비기한', '유통기한'),
    origin: pick('원산지'),
    jeju_islands: pick('제주'),
    ship_from: pick('출고지'),
    return_to: pick('반품지'),
    supplier_nick: pick('공급사'),
    member_grade: pick('구매등급'),
    product_code: pick('상품코드'),
  }
}

// ── main ──
const { browser, page } = await openBrowser()
try {
  await login(page)
  console.log('✓ beseller 로그인')
  const cats = await discoverCategories(page)
  const targets = MCODES.length ? cats.filter(([m]) => MCODES.includes(m)) : cats
  console.log(`카테고리 ${targets.length}개: ${targets.map(([m, t]) => m + ':' + t).join(', ')}\n`)

  // 기존 branduid (skip-existing용)
  let existing = new Set()
  if (SKIP_EXISTING) {
    const { data } = await sb.from('jimscanner_beseller_products').select('branduid')
    existing = new Set((data || []).map(r => r.branduid))
    console.log(`기존 ${existing.size}건 — 상세 수집은 신규만\n`)
  }

  let total = 0, changed = 0, fail = 0
  for (const [mcode, label] of targets) {
    const cards = await listCategory(page, mcode)
    console.log(`[${mcode} ${label}] 목록 ${cards.length}개 (품절마크 ${cards.filter(c => c.soldout).length})`)
    let picked = cards
    if (LIMIT) picked = picked.slice(0, LIMIT)
    for (const c of picked) {
      if (SKIP_EXISTING && existing.has(c.branduid)) {
        if (!DRY) await sb.from('jimscanner_beseller_products').update({ last_seen_at: new Date().toISOString(), cate_mcode: mcode, cate_label: label, ...(c.soldout ? { status: 'soldout' } : {}) }).eq('branduid', c.branduid)
        continue
      }
      try {
        const det = await fetchDetail(page, c.branduid)
        if (!det.title) { console.log(`  ✗ ${c.branduid} 상품명 파싱 실패`); fail++; await sleep(400); continue }
        const g = splitVariant(det.title)
        const row = {
          branduid: c.branduid,
          title: det.title,
          group_key: g.group_key,
          variant_label: g.variant_label,
          cate_mcode: mcode,
          cate_label: label,
          ...mapInfo(det.info),
          thumb_url: det.thumb || c.thumb || null,
          detail_images: det.detailImgs,
          detail_url: `${BASE}/shop/shopdetail.html?branduid=${c.branduid}`,
          status: (c.soldout || det.soldout) ? 'soldout' : 'active',
          raw_info: det.info,
          last_seen_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
        row.content_hash = hashOf(row)
        console.log(`  ${row.status === 'soldout' ? '⛔' : '✓'} ${c.branduid} ${row.title.slice(0, 34).padEnd(34)} 공급 ${row.supply_price ?? '-'} | ${row.order_deadline ?? '-'} | 그룹 ${row.group_key.slice(0, 22)}`)
        if (!DRY) {
          const { data: ex } = await sb.from('jimscanner_beseller_products').select('content_hash').eq('branduid', c.branduid).maybeSingle()
          if (ex && ex.content_hash === row.content_hash) {
            await sb.from('jimscanner_beseller_products').update({ last_seen_at: row.last_seen_at, status: row.status, cate_mcode: mcode, cate_label: label }).eq('branduid', c.branduid)
          } else {
            const { error } = await sb.from('jimscanner_beseller_products').upsert({ ...row, last_changed_at: new Date().toISOString() }, { onConflict: 'branduid' })
            if (error) { console.log(`     upsert ERR: ${error.message}`); fail++; continue }
            changed++
          }
        }
        total++
        await sleep(700)
      } catch (e) { fail++; console.log(`  ✗ ${c.branduid} ${e.message}`) }
    }
  }
  console.log(`\n=== 수집 ${total}건 (변동 ${changed} / 실패 ${fail}) ${DRY ? '[DRY]' : ''} ===`)
} finally { await browser.close() }
