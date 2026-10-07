/**
 * 화장품스토리(cmtstory.com — 주식회사 건강산 화장품 서브몰, 고도몰5) 상품 수집 → jimscanner_cmtstory_products
 *   node scripts/cmtstory-collect.mjs [--dry] [--only=1000001277,…] [--limit=N] [--cats=001,002] [--verbose] [--concurrency=3] [--min-margin=0.10]
 * 설계: docs/plan-cmtstory.md §3 · 기준 코드: kwholesale-collect.mjs(수집 흐름·판매가 계산) + lib/godomall-catalog.mjs(고도몰 파서)
 *
 * - 로그인은 건강산 계정(GGSAN_USER/GGSAN_PASS) — 같은 운영사라 회원이 공유된다(2026-10-07 실측). CMTSTORY_USER/PASS 가 있으면 그걸 우선.
 * - 수집 범위: 국내 판매 카테고리 001~008 만. 009 오프라인전용 · 010 사은품 · 011 임박특가 · 014 수출전용(605건)은 URL 단계에서 제외.
 * - 판매가(사용자 결정 2026-10-07): sale_prices[N] = max(절대준수가 MSP(N), 순마진 10% 가격). 절대준수 문구가 없으면 하한 없음(정가는 참고값).
 *   순마진가 = ceil(0.9091×원가/(1−수수료−0.0909−m)/100)×100, 원가 = 도매가×N + 배송비(3,000 · 도매가 합 20만 이상 0).
 *   수수료 = 화장품 9.6%(lib/coupang-commission.mjs). 상품명이 뷰티 키워드에 안 걸려 기본값(10.8%)이 나오면 뷰티 기본 9.6% 로 둔다(전 상품 화장품).
 * - 품절 = 리스트 li.item_soldout ∨ 상세 구매영역 마커. 리스트에서 사라진 상품은 status='gone'.
 * - 사람이 정한 register_excluded / needs_review / 쿠팡 카테고리 캐시는 수집기가 덮어쓰지 않는다.
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { makeSession, mallLogin, listCategory, parseGoodsView } from './lib/godomall-catalog.mjs'
import { commissionRate } from './lib/coupang-commission.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const BASE = (env.CMTSTORY_BASE_URL || 'https://www.cmtstory.com').replace(/\/+$/, '')
const CREDS = { base: BASE, user: env.CMTSTORY_USER || env.GGSAN_USER, pass: env.CMTSTORY_PASS || env.GGSAN_PASS, label: '화장품스토리' }
const TABLE = 'jimscanner_cmtstory_products'
const DOMESTIC_CATES = ['001', '002', '003', '004', '005', '006', '007', '008']   // 토너/세럼 · 마스크/팩 · 바디/헤어 · 크림 · 선케어 · 맨즈 · 클렌징 · 홈/프래그런스
const SHIP = 3000, FREE_SHIP = 200000
const BEAUTY_FEE = 0.096, FEE_DEFAULT = 0.108   // coupang-commission 의 미매칭 기본값(10.8%) → 뷰티 9.6% 로 치환
const EXPIRY_MIN_DAYS = 180

const argv = process.argv.slice(2)
const arg = k => argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')
const DRY = argv.includes('--dry')
const VERBOSE = argv.includes('--verbose')
const ONLY = new Set((arg('only') || '').split(',').map(s => s.trim()).filter(s => /^\d{1,12}$/.test(s)))
const LIMIT = +(arg('limit') || 0)
const CONC = Math.max(1, +(arg('concurrency') || 3))
const CATES = (arg('cats') || DOMESTIC_CATES.join(',')).split(',').map(s => s.trim()).filter(s => /^\d{3,9}$/.test(s))
const TARGET_NET = +(arg('min-margin') ?? 0.10)
const FULL_RUN = !ONLY.size && !LIMIT && CATES.length === DOMESTIC_CATES.length
const sleep = ms => new Promise(s => setTimeout(s, ms))
const ceil100 = n => Math.ceil(n / 100) * 100
const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)

// ── 판매가: max(MSP(N), 순마진가(N)) ──
function salePriceFor(row, n) {
  const dome = (row.wholesale_price_krw || 0) * n
  if (!dome) return null
  const ship = dome >= (row.free_ship_threshold_krw || FREE_SHIP) ? 0 : (row.shipping_fee_krw ?? SHIP)
  const cost = dome + ship
  const fee = row.coupang_fee_rate
  const msp = row.tiered_msp?.[n] ?? (row.msp_price_krw ? row.msp_price_krw * n : 0)
  const marginPrice = ceil100(0.9091 * cost / (1 - fee - 0.0909 - TARGET_NET))
  const price = ceil100(Math.max(msp, marginPrice))
  const feeKrw = Math.round(price * fee)
  const vat = Math.max(0, Math.round((price - cost) / 11))
  const margin = price - cost - feeKrw - vat
  return { price, basis: msp >= marginPrice ? 'msp' : 'margin', msp: msp || null, marginPrice, margin, pct: +(margin / price * 100).toFixed(2), ship }
}
function applySalePrices(row) {
  const p = { 1: salePriceFor(row, 1), 2: salePriceFor(row, 2), 3: salePriceFor(row, 3) }
  row.sale_prices = p[1] ? p : null
  row.sale_price_krw = p[1]?.price ?? null
  row.sale_price_basis = p[1]?.basis ?? null
  row.sale_margin_krw = p[1]?.margin ?? null
  row.sale_margin_pct = p[1]?.pct ?? null
}
function exclusionReason(row, ex) {
  return ex?.register_excluded ? `사람 제외(${ex.register_excluded_reason || '-'})`
    : ex?.needs_review ? '확인 필요(needs_review)'
      : row.closed_mall ? '오픈마켓 금지 문구'
        : row.soldout ? '품절'
          : row.has_option ? '옵션 상품(옵션조합 미구현)'
            : !row.wholesale_price_krw ? '도매가 없음'
              : row.expiry_short ? `사용기한 임박(${row.expiry_date})` : null
}
const hashOf = d => sha(JSON.stringify([d.title, d.cate_cd, d.cate_cds, d.wholesale_price_krw, d.fixed_price_krw, d.msp_price_krw, d.tiered_msp, d.closed_mall, d.has_option, d.soldout, d.manufacturer, d.expiry_date, d.thumb_url, d.images_main, d.images_content, d.shipping_fee_krw, d.free_ship_threshold_krw]))

// ① 로그인
const session = makeSession()
await mallLogin(session, CREDS)
console.log(`✓ 로그인 ${BASE} (${CREDS.user})`)

// ② 카테고리 리스트 → goodsNo 합집합(+품절·소속 카테고리)
const listed = new Map()   // goods_no → { soldout, cates:Set }
let listedTotal = 0
for (const cd of CATES) {
  const { items, total } = await listCategory(session, BASE, cd)
  listedTotal += total ?? items.size
  for (const [no, v] of items) {
    const cur = listed.get(no) ?? { soldout: false, cates: new Set() }
    cur.soldout = cur.soldout || v.soldout; cur.cates.add(cd); listed.set(no, cur)
  }
  console.log(`  [${cd}] 리스트 ${items.size}건${total != null && total !== items.size ? ` (표기 총 ${total} — 불일치!)` : ''} · 품절 ${[...items.values()].filter(v => v.soldout).length}`)
  await sleep(300)
}
console.log(`리스트 합계 ${listedTotal}(중복 포함) → 고유 ${listed.size}건`)
const ids = ONLY.size ? [...ONLY] : [...listed.keys()].slice(0, LIMIT || undefined)

// ③ 기존 행(사람 결정 보존 + 변경 감지)
const existing = new Map()
if (!DRY) {
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb.from(TABLE).select('goods_no, content_hash, register_excluded, register_excluded_reason, needs_review').range(off, off + 999)
    if (error) throw new Error(`기존행 조회 실패: ${error.message} (supabase/cmtstory_products.sql 적용 여부 확인)`)
    for (const r of data) existing.set(r.goods_no, r)
    if (data.length < 1000) break
  }
}

// ④ 상세
const today = new Date(new Date().toISOString().slice(0, 10))
async function fetchDetail(no) {
  const r = await session.fx(`${BASE}/goods/goods_view.php?goodsNo=${no}`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const html = await r.text()
  const d = parseGoodsView(html)
  if (!d.goods_no) throw new Error('goodsNo 파싱 실패(삭제·비공개?)')
  if (d.goods_no !== String(no)) throw new Error(`goodsNo 불일치 ${d.goods_no}`)
  const l = listed.get(String(no))
  d.detail_url = `${BASE}/goods/goods_view.php?goodsNo=${no}`
  d.title_clean = (d.title || '').replace(/\s+/g, ' ').trim()
  d.cate_cds = l ? [...l.cates].sort() : (d.cate_cd ? [d.cate_cd] : [])
  d.soldout = d.soldout || !!l?.soldout
  d.status = d.soldout ? 'soldout' : 'active'
  d.shipping_fee_krw = d.shipping_fee_krw ?? SHIP
  d.free_ship_threshold_krw = d.free_ship_threshold_krw ?? FREE_SHIP
  d.expiry_short = !!d.expiry_date && (new Date(d.expiry_date) - today) / 864e5 < EXPIRY_MIN_DAYS
  // 전 상품 화장품(뷰티 9.6%). commissionRate 는 '콜라겐'·'비타민' 같은 성분명을 영양제(7.6%)로 오인하므로 참고만 한다.
  const guessed = commissionRate(d.title); d.coupang_fee_rate = guessed === FEE_DEFAULT || guessed < BEAUTY_FEE ? BEAUTY_FEE : guessed
  applySalePrices(d)
  delete d.purchasable
  return d
}
const results = []
let cursor = 0
await Promise.all(Array.from({ length: CONC }, async () => {
  while (cursor < ids.length) {
    const no = ids[cursor++]
    try { results.push(await fetchDetail(no)) } catch (e) { results.push({ goods_no: String(no), err: e.message }) }
    if (results.length % 50 === 0) console.log(`  … ${results.length}/${ids.length}`)
    await sleep(250)
  }
}))
const ok = results.filter(r => !r.err)
const errs = results.filter(r => r.err)
const priceMissing = ok.filter(r => !r.wholesale_price_krw).length
if (ok.length >= 10 && priceMissing / ok.length > 0.1) { console.error(`✗ 도매가 누락 ${priceMissing}/${ok.length} — 로그인 세션/회원등급 문제 의심, 저장 중단`); process.exit(1) }
for (const d of ok) d.excluded_reason = exclusionReason(d, existing.get(d.goods_no))

// ⑤ 저장
let changed = 0, unchanged = 0, failed = 0
for (const d of ok) {
  d.content_hash = hashOf(d)
  if (VERBOSE || ids.length <= 30) {
    const p = d.sale_prices?.[1]
    console.log(`  ${d.excluded_reason ? '⛔' : '✅'} ${d.goods_no} ${d.title_clean.slice(0, 30).padEnd(30)} 도매 ${String(d.wholesale_price_krw ?? '-').padStart(6)} 정가 ${String(d.fixed_price_krw ?? '-').padStart(6)} MSP ${d.has_msp_text ? JSON.stringify(d.tiered_msp) : '없음'} → 판매 ${p?.price ?? '-'}(${p?.basis ?? '-'}, 마진 ${p?.margin ?? '-'}/${p?.pct ?? '-'}%) | 사용기한 ${d.expiry_date ?? '-'} | 상세img ${d.images_content.length}${d.excluded_reason ? ' · ' + d.excluded_reason : ''}`)
  }
  if (DRY) continue
  const now = new Date().toISOString()
  const ex = existing.get(d.goods_no)
  if (ex && ex.content_hash === d.content_hash) {
    const { error } = await sb.from(TABLE).update({ last_seen_at: now, status: d.status, soldout: d.soldout, expiry_short: d.expiry_short, excluded_reason: d.excluded_reason, coupang_fee_rate: d.coupang_fee_rate, sale_price_krw: d.sale_price_krw, sale_price_basis: d.sale_price_basis, sale_margin_krw: d.sale_margin_krw, sale_margin_pct: d.sale_margin_pct, sale_prices: d.sale_prices }).eq('goods_no', d.goods_no)
    if (error) { failed++; console.log(`  ✗ update ${d.goods_no} ${error.message}`) } else unchanged++
  } else {
    const { error } = await sb.from(TABLE).upsert({ ...d, last_seen_at: now, last_changed_at: now, updated_at: now }, { onConflict: 'goods_no' })
    if (error) { failed++; console.log(`  ✗ upsert ${d.goods_no} ${error.message}`) } else changed++
  }
}
let gone = 0
if (FULL_RUN && !DRY && listed.size > 50) {
  const { data, error } = await sb.from(TABLE).update({ status: 'gone', excluded_reason: '리스트에서 사라짐', updated_at: new Date().toISOString() }).not('goods_no', 'in', `(${[...listed.keys()].join(',')})`).neq('status', 'gone').select('goods_no')
  if (error) console.log(`  ✗ gone 처리 실패 ${error.message}`); else gone = data.length
}

// ⑥ 리포트
const cnt = (arr, f) => arr.reduce((o, r) => { const k = f(r); o[k] = (o[k] || 0) + 1; return o }, {})
const eligible = ok.filter(d => !d.excluded_reason)
const q = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] }
const margins = eligible.map(d => d.sale_margin_krw).filter(n => n != null)
console.log(`\n=== 상세 ${ok.length}건 (실패 ${errs.length}) · 등록 후보 ${eligible.length} · 제외 ${ok.length - eligible.length} ===`)
if (errs.length) console.log('실패:', errs.slice(0, 10).map(e => `${e.goods_no}(${e.err})`).join(', '))
console.log('제외 사유:', JSON.stringify(cnt(ok.filter(d => d.excluded_reason), d => d.excluded_reason.replace(/\(.*\)/, ''))))
console.log(`후보: 절대준수 문구 ${eligible.filter(d => d.has_msp_text).length}(수량별 ${eligible.filter(d => Object.keys(d.tiered_msp || {}).length > 1).length}) · 문구 없음(마진가) ${eligible.filter(d => !d.has_msp_text).length} · 판매가 기준 ${JSON.stringify(cnt(eligible, d => d.sale_price_basis))} · 수수료 ${JSON.stringify(cnt(eligible, d => d.coupang_fee_rate))}`)
console.log(`후보 1개 마진: 중앙 ${q(margins, 0.5)}원 · P25 ${q(margins, 0.25)}원 · 3천원 미만 ${margins.filter(m => m < 3000).length} · 음수 ${margins.filter(m => m < 0).length} | 사용기한 있음 ${eligible.filter(d => d.expiry_date).length} · 상세이미지 0장 ${eligible.filter(d => !d.images_content.length).length} · 제조사 있음 ${eligible.filter(d => d.manufacturer).length}`)
if (!DRY) console.log(`저장: 변경 ${changed} · 동일 ${unchanged} · 실패 ${failed} · 사라짐(gone) ${gone}`)
else console.log('[DRY-RUN] 저장 안 함 — 실제 저장은 --dry 없이')
