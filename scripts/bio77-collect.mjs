/**
 * 77bio.co.kr(건기식 B2B 도매몰) 상품 수집 → jimscanner_bio77_products upsert.
 *   node --env-file=.env.local scripts/bio77-collect.mjs [--skip-xlsm] [--dry]
 *
 * 구조(2026-09-01 정찰):
 *  - 공개 CSV(로그인 불필요): 구글시트 export — 상품코드/상품명/바코드/소비기한/상태/브랜드/도매가/소비자가(MSP)/준수여부
 *    https://docs.google.com/spreadsheets/d/1wmmtveYYFRqo7A-rm6tpDKTO-7R24RLUXC6bsRGZWag/export?format=csv&gid=0
 *  - 쿠팡용 XLSM(로그인 필요, Playwright): "⭐상품 대량(엑셀)등록→쿠팡" 페이지에서 다운로드 버튼 클릭
 *    → Google Apps Script + AI가 쿠팡 표준 카테고리코드/재고/옵션/검색어/이미지/상세설명을 채운 Wing 공식 대량등록 양식(.xlsm) 생성
 *    → 쿠팡판매불가 상품은 이 파일에서 이미 자동 제외됨 (CSV만으론 알 수 없는 정보라 XLSM이 "쿠팡판매가능" 허용목록 역할)
 *    → 로그인 폼은 secretKey/encryptFl 기반 JS 암호화라 반드시 실제 폼 제출(Playwright)로 처리, raw POST 재현 금지
 *  - 병합: CSV(도매가/MSP/바코드/소비기한/브랜드) × XLSM(coupang_category_code/재고/옵션/검색어/이미지/상세HTML)
 *    on 상품코드(goods_no). XLSM에 없는 상품 = coupang_sellable=false
 *  - content_hash로 변동만 last_changed_at 갱신 (beseller-collect.mjs 패턴)
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import XLSX from 'xlsx'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'BIO77_USER', 'BIO77_PASS']) {
  if (!env[key]) throw new Error(`.env.local에 ${key} 없음`)
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const BASE = env.BIO77_BASE_URL || 'https://77bio.co.kr'
const CSV_URL = 'https://docs.google.com/spreadsheets/d/1wmmtveYYFRqo7A-rm6tpDKTO-7R24RLUXC6bsRGZWag/export?format=csv&gid=0'
const DRY = process.argv.includes('--dry')
const SKIP_XLSM = process.argv.includes('--skip-xlsm')
const sleep = ms => new Promise(s => setTimeout(s, ms))

// ── CSV 파서 (따옴표 필드 내 콤마/개행 처리) ──
function parseCSV(text) {
  const rows = []; let row = []; let field = ''; let inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else inQ = false }
      else field += c
    } else {
      if (c === '"') inQ = true
      else if (c === ',') { row.push(field); field = '' }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
      else if (c === '\r') { /* skip */ }
      else field += c
    }
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows
}
const won = s => { const n = parseInt(String(s || '').replace(/[^\d]/g, ''), 10); return Number.isFinite(n) ? n : null }

// 컬럼 순서가 바뀌면(시트 스키마 드리프트) 엉뚱한 필드에 매핑되는 대신 즉시 실패시킨다.
const CSV_EXPECTED_HEADERS = ['상품코드', '사진', '상품명', '바코드', '소비기한', '상태', '브랜드', '도매', '소비자가격', '준수', 'LINK']
async function fetchCsvRows() {
  const res = await fetch(CSV_URL)
  if (!res.ok) throw new Error(`CSV fetch 실패: HTTP ${res.status}`)
  const text = await res.text()
  const allRows = parseCSV(text)
  const header = (allRows[0] || []).map(h => String(h || '').replace(/\s+/g, ''))
  CSV_EXPECTED_HEADERS.forEach((expected, i) => {
    if (!header[i]?.includes(expected)) throw new Error(`77bio CSV 헤더 변경 감지: 컬럼${i} 기대="${expected}" 실제="${header[i]}" — 컬럼 인덱스 매핑을 다시 확인할 것`)
  })
  const rows = allRows.filter(r => r.length > 1 && r[0] && /^\d+$/.test(r[0].trim()))
  return rows.map(r => ({
    goods_no: r[0].trim(),
    title: (r[2] || '').trim(),
    barcode: (r[3] || '').trim() || null,
    expiry_text: (r[4] || '').trim() || null,
    status: (r[5] || '').trim() || 'unknown',
    brand: (r[6] || '').trim() || null,
    dome_price_krw: won(r[7]),
    msp_price_krw: won(r[8]),
    msp_enforced: /준수해주세요/.test(r[9] || ''),
  }))
}

