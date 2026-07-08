/**
 * 비셀러 품절 갱신 — 갤러리 목록 스캔으로 상품 status(active/soldout/gone) 갱신.
 * (upickb2b 카테고리 품절스캔 + ggsan 상세확인 하이브리드 — 기존 건기식 stock-sync 패턴 이식)
 *   node --env-file=.env.local scripts/beseller-stock-refresh.mjs [--detail-cap=30] [--dry]
 *
 * 판정:
 *  - 목록에 보임 + 품절마크 없음 → active
 *  - 목록에 보임 + 품절마크      → soldout
 *  - 목록에 안 보임              → 상세 확인(구매 버튼 유무, 상한 --detail-cap) → soldout | gone(페이지 없음)
 * run-crons.mjs 일일 스텝으로 실행.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const BASE = 'https://beseller.net'
const DRY = process.argv.includes('--dry')
const DETAIL_CAP = +(process.argv.find(a => a.startsWith('--detail-cap='))?.split('=')[1] || 30)
const sleep = ms => new Promise(s => setTimeout(s, ms))

async function openBrowser() {
  let chromium
  try { ({ chromium } = await import('playwright')) } catch { ({ chromium } = await import('playwright-core')) }
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const ctx = await browser.newContext()
  ctx.on('dialog', (d) => { try { d.accept().catch(() => {}) } catch { /* noop */ } })
  return { browser, page: await ctx.newPage() }
}

const MCODES = ['001', '002', '003', '004', '005', '006', '007', '008']

const { browser, page } = await openBrowser()
try {
  // 로그인
  await page.goto(`${BASE}/shop/member.html?type=login`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.fill('input[name=id]', env.BESELLER_USER)
  await page.fill('input[name=passwd]', env.BESELLER_PASS)
  await Promise.all([page.waitForNavigation({ timeout: 15000 }).catch(() => {}), page.evaluate(() => { const f = document.querySelector('input[name=passwd]')?.form; if (f) (f.requestSubmit ? f.requestSubmit() : f.submit()) })])
  await sleep(1500)
  if (!(await page.evaluate(() => /로그아웃/.test(document.body.innerHTML)))) throw new Error('beseller 로그인 실패')

  // 1) 전 카테고리 목록 스캔 → branduid → soldout 맵
  const seen = new Map()
  for (const mcode of MCODES) {
    await page.goto(`${BASE}/shop/shopbrand.html?type=N&xcode=006&mcode=${mcode}&viewtype=gallery`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(3500)
    // 더보기 전개 — 성장 폴링(고정 대기 조기종료 버그 수정판, beseller-collect.mjs 와 동일)
    const countUids = () => page.evaluate(() => new Set([...document.querySelectorAll('a[href*="shopdetail"][href*="branduid"]')].map(a => (/branduid=(\d+)/.exec(a.href) || [])[1]).filter(Boolean)).size)
    let stale = 0
    for (let i = 0; i < 120 && stale < 2; i++) {
      const before = await countUids()
      const clicked = await page.evaluate(() => { const b = document.querySelector('#MS_product_more_btn_area a, #MS_product_more_btn_area button'); if (b && b.offsetParent !== null) { b.click(); return true } return false })
      if (!clicked) break
      let grew = false
      for (let w = 0; w < 20; w++) { await sleep(500); if (await countUids() > before) { grew = true; break } }
      stale = grew ? 0 : stale + 1
    }
    const cards = await page.evaluate(() => {
      const out = []
      for (const a of document.querySelectorAll('a[href*="shopdetail"][href*="branduid"]')) {
        const m = /branduid=(\d+)/.exec(a.href)
        if (!m) continue
        const card = a.closest('li, [class*="item"]') || a.parentElement
        if (!card?.querySelector('img[src*="shopimages"]')) continue
        out.push({ uid: m[1], soldout: /품절|sold\s*out/i.test(card.innerHTML) || !!card.querySelector('img[src*="soldout"], [class*="soldout"]') })
      }
      return out
    })
    for (const c of cards) { if (!seen.has(c.uid) || c.soldout) seen.set(c.uid, c.soldout) }
    console.log(`[${mcode}] 목록 ${cards.length}개 스캔`)
  }
  console.log(`목록 총 ${seen.size}개 (품절마크 ${[...seen.values()].filter(Boolean).length})`)

  // 2) DB 대조 (Supabase 기본 1,000행 캡 → 페이징 전량)
  const db = []
  for (let off = 0; off < 50000; off += 1000) {
    const { data: chunk } = await sb.from('jimscanner_beseller_products').select('branduid, status').range(off, off + 999)
    db.push(...(chunk ?? []))
    if ((chunk ?? []).length < 1000) break
  }
  const now = new Date().toISOString()
  let toGone = 0
  const missing = [], mkActive = [], mkSoldout = [], touch = []
  for (const r of db) {
    if (!seen.has(r.branduid)) { missing.push(r); continue }
    const next = seen.get(r.branduid) ? 'soldout' : 'active'
    if (r.status !== next) (next === 'active' ? mkActive : mkSoldout).push(r.branduid)
    else touch.push(r.branduid)
  }
  // 배치 업데이트 (행별 개별 update는 4천건에서 수 분 소요 → 200개 단위 .in())
  const batchUpdate = async (uids, patch) => {
    for (let i = 0; i < uids.length; i += 200) {
      if (!DRY) await sb.from('jimscanner_beseller_products').update(patch).in('branduid', uids.slice(i, i + 200))
    }
  }
  await batchUpdate(mkActive, { status: 'active', soldout_checked_at: now, last_seen_at: now, updated_at: now })
  await batchUpdate(mkSoldout, { status: 'soldout', soldout_checked_at: now, last_seen_at: now, updated_at: now })
  await batchUpdate(touch, { soldout_checked_at: now, last_seen_at: now })
  const toActive = mkActive.length, toSoldout = mkSoldout.length, unchanged = touch.length

  // 3) 목록 미노출분 → 상세 확인(상한) — 구매버튼 없으면 soldout, 페이지 자체가 없으면 gone
  let detailChecked = 0
  for (const r of missing.slice(0, DETAIL_CAP)) {
    try {
      await page.goto(`${BASE}/shop/shopdetail.html?branduid=${r.branduid}`, { waitUntil: 'domcontentloaded', timeout: 20000 })
      await sleep(1200)
      const st = await page.evaluate(() => {
        const has = (document.body.innerText || '').length > 200
        if (!has) return 'gone'
        const buy = [...document.querySelectorAll('a, button')].some(b => /구매하기|장바구니/.test((b.innerText || '').trim()))
        return buy ? 'active' : 'soldout'
      })
      if (st !== r.status && !DRY) await sb.from('jimscanner_beseller_products').update({ status: st, soldout_checked_at: now, updated_at: now }).eq('branduid', r.branduid)
      if (st === 'gone') toGone++
      else if (st === 'soldout' && r.status !== 'soldout') toSoldout++
      detailChecked++
      await sleep(600)
    } catch { /* 다음 런에서 재확인 */ }
  }

  console.log(`\n=== ${DRY ? 'DRY' : '갱신'} === active↑${toActive} soldout↑${toSoldout} gone↑${toGone} 유지 ${unchanged} | 미노출 ${missing.length}(상세확인 ${detailChecked}/${DETAIL_CAP})`)
} finally { await browser.close() }