// ── XLSM: 로그인 + 다운로드 버튼 클릭 + 파싱 ──
async function openBrowser() {
  let chromium
  try { ({ chromium } = await import('playwright')) } catch { ({ chromium } = await import('playwright-core')) }
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const ctx = await browser.newContext({ acceptDownloads: true })
  return { browser, page: await ctx.newPage() }
}
async function login(page) {
  await page.goto(`${BASE}/member/login.php`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.fill('#loginId', env.BIO77_USER)
  await page.fill('#loginPwd', env.BIO77_PASS)
  await Promise.all([
    page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
    page.click('#formLogin button[type=submit], #formLogin button'),
  ])
  await sleep(1000)
  if (!(await page.evaluate(() => /로그아웃/.test(document.body.innerHTML)))) throw new Error('77bio 로그인 실패')
}
async function downloadCoupangXlsm(page, outPath) {
  await page.goto(`${BASE}/main/html.php?htmid=proc/productBulkRegisterCoupang.html`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await sleep(1000)
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 180000 }), // AI 검색어 생성 포함 최대 3분 대기
    page.getByRole('button', { name: /쿠팡용 엑셀파일 다운로드/ }).click(),
  ])
  await download.saveAs(outPath)
}
// 쿠팡 Wing 공식 대량등록 양식 컬럼 인덱스. 양식 버전(Ver.4.6 기준)이 바뀌면 즉시 실패시킨다.
const XLSM_EXPECTED_HEADERS = { 0: '카테고리', 8: '검색어', 61: '판매가격', 64: '재고수량', 72: '업체상품코드', 103: '대표', 109: '상세' }
function parseXlsm(filePath) {
  const wb = XLSX.readFile(filePath)
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
  // 쿠팡 Wing 양식 구조: row0=그룹라벨(기본정보/구매옵션 등), row1=실제 컬럼헤더, row2=필수여부, row3=안내문, row4~=데이터
  const header = rows[1] || []
  for (const [idx, expected] of Object.entries(XLSM_EXPECTED_HEADERS)) {
    if (!String(header[idx] || '').includes(expected)) throw new Error(`77bio 쿠팡 XLSM 양식 변경 감지: 컬럼${idx} 기대="${expected}" 실제="${header[idx]}" — 컬럼 인덱스 매핑을 다시 확인할 것`)
  }
  const out = new Map()
  for (let i = 4; i < rows.length; i++) {
    const r = rows[i]
    const goodsNo = String(r[72] || '').trim()
    if (!/^\d+$/.test(goodsNo)) continue
    const catMatch = /^\[(\d+)\]\s*(.+)$/.exec(String(r[0] || '').trim())
    const options = []
    for (let o = 9; o <= 60; o += 2) {
      const type = String(r[o] || '').trim()
      const value = String(r[o + 1] || '').trim()
      if (type && value) options.push({ type, value })
    }
    out.set(goodsNo, {
      coupang_category_code: catMatch ? parseInt(catMatch[1], 10) : null,
      coupang_category_name: catMatch ? catMatch[2] : null,
      stock_qty: Number.isFinite(+r[64]) ? +r[64] : null,
      options,
      search_keywords: String(r[8] || '').trim() || null,
      thumb_url: String(r[103] || '').trim() || null,
      detail_html: String(r[109] || '').trim() || null,
    })
  }
  return out
}

const hashOf = d => crypto.createHash('sha256').update(JSON.stringify([d.dome_price_krw, d.msp_price_krw, d.status, d.stock_qty, d.title, d.coupang_category_code, d.thumb_url])).digest('hex').slice(0, 16)

// ── main ──
const csvRows = await fetchCsvRows()
console.log(`✓ CSV 수집: ${csvRows.length}건 (상태 정상 ${csvRows.filter(r => r.status === '정상').length}건)`)

let xlsmMap = new Map()
if (!SKIP_XLSM) {
  const { browser, page } = await openBrowser()
  try {
    await login(page)
    console.log('✓ 77bio 로그인')
    const outPath = path.join(__dirname, '..', '.playwright-mcp', `bio77-coupang-${Date.now()}.xlsm`)
    console.log('  쿠팡용 엑셀 생성 중 (AI 검색어 추출 — 최대 3분 소요)...')
    await downloadCoupangXlsm(page, outPath)
    xlsmMap = parseXlsm(outPath)
    console.log(`✓ XLSM 파싱: ${xlsmMap.size}건 (쿠팡판매가능 = 이 목록에 있는 것만)`)
  } finally {
    await browser.close()
  }
} else {
  console.log('⚠ --skip-xlsm: 쿠팡 카테고리/이미지/상세 없이 CSV만 반영 (coupang_sellable 모두 false)')
}

let total = 0, changed = 0, sellable = 0
for (const csvRow of csvRows) {
  const xlsm = xlsmMap.get(csvRow.goods_no)
  const row = {
    ...csvRow,
    coupang_sellable: !!xlsm,
    coupang_category_code: xlsm?.coupang_category_code ?? null,
    coupang_category_name: xlsm?.coupang_category_name ?? null,
    stock_qty: xlsm?.stock_qty ?? null,
    options: xlsm?.options ?? null,
    search_keywords: xlsm?.search_keywords ?? null,
    thumb_url: xlsm?.thumb_url ?? null,
    detail_html: xlsm?.detail_html ?? null,
    detail_url: `${BASE}/goods/goods_view.php?goodsNo=${csvRow.goods_no}`,
    raw_payload: { csv: csvRow, xlsm: xlsm ?? null },
    last_seen_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  row.content_hash = hashOf(row)
  if (row.coupang_sellable) sellable++
  console.log(`  ${row.coupang_sellable ? '✓' : '·'} ${row.goods_no} ${row.title.slice(0, 30).padEnd(30)} 도매${row.dome_price_krw ?? '-'} MSP${row.msp_price_krw ?? '-'} ${row.status} ${row.coupang_category_code ? `[${row.coupang_category_code}]` : ''}`)
  if (!DRY) {
    const { data: ex } = await sb.from('jimscanner_bio77_products').select('content_hash').eq('goods_no', row.goods_no).maybeSingle()
    if (ex && ex.content_hash === row.content_hash) {
      await sb.from('jimscanner_bio77_products').update({ last_seen_at: row.last_seen_at }).eq('goods_no', row.goods_no)
    } else {
      const { error } = await sb.from('jimscanner_bio77_products').upsert({ ...row, last_changed_at: new Date().toISOString() }, { onConflict: 'goods_no' })
      if (error) { console.log(`     upsert ERR: ${error.message}`); continue }
      changed++
    }
  }
  total++
}
console.log(`\n=== 수집 ${total}건 (변동 ${changed} / 쿠팡판매가능 ${sellable}) ${DRY ? '[DRY]' : ''} ===`)
